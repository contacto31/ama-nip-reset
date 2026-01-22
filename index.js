const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const { z } = require("zod");
const { pool } = require("./db");

const app = express();

// Reverse proxy (EasyPanel)
app.set("trust proxy", 1);

// Security headers
app.use(helmet());

// Small JSON body limit
app.use(express.json({ limit: "10kb" }));

/**
 * Global rate limit (soft) for all routes
 */
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

/**
 * Health checks (NO strict CORS)
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
 * Strict CORS ONLY for /nip-reset/*
 * - Requires Origin
 * - Origin must be in ALLOWED_ORIGINS (comma-separated)
 */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsForNipReset = cors({
  origin: function (origin, cb) {
    if (!origin) return cb(new Error("CORS: Origin requerido"));
    if (allowedOrigins.length === 0) return cb(new Error("CORS: Sin allowlist"));
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("CORS: Origin no permitido"));
  },
  methods: ["POST", "OPTIONS"],
});

app.use("/nip-reset", corsForNipReset);

// CORS error handler -> 403
app.use((err, req, res, next) => {
  if (String(err?.message || "").startsWith("CORS:")) {
    return res.status(403).json({ ok: false, message: "Forbidden" });
  }
  next(err);
});

/**
 * Schemas
 */
const nipResetRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().regex(/^\d{10}$/, "Teléfono debe ser de 10 dígitos"),
});

const nipResetConfirmSchema = z.object({
  token: z.string().trim().min(20).max(200),
  nip: z.string().trim().regex(/^\d{4}$/, "NIP debe ser de 4 dígitos"),
  nipConfirm: z.string().trim().regex(/^\d{4}$/, "Confirmación debe ser de 4 dígitos"),
});

/**
 * Rate limits (configurable by env)
 */
const nipResetLimiter = rateLimit({
  windowMs: Number(process.env.NIP_RESET_IP_RATE_WINDOW_MINUTES || 15) * 60 * 1000,
  max: Number(process.env.NIP_RESET_IP_RATE_MAX || 3),
  standardHeaders: true,
  legacyHeaders: false,
});

const nipConfirmLimiter = rateLimit({
  windowMs: Number(process.env.NIP_CONFIRM_IP_RATE_WINDOW_MINUTES || 15) * 60 * 1000,
  max: Number(process.env.NIP_CONFIRM_IP_RATE_MAX || 15),
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Rate limit per customer_ref (email|phone hash)
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

/**
 * POST /nip-reset/request
 * - Validates payload
 * - Applies IP rate limit + customer_ref rate limit
 * - Generates token (NOT returned) and stores only sha256(token) with TTL
 * - Response is always generic (anti-enumeration)
 *
 * NOTE: Tomorrow we will add Airtable existence check + email sending.
 */
app.post("/nip-reset/request", nipResetLimiter, async (req, res) => {
  const genericResponse = {
    ok: true,
    message:
      "Listo. Si los datos coinciden con un registro, recibirás un correo con la liga para restablecer tu NIP.",
  };

  const parsed = nipResetRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      message: "Datos inválidos. Revisa correo y teléfono.",
      errors: parsed.error.issues.map((i) => ({ field: i.path.join("."), msg: i.message })),
    });
  }

  const { email, phone } = parsed.data;

  const ttlMinutes = Number(process.env.RESET_TOKEN_TTL_MINUTES || 60);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

  const customerRef = crypto
    .createHash("sha256")
    .update(`${email}|${phone}`)
    .digest("hex");

  try {
    const limited = await isCustomerRefRateLimited(customerRef);
    if (limited) {
      return res.status(200).json(genericResponse);
    }

    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    await pool.query(
      "UPDATE nip_reset_tokens SET used_at = now() WHERE customer_ref=$1 AND used_at IS NULL",
      [customerRef]
    );

    await pool.query(
      `INSERT INTO nip_reset_tokens (customer_ref, token_hash, expires_at, request_ip, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [customerRef, tokenHash, expiresAt, req.ip || null, req.get("user-agent") || null]
    );

    // Tomorrow: send email with link to HORIZONS:
    // https://amatracksafe.com.mx/restablecer-nip?token=<token>
    // (We are NOT returning token in response.)
    return res.status(200).json(genericResponse);
  } catch (e) {
    console.error("nip-reset/request error:", e?.message || e);
    return res.status(200).json(genericResponse);
  }
});

/**
 * Airtable update via REST (ready for tomorrow)
 * Required env:
 * - AIRTABLE_API_KEY
 * - AIRTABLE_BASE_ID
 * - AIRTABLE_TABLE_NAME
 * - AIRTABLE_NIP_FIELD
 */
async function updateAirtableNip(recordId, nip) {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableName = process.env.AIRTABLE_TABLE_NAME;
  const nipField = process.env.AIRTABLE_NIP_FIELD;

  if (!apiKey || !baseId || !tableName || !nipField) {
    throw new Error("Airtable no configurado");
  }

  const url =
    `https://api.airtable.com/v0/${baseId}/` +
    `${encodeURIComponent(tableName)}/` +
    `${recordId}`;

  const resp = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        [nipField]: nip,
      },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Airtable update failed (${resp.status}): ${text.slice(0, 200)}`);
  }
}

/**
 * POST /nip-reset/confirm
 * - Validates token + NIP + confirmation
 * - Locks token row FOR UPDATE
 * - Checks: exists, not used, not expired
 * - Updates Airtable (tomorrow) OR dev-mode bypass
 * - Marks token as used (one-time)
 *
 * Dev mode (optional): set NIP_CONFIRM_DEV_MODE=true to test UI before Airtable.
 */
app.post("/nip-reset/confirm", nipConfirmLimiter, async (req, res) => {
  const parsed = nipResetConfirmSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, message: "Datos inválidos." });
  }

  const { token, nip, nipConfirm } = parsed.data;
  if (nip !== nipConfirm) {
    return res.status(400).json({ ok: false, message: "Los NIP no coinciden." });
  }

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const devMode = String(process.env.NIP_CONFIRM_DEV_MODE || "").toLowerCase() === "true";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const r = await client.query(
      `SELECT customer_ref, expires_at, used_at
       FROM nip_reset_tokens
       WHERE token_hash = $1
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [tokenHash]
    );

    if (r.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(403).json({ ok: false, message: "Liga inválida o expirada." });
    }

    const row = r.rows[0];

    if (row.used_at) {
      await client.query("ROLLBACK");
      return res.status(403).json({ ok: false, message: "Liga inválida o expirada." });
    }

    if (new Date(row.expires_at).getTime() < Date.now()) {
      await client.query("ROLLBACK");
      return res.status(403).json({ ok: false, message: "Liga inválida o expirada." });
    }

    const customerRef = row.customer_ref;

    // When Airtable is integrated, customerRef should be Airtable recordId (e.g., "recXXXX").
    const looksLikeAirtableRecordId =
      typeof customerRef === "string" && customerRef.startsWith("rec") && customerRef.length >= 10;

    if (!devMode && !looksLikeAirtableRecordId) {
      await client.query("ROLLBACK");
      return res.status(503).json({
        ok: false,
        message: "Función en configuración. Solicita un nuevo restablecimiento.",
      });
    }

    if (!devMode) {
      await updateAirtableNip(customerRef, nip);
    }

    const u = await client.query(
      "UPDATE nip_reset_tokens SET used_at = now() WHERE token_hash=$1 AND used_at IS NULL",
      [tokenHash]
    );

    if (u.rowCount !== 1) {
      await client.query("ROLLBACK");
      return res.status(403).json({ ok: false, message: "Liga inválida o expirada." });
    }

    await client.query("COMMIT");
    return res.status(200).json({ ok: true, message: "Listo. Tu NIP se actualizó correctamente." });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("nip-reset/confirm error:", e?.message || e);
    return res.status(500).json({ ok: false, message: "No fue posible completar la operación." });
  } finally {
    client.release();
  }
});

/**
 * Final error handler (generic)
 */
app.use((err, req, res, next) => {
  res.status(500).json({ ok: false });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`ama-reset-nip-api listening on port ${port}`);
});