const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const { z } = require("zod");
const nodemailer = require("nodemailer");
const { pool } = require("./db");

const app = express();

// EasyPanel reverse proxy
app.set("trust proxy", 1);

// Security headers
app.use(helmet());

// JSON body limit
app.use(express.json({ limit: "10kb" }));

/**
 * Global rate limit (soft)
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
  } catch {
    res.status(500).json({ ok: false, db: false });
  }
});

/**
 * Strict CORS ONLY for /nip-reset/*
 * Requires Origin and allowlist in ALLOWED_ORIGINS
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
 * Normalize & Airtable helpers
 */
function normalizePhoneForAirtable(phone10) {
  // Modal pide 10 dígitos; Airtable guarda 52 + 10 dígitos sin espacios
  return `52${phone10}`;
}

function airtableEscapeFormulaString(str) {
  return String(str).replace(/'/g, "\\'");
}

async function findAirtableRecordByEmailPhone(email, phone10) {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableName = process.env.AIRTABLE_TABLE_NAME;
  const emailField = process.env.AIRTABLE_EMAIL_FIELD;
  const phoneField = process.env.AIRTABLE_PHONE_FIELD;

  if (!apiKey || !baseId || !tableName || !emailField || !phoneField) {
    throw new Error("Airtable: faltan variables de entorno");
  }

  const phone12 = normalizePhoneForAirtable(phone10);

  const emailEsc = airtableEscapeFormulaString(email.toLowerCase());
  const phoneEsc = airtableEscapeFormulaString(phone12);

  // AND(LOWER({Email})='...', OR({whatsappNumero}='52..', {whatsappNumero}=52..))
  const formula = `AND(LOWER({${emailField}})='${emailEsc}', OR({${phoneField}}='${phoneEsc}', {${phoneField}}=${phoneEsc}))`;

  const url =
    `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}` +
    `?maxRecords=1&filterByFormula=${encodeURIComponent(formula)}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Airtable lookup failed (${resp.status}): ${txt.slice(0, 200)}`);
  }

  const data = await resp.json();
  const rec = Array.isArray(data?.records) && data.records.length ? data.records[0] : null;
  return rec; // { id: "rec...", fields: {...} } o null
}

/**
 * Rate limit per customer_ref (now Airtable recordId recXXXX)
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
 * Airtable update (PATCH record)
 */
async function updateAirtableNip(recordId, nip) {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableName = process.env.AIRTABLE_TABLE_NAME;
  const nipField = process.env.AIRTABLE_NIP_FIELD;

  if (!apiKey || !baseId || !tableName || !nipField) {
    throw new Error("Airtable: faltan variables de entorno para update");
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
        [nipField]: nip, // texto (ya corregiste tipo de campo)
      },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Airtable update failed (${resp.status}): ${text.slice(0, 200)}`);
  }
}

/**
 * SMTP / Email helpers (Gmail)
 */
let mailTransporter = null;

function getMailer() {
  if (mailTransporter) return mailTransporter;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(process.env.SMTP_SECURE || "true").toLowerCase() === "true";
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error("SMTP: faltan variables de entorno");
  }

  mailTransporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  return mailTransporter;
}

function buildResetEmail({ to, link, ttlMinutes }) {
  const from = process.env.MAIL_FROM || `"AMA Track & Safe" <${process.env.SMTP_USER}>`;

  const subject = "Restablece tu NIP | AMA Track & Safe";

  const text =
`Hola,

Recibimos una solicitud para restablecer tu NIP de seguridad.

Abre esta liga para crear un nuevo NIP:
${link}

Esta liga expira en ${ttlMinutes} minutos.
Si tú no hiciste esta solicitud, puedes ignorar este correo.

— AMA Track & Safe
`;

  const html =
`<div style="font-family: Arial, sans-serif; line-height: 1.5; color:#111;">
  <h2 style="margin:0 0 8px;">Restablecer NIP</h2>
  <p style="margin:0 0 12px;">Recibimos una solicitud para restablecer tu NIP de seguridad.</p>
  <p style="margin:0 0 16px;">
    <a href="${link}" style="display:inline-block; padding:10px 14px; text-decoration:none; border-radius:8px; background:#0D0D0D; color:#fff;">
      Restablecer NIP
    </a>
  </p>
  <p style="margin:0 0 12px;">O copia y pega esta liga en tu navegador:</p>
  <p style="margin:0 0 16px; word-break: break-all;">
    <a href="${link}">${link}</a>
  </p>
  <p style="margin:0 0 12px; color:#333;">Esta liga expira en <b>${ttlMinutes} minutos</b>.</p>
  <p style="margin:0; color:#555;">Si tú no hiciste esta solicitud, puedes ignorar este correo.</p>
  <hr style="border:none; border-top:1px solid #eee; margin:16px 0;" />
  <p style="margin:0; color:#777;">— AMA Track & Safe</p>
</div>`;

  return { from, to, subject, text, html };
}

async function sendResetEmail(toEmail, token, ttlMinutes) {
  const base = process.env.RESET_LINK_BASE || "https://amatracksafe.com.mx/restablecer-nip";
  const link = `${base}?token=${encodeURIComponent(token)}`;

  const transporter = getMailer();

  // Verifica conexión SMTP (rápido y útil en logs)
  await transporter.verify();

  const mail = buildResetEmail({ to: toEmail, link, ttlMinutes });
  const info = await transporter.sendMail(mail);

  // No logueamos token ni correo completo; solo messageId
  console.log("Reset email sent:", info?.messageId || "ok");
}

/**
 * POST /nip-reset/request
 * - Airtable match
 * - Store token hash in Postgres
 * - Send email with link to HORIZONS
 * - Generic response always
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

  // 1) Airtable lookup
  let airtableRec = null;
  try {
    airtableRec = await findAirtableRecordByEmailPhone(email, phone);
  } catch (e) {
    console.error("Airtable lookup error:", e?.message || e);
    return res.status(200).json(genericResponse);
  }

  if (!airtableRec) {
    return res.status(200).json(genericResponse);
  }

  const customerRef = airtableRec.id;

  // 2) Rate limit por customerRef
  try {
    const limited = await isCustomerRefRateLimited(customerRef);
    if (limited) return res.status(200).json(genericResponse);
  } catch (e) {
    console.error("customerRef rate-limit error:", e?.message || e);
    return res.status(200).json(genericResponse);
  }

  // 3) TTL
  const ttlMinutes = Number(process.env.RESET_TOKEN_TTL_MINUTES || 60);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

  // 4) Token fuerte (no se guarda en claro)
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  try {
    // One-active-token policy
    await pool.query(
      "UPDATE nip_reset_tokens SET used_at = now() WHERE customer_ref=$1 AND used_at IS NULL",
      [customerRef]
    );

    await pool.query(
      `INSERT INTO nip_reset_tokens (customer_ref, token_hash, expires_at, request_ip, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [customerRef, tokenHash, expiresAt, req.ip || null, req.get("user-agent") || null]
    );

    // 5) Enviar correo (si falla, invalidamos este token para no dejarlo vivo sin entrega)
    try {
      await sendResetEmail(email, token, ttlMinutes);
    } catch (mailErr) {
      console.error("Email send error:", mailErr?.message || mailErr);

      // Invalidar este token recién creado
      await pool.query(
        "UPDATE nip_reset_tokens SET used_at = now() WHERE token_hash=$1 AND used_at IS NULL",
        [tokenHash]
      );

      return res.status(200).json(genericResponse);
    }

    return res.status(200).json(genericResponse);
  } catch (e) {
    console.error("nip-reset/request error:", e?.message || e);
    return res.status(200).json(genericResponse);
  }
});

/**
 * POST /nip-reset/confirm
 * - Validates token + NIP + confirmation
 * - Locks token row FOR UPDATE
 * - Checks: exists, not used, not expired
 * - Updates Airtable NIP
 * - Marks token as used
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

    const recordId = row.customer_ref;

    const looksLikeAirtableRecordId =
      typeof recordId === "string" && recordId.startsWith("rec") && recordId.length >= 10;

    if (!looksLikeAirtableRecordId) {
      await client.query("ROLLBACK");
      return res.status(503).json({
        ok: false,
        message: "Función en configuración. Solicita un nuevo restablecimiento.",
      });
    }

    await updateAirtableNip(recordId, nip);

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