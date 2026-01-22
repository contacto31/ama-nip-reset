const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { pool } = require("./db");
const crypto = require("crypto");
const { z } = require("zod");

const app = express();

// Importante en VPS con proxy/reverse-proxy (EasyPanel)
app.set("trust proxy", 1);

// Seguridad HTTP headers
app.use(helmet());

// Body pequeño para evitar abuso
app.use(express.json({ limit: "10kb" }));

// CORS restringido
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, cb) {
    // Permite calls server-to-server sin Origin (por ejemplo Postman)
    if (!origin) return cb(null, true);
    if (allowedOrigins.length === 0) return cb(null, false);
    return cb(null, allowedOrigins.includes(origin));
  },
  methods: ["GET", "POST"],
}));

// Rate limit global (suave)
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
}));

// Health check (sin DB)
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "ama-reset-nip-api" });
});

// Health check con DB (prueba real)
app.get("/api/db-health", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 AS ok");
    res.json({ ok: true, db: r.rows[0].ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, db: false });
  }
});

const nipResetRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().regex(/^\d{10}$/, "Teléfono debe ser de 10 dígitos"),
});

const nipResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // 10 intentos por IP cada 15 min (ajustable)
  standardHeaders: true,
  legacyHeaders: false,
});

app.post("/nip-reset/request", nipResetLimiter, async (req, res) => {
  // Respuesta SIEMPRE genérica (anti-enumeración)
  const genericResponse = {
    ok: true,
    message:
      "Listo. Si los datos coinciden con un registro, recibirás un correo con la liga para restablecer tu NIP.",
  };

  // 1) Validación de formato (aquí sí regresamos 400 si viene mal)
  const parsed = nipResetRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      message: "Datos inválidos. Revisa correo y teléfono.",
      errors: parsed.error.issues.map((i) => ({ field: i.path.join("."), msg: i.message })),
    });
  }

  const { email, phone } = parsed.data;

  // 2) TTL (minutos) con default 60
  const ttlMinutes = Number(process.env.RESET_TOKEN_TTL_MINUTES || 60);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

  // 3) customer_ref sin PII: hash(email|phone)
  const customerRef = crypto
    .createHash("sha256")
    .update(`${email}|${phone}`)
    .digest("hex");

  // 4) Token fuerte (no lo guardamos en claro)
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  try {
    // Invalida tokens previos activos para esa llave (one-active-token policy)
    await pool.query(
      "UPDATE nip_reset_tokens SET used_at = now() WHERE customer_ref=$1 AND used_at IS NULL",
      [customerRef]
    );

    // Inserta el nuevo token hash
    await pool.query(
      `INSERT INTO nip_reset_tokens (customer_ref, token_hash, expires_at, request_ip, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        customerRef,
        tokenHash,
        expiresAt,
        req.ip || null,
        req.get("user-agent") || null,
      ]
    );

    // Importante: NO devolvemos el token aquí (lo enviaremos por correo en el siguiente paso)
    return res.status(200).json(genericResponse);
  } catch (e) {
    // No revelar detalles al cliente. Log mínimo para ti.
    console.error("nip-reset/request error:", e?.message || e);
    return res.status(200).json(genericResponse);
  }
});

// Error handler final
app.use((err, req, res, next) => {
  res.status(500).json({ ok: false });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  // No logueamos secretos
  console.log(`ama-reset-nip-api listening on port ${port}`);
});
