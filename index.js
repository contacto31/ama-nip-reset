const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const { z } = require("zod");
const nodemailer = require("nodemailer");
const path = require("path");
const { pool } = require("./db");

const app = express();
app.set("trust proxy", 1);
app.use(helmet());
app.use(express.json({ limit: "10kb" }));

// Static assets (email logo/icons)
app.use("/assets", express.static(path.join(__dirname, "assets"), { maxAge: "1h" }));

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
  } catch (e) {
    console.error("[db-health] error:", e?.message || e);
    res.status(500).json({ ok: false, db: false });
  }
});

/**
 * Strict CORS ONLY for /nip-reset/*
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
 * Rate limits
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
 * Airtable helpers
 */
function normalizePhoneForAirtable(phone10) {
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
  return Array.isArray(data?.records) && data.records.length ? data.records[0] : null;
}

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
        [nipField]: nip, // texto
      },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Airtable update failed (${resp.status}): ${text.slice(0, 200)}`);
  }
}

/**
 * SMTP / Email
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

  const brandOrange = "#E27C39";
  const brandDark = "#0D0D0D";
  const facebookUrl = "https://www.facebook.com/profile.php?id=61585082213385";
  const phoneDisplay = "55 9990 0577";
  const waLink = "https://wa.me/525599900577";
  const siteUrl = "https://amatracksafe.com.mx";

  const logoUrl = process.env.MAIL_LOGO_URL || "";

  // Cache-busting para Gmail (sube v=3, v=4 si vuelves a cambiar icons)
  const assetsBase = "https://reset.amatracksafe.com.mx/assets";
  const v = "3";
  const lockIconUrl = `${assetsBase}/lock.png?v=${v}`;
  const waIconUrl = `${assetsBase}/wa.png?v=${v}`;
  const fbIconUrl = `${assetsBase}/fb.png?v=${v}`;

  const subject = "Restablece tu NIP | AMA Track & Safe";

  const text =
`Hola,

Recibimos una solicitud para restablecer tu NIP de seguridad.

Abre esta liga para crear un nuevo NIP:
${link}

Este enlace expira en ${ttlMinutes} minutos.
Si tú no hiciste esta solicitud, puedes ignorar este correo.

— AMA Track & Safe
${siteUrl}
WhatsApp: ${phoneDisplay}
Facebook: ${facebookUrl}
`;

  const headerLogo = logoUrl
    ? `<img src="${logoUrl}" alt="AMA Track & Safe" style="display:block; height:72px; width:auto; max-width:320px; margin:0 auto;" />`
    : `<div style="font-size:20px; font-weight:900; letter-spacing:.2px; color:${brandDark}; text-align:center;">
         AMA <span style="color:${brandOrange};">Track</span> &amp; Safe
       </div>`;

  const lockBadge = `
<table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 auto;">
  <tr>
    <td style="width:56px; height:56px; border-radius:999px; background:${brandOrange}; text-align:center; vertical-align:middle;">
      <img src="${lockIconUrl}" alt="Seguridad" width="26" height="26"
           style="display:inline-block; vertical-align:middle; border:0; outline:none; text-decoration:none;" />
    </td>
  </tr>
</table>`;

  const html = `
<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="x-apple-disable-message-reformatting">
    <title>Restablecer NIP</title>
  </head>
  <body style="margin:0; padding:0; background:#f4f6f8;">
    <div style="display:none; max-height:0; overflow:hidden; opacity:0; color:transparent;">
      Restablece tu NIP de seguridad. Enlace válido por ${ttlMinutes} minutos.
    </div>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6f8; padding:24px 0;">
      <tr>
        <td align="center" style="padding:0 16px;">
          <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="width:100%; max-width:640px;">

            <!-- Top orange line (más ancha) -->
            <tr>
              <td style="height:12px; background:${brandOrange}; border-radius:12px 12px 0 0;"></td>
            </tr>

            <!-- Header BLANCO -->
            <tr>
              <td style="background:#ffffff; padding:18px; border-left:1px solid #e9edf2; border-right:1px solid #e9edf2;">
                ${headerLogo}
              </td>
            </tr>

            <!-- Card -->
            <tr>
              <td style="background:#ffffff; padding:18px; border-left:1px solid #e9edf2; border-right:1px solid #e9edf2;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
                  style="background:#ffffff; border:1px solid #eef1f5; border-radius:16px; overflow:hidden; box-shadow:0 8px 24px rgba(13,13,13,0.08);">
                  <tr>
                    <td style="padding:22px 22px 10px; text-align:center;">
                      ${lockBadge}
                      <h1 style="margin:14px 0 0; font-family:Arial, sans-serif; font-size:30px; line-height:1.2; color:#1b2430;">
                        Restablecer tu NIP
                      </h1>
                      <p style="margin:10px 0 0; font-family:Arial, sans-serif; font-size:15px; line-height:1.6; color:#5b6673;">
                        Crea un nuevo NIP de 4 dígitos para validar tu identidad al reportar un siniestro.
                      </p>
                    </td>
                  </tr>

                  <tr>
                    <td style="padding:0 22px 12px; font-family:Arial, sans-serif; color:#2f3a48;">
                      <p style="margin:0 0 10px; font-size:16px; line-height:1.6;">Hola,</p>
                      <p style="margin:0 0 16px; font-size:16px; line-height:1.6;">
                        Recibimos una solicitud para restablecer tu NIP de seguridad.
                      </p>

                      <!-- Button -->
                      <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 auto 14px;">
                        <tr>
                          <td align="center" style="border-radius:10px; background:${brandDark}; box-shadow:0 8px 16px rgba(13,13,13,.18);">
                            <a href="${link}"
                              style="display:inline-block; padding:14px 22px; font-family:Arial, sans-serif; font-size:18px; font-weight:800; text-decoration:none; color:${brandOrange};">
                              Restablecer NIP
                            </a>
                          </td>
                        </tr>
                      </table>

                      <p style="margin:0 0 8px; font-size:14px; color:#6b7785;">
                        O copia y pega este enlace en tu navegador:
                      </p>

                      <div style="background:#fff7f0; border:1px solid #ffd7bf; padding:12px; border-radius:10px; font-size:13px; line-height:1.5; word-break:break-all;">
                        <a href="${link}" style="color:${brandOrange}; text-decoration:none;">${link}</a>
                      </div>

                      <div style="height:14px;"></div>

                      <p style="margin:0; font-size:14px; color:#2f3a48;">
                        <span style="color:${brandOrange}; font-weight:800;">Expira en ${ttlMinutes} minutos.</span>
                      </p>

                      <div style="height:10px;"></div>

                      <p style="margin:0; font-size:13px; color:#6b7785;">
                        Si tú no solicitaste este restablecimiento, puedes ignorar este correo.
                      </p>
                    </td>
                  </tr>

                  <tr>
                    <td style="padding:14px 22px 18px;">
                      <hr style="border:none; border-top:1px solid #eef1f5; margin:0;">
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Footer orange -->
            <tr>
              <td style="background:${brandOrange}; padding:16px 18px; text-align:center; color:#fff; font-family:Arial, sans-serif; border-left:1px solid #e9edf2; border-right:1px solid #e9edf2;">
                <div style="font-size:22px; font-weight:900; letter-spacing:.2px;">AMA Track &amp; Safe</div>
                <div style="margin-top:6px; font-size:15px; font-weight:700;">
                  <a href="${siteUrl}" style="color:#fff; text-decoration:none;">amatracksafe.com.mx</a>
                </div>
              </td>
            </tr>

            <!-- Footer dark -->
            <tr>
              <td style="background:${brandDark}; padding:14px 18px; border-radius:0 0 12px 12px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">

                  <tr>
                    <td style="text-align:center; padding:6px 0;">
                      <a href="${waLink}"
                         style="display:inline-flex; align-items:center; gap:10px; color:#ffffff; text-decoration:none; font-family:Arial, sans-serif; font-size:16px; font-weight:800;">
                        <img src="${waIconUrl}" alt="WhatsApp" width="22" height="22"
                             style="display:inline-block; vertical-align:middle; border:0; outline:none; text-decoration:none;" />
                        <span style="display:inline-block; vertical-align:middle;">${phoneDisplay}</span>
                      </a>
                    </td>
                  </tr>

                  <tr>
                    <td style="text-align:center; padding:6px 0;">
                      <a href="${facebookUrl}"
                         style="display:inline-flex; align-items:center; gap:10px; color:#ffffff; text-decoration:none; font-family:Arial, sans-serif; font-size:14px;">
                        <img src="${fbIconUrl}" alt="Facebook" width="22" height="22"
                             style="display:inline-block; vertical-align:middle; border:0; outline:none; text-decoration:none;" />
                        <span style="display:inline-block; vertical-align:middle;">Facebook</span>
                      </a>
                    </td>
                  </tr>

                  <tr>
                    <td style="text-align:center; padding-top:10px;">
                      <div style="height:1px; background:#2b3644; width:100%;"></div>
                    </td>
                  </tr>

                  <tr>
                    <td style="text-align:center; padding-top:10px; color:#9aa6b2; font-family:Arial, sans-serif; font-size:11px;">
                      Este correo fue enviado automáticamente. Por seguridad, no compartas este enlace.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { from, to, subject, text, html };
}

async function sendResetEmail(toEmail, token, ttlMinutes) {
  const base = process.env.RESET_LINK_BASE || "https://amatracksafe.com.mx/restablecer-nip";
  const link = `${base}?token=${encodeURIComponent(token)}`;

  const transporter = getMailer();
  await transporter.verify();

  const mail = buildResetEmail({ to: toEmail, link, ttlMinutes });
  const info = await transporter.sendMail(mail);
  console.log("[mail] sent:", info?.messageId || "ok");
}

/**
 * POST /nip-reset/request
 */
app.post("/nip-reset/request", nipResetLimiter, async (req, res) => {
  // LOG DE ENTRADA (para depurar "no llegan correos")
  console.log("[nip-reset/request] hit", {
    t: new Date().toISOString(),
    origin: req.get("origin") || null,
    ip: req.ip || null,
  });

  const genericResponse = {
    ok: true,
    message:
      "Listo. Si los datos coinciden con un registro, recibirás un correo con la liga para restablecer tu NIP.",
  };

  const parsed = nipResetRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    console.log("[nip-reset/request] invalid payload");
    return res.status(400).json({
      ok: false,
      message: "Datos inválidos. Revisa correo y teléfono.",
      errors: parsed.error.issues.map((i) => ({ field: i.path.join("."), msg: i.message })),
    });
  }

  const { email, phone } = parsed.data;

  // Airtable lookup
  let airtableRec = null;
  try {
    airtableRec = await findAirtableRecordByEmailPhone(email, phone);
    console.log("[nip-reset/request] airtable match:", Boolean(airtableRec));
  } catch (e) {
    console.error("[nip-reset/request] airtable lookup error:", e?.message || e);
    return res.status(200).json(genericResponse);
  }

  if (!airtableRec) {
    return res.status(200).json(genericResponse);
  }

  const customerRef = airtableRec.id;

  // Rate-limit per customerRef
  try {
    const limited = await isCustomerRefRateLimited(customerRef);
    console.log("[nip-reset/request] customerRef limited:", limited);
    if (limited) return res.status(200).json(genericResponse);
  } catch (e) {
    console.error("[nip-reset/request] customerRef rate-limit error:", e?.message || e);
    return res.status(200).json(genericResponse);
  }

  // TTL
  const ttlMinutes = Number(process.env.RESET_TOKEN_TTL_MINUTES || 60);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

  // Token
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

    console.log("[nip-reset/request] token stored, sending email to:", email);

    try {
      await sendResetEmail(email, token, ttlMinutes);
      return res.status(200).json(genericResponse);
    } catch (mailErr) {
      console.error("[nip-reset/request] Email send error:", mailErr?.message || mailErr);

      // Invalidate token if mail failed
      await pool.query(
        "UPDATE nip_reset_tokens SET used_at = now() WHERE token_hash=$1 AND used_at IS NULL",
        [tokenHash]
      );

      return res.status(200).json(genericResponse);
    }
  } catch (e) {
    console.error("[nip-reset/request] internal error:", e?.message || e);
    return res.status(200).json(genericResponse);
  }
});

/**
 * POST /nip-reset/confirm
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
 * Final error handler
 */
app.use((err, req, res, next) => {
  console.error("[unhandled] error:", err?.message || err);
  res.status(500).json({ ok: false });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`ama-reset-nip-api listening on port ${port}`);
});