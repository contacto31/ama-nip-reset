const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const { z } = require("zod");
const { pool } = require("./db");

const app = express();

// Importante en VPS con reverse proxy (EasyPanel)
app.set("trust proxy", 1);

// Seguridad HTTP headers
app.use(helmet());

// Body pequeño para evitar abuso
app.use(express.json({ limit: "10kb" }));

// Rate limit global (suave) para todo el servicio
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

/**
 * Health checks (SIN CORS estricto)
 */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "ama-reset-nip-api" });
});

app.get("/api/db-health", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 AS ok");
    res.json({ ok: true, db: r.rows[0].ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, db: false });
  }
});

/**
 * CORS ESTRICTO SOLO PARA /nip-reset/*
 * - Requiere Origin
 * - Origin debe estar en ALLOWED_ORIGINS
 */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsForNipReset = cors({
  origin: function (origin, cb) {
    // Si no viene Origin (curl/postman/script), se rechaza
    if (!origin) return cb(new Error("CORS: Origin requerido"));

    // Si no configuraste ALLOWED_ORIGINS, se rechaza por seguridad
    if (allowedOrigins.length === 0) return cb(new Error("CORS: Sin allowlist"));

    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("CORS: Origin no permitido"));
  },
  methods: ["POST", "OPTIONS"],
});

app.use("/nip-reset", corsForNipReset);

// Handler de errores CORS (devuelve 403)
app.use((err, req, res, next) => {
  if (String(err?.message || "").startsWith("CORS:")) {
    return res.status(403).json({ ok: false, message: "Forbidden" });
  }
  next(err);
});

/**
 * Validación de payload
 */
const nipResetRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().regex(/^\d{10}$/, "Teléfono debe ser de 10 dígitos"),
});

/**
 * Rate limit por IP específico para /nip-reset/request
 * (mientras está en pruebas: max 3 por 15 min; ajustable por env)
 */
const nipResetLimiter = rateLimit({
  windowMs: Number(process.env.NIP_RESET_IP_RATE_WINDOW_MINUTES || 15) * 60 * 1000,
  max: Number(process.env.NIP_RESET_IP_RATE_MAX || 3),
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Rate limit adicional por "customer_ref" (email+tel hasheado)
 * Evita abuso aunque roten IPs.
 *
 * Por defecto: 2 solicitudes por customer_ref por 60 minutos
 * (ajustable por env)
 */
async function isCustomerRefRateLimited(customerRef) {
  const windowMinutes = Number(process.env.CUSTOMER_REF_RATE_WINDOW_MINUTES || 60);
  const maxPerWindow = Number(process.env.CUSTOMER_REF_RATE_MAX || 2);

  const q = `
    SELECT COUNT(*)::int AS c
    FROM nip_reset_tokens
    WHERE customer_ref = $1
      AND created_at > now() - ($2 * interval '1 minute')
  `;

  const { rows } = await pool.query(q, [customerRef, windowMinutes]);
  return (rows?.[0]?.c || 0) >= maxPerWindow;
}

app.post("/nip-reset/request", nipResetLimiter, async (req, res) => {
  // Respuesta SIEMPRE genérica (anti-enumeración)
  const genericResponse = {
    ok: true,
    message:
      "Listo. Si los datos coinciden con un registro, recibirás un correo con la liga para restablecer tu NIP.",
  };

  // 1) Validación de formato (400 si viene mal)
  const parsed = nipResetRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      message: "Datos inválidos. Revisa correo y teléfono.",
      errors: parsed.error.issues.map((i) => ({
        field: i.path.join("."),
        msg: i.message,
      })),
    });
  }

  const { email, phone } = parsed.data;

  // 2) TTL (minutos) con default 60 (en pruebas puedes poner 15)
  const ttlMinutes = Number(process.env.RESET_TOKEN_TTL_MINUTES || 60);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

  // 3) customer_ref sin PII: hash(email|phone)
  const customerRef = crypto
    .createHash("sha256")
    .update(`${email}|${phone}`)
    .digest("hex");

  try {
    // 3.1) Rate limit por customer_ref (si excede, no generamos token)
    const limited = await isCustomerRefRateLimited(customerRef);
    if (limited) {
      return res.status(200).json(genericResponse);
    }

    // 4) Token fuerte (NO se guarda en claro)
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    // 5) Invalida tokens previos activos para esa llave (one-active-token policy)
    await pool.query(
      "UPDATE nip_reset_tokens SET used_at = now() WHERE customer_ref=$1 AND used_at IS NULL",
      [customerRef]
    );

    // 6) Inserta token hash
    await pool.query(
      `INSERT INTO nip_reset_tokens (customer_ref, token_hash, expires_at, request_ip, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [customerRef, tokenHash, expiresAt, req.ip || null, req.get("user-agent") || null]
    );

    // Nota: NO devolvemos token. Mañana: Airtable + correo.
    return res.status(200).json(genericResponse);
  } catch (e) {
    // No revelar detalles al cliente; log mínimo interno
    console.error("nip-reset/request error:", e?.message || e);
    return res.status(200).json(genericResponse);
  }
});

// Error handler final (genérico)
app.use((err, req, res, next) => {
  res.status(500).json({ ok: false });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`ama-reset-nip-api listening on port ${port}`);
});