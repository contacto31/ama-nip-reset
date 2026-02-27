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
  methods: ["GET", "POST", "OPTIONS"],
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
const nipResetLookupSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  whatsapp_id: z.string().trim().regex(/^\d{10}$/, "Teléfono debe ser de 10 dígitos"),
});

const nipResetSendLinkSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  whatsapp_id: z.string().trim().regex(/^\d{10}$/, "Teléfono debe ser de 10 dígitos"),
  cliente_id: z.string().trim().min(1).max(255),
  vehiculoId: z.string().trim().min(1).max(255),
});

const nipResetTokenInfoSchema = z.object({
  token: z.string().trim().min(20).max(200),
});

const nipResetConfirmSchema = z.object({
  token: z.string().trim().min(20).max(200),
  nip: z.string().trim().regex(/^\d{4}$/, "NIP debe ser de 4 dígitos"),
  nipConfirm: z.string().trim().regex(/^\d{4}$/, "Confirmación debe ser de 4 dígitos"),
});

/**
 * Rate limits
 */
const nipLookupLimiter = rateLimit({
  windowMs: Number(process.env.NIP_LOOKUP_IP_RATE_WINDOW_MINUTES || process.env.NIP_RESET_IP_RATE_WINDOW_MINUTES || 15) * 60 * 1000,
  max: Number(process.env.NIP_LOOKUP_IP_RATE_MAX || process.env.NIP_RESET_IP_RATE_MAX || 10),
  standardHeaders: true,
  legacyHeaders: false,
});

const nipSendLinkLimiter = rateLimit({
  windowMs: Number(process.env.NIP_SEND_LINK_IP_RATE_WINDOW_MINUTES || process.env.NIP_RESET_IP_RATE_WINDOW_MINUTES || 15) * 60 * 1000,
  max: Number(process.env.NIP_SEND_LINK_IP_RATE_MAX || process.env.NIP_RESET_IP_RATE_MAX || 3),
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
function normalizePhoneForAirtable(whatsappId10) {
  return `52${whatsappId10}`;
}

function airtableEscapeFormulaString(str) {
  return String(str).replace(/'/g, "\\'");
}

function normalizeAirtableText(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (!value.length) return null;
    return String(value[0]).trim() || null;
  }
  const text = String(value).trim();
  return text || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAirtableConfig() {
  const config = {
    apiKey: process.env.AIRTABLE_API_KEY,
    baseId: process.env.AIRTABLE_BASE_ID,
    contactosTable: process.env.AIRTABLE_CONTACTOS_TABLE_NAME || "Contactos",
    contactosEmailField: process.env.AIRTABLE_CONTACTOS_EMAIL_FIELD || "email",
    contactosWhatsappField: process.env.AIRTABLE_CONTACTOS_WHATSAPP_FIELD || "whatsapp_id",
    contactosClienteIdField: process.env.AIRTABLE_CONTACTOS_CLIENTE_ID_FIELD || "cliente_id",
    vehiculosTable: process.env.AIRTABLE_VEHICULOS_TABLE_NAME || "Vehiculos",
    vehiculosContactoLinkField: process.env.AIRTABLE_VEHICULOS_CONTACTO_LINK_FIELD || "whatsappNumero",
    vehiculosVehiculoIdField: process.env.AIRTABLE_VEHICULOS_VEHICULO_ID_FIELD || "vehiculoId",
    vehiculosApodoField: process.env.AIRTABLE_VEHICULOS_APODO_FIELD || "apodo",
  };

  if (!config.apiKey || !config.baseId) {
    throw new Error("Airtable: faltan AIRTABLE_API_KEY o AIRTABLE_BASE_ID");
  }
  return config;
}

async function airtableListRecords({ tableName, formula, maxRecords = 100 }) {
  const cfg = getAirtableConfig();
  const base = `https://api.airtable.com/v0/${cfg.baseId}/${encodeURIComponent(tableName)}`;
  const query = new URLSearchParams({
    maxRecords: String(maxRecords),
    filterByFormula: formula,
  });
  const url = `${base}?${query.toString()}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Airtable lookup failed (${resp.status}): ${txt.slice(0, 200)}`);
  }

  const data = await resp.json();
  return Array.isArray(data?.records) ? data.records : [];
}

async function findContactoByEmailWhatsapp(email, whatsapp10) {
  const cfg = getAirtableConfig();
  const phone12 = normalizePhoneForAirtable(whatsapp10);

  const emailEsc = airtableEscapeFormulaString(email.toLowerCase());
  const phoneEsc = airtableEscapeFormulaString(phone12);

  const formula = `AND(LOWER({${cfg.contactosEmailField}})='${emailEsc}', OR({${cfg.contactosWhatsappField}}='${phoneEsc}', {${cfg.contactosWhatsappField}}=${phoneEsc}))`;
  const records = await airtableListRecords({
    tableName: cfg.contactosTable,
    formula,
    maxRecords: 1,
  });

  if (!records.length) return null;
  const rec = records[0];
  const clienteId = normalizeAirtableText(rec?.fields?.[cfg.contactosClienteIdField]);
  if (!clienteId) return null;

  return {
    contacto_record_id: rec.id,
    cliente_id: clienteId,
  };
}

async function listVehiculosByContacto(contactoRecordId) {
  const cfg = getAirtableConfig();
  const contactoEsc = airtableEscapeFormulaString(contactoRecordId);
  const formula = `FIND('${contactoEsc}', ARRAYJOIN({${cfg.vehiculosContactoLinkField}}, ','))`;
  const records = await airtableListRecords({
    tableName: cfg.vehiculosTable,
    formula,
    maxRecords: 100,
  });

  const out = [];
  for (const rec of records) {
    const vehiculoId = normalizeAirtableText(rec?.fields?.[cfg.vehiculosVehiculoIdField]);
    if (!vehiculoId) continue;
    const apodoRaw = normalizeAirtableText(rec?.fields?.[cfg.vehiculosApodoField]);
    const apodo = apodoRaw || "Vehículo sin apodo";
    out.push({
      vehiculo_record_id: rec.id,
      vehiculoId,
      apodo,
      identifica_tu_vehiculo: apodo,
    });
  }
  return out;
}

async function findContactoAndVehiculos(email, whatsapp10) {
  const contacto = await findContactoByEmailWhatsapp(email, whatsapp10);
  if (!contacto) return null;
  const vehiculos = await listVehiculosByContacto(contacto.contacto_record_id);
  return { ...contacto, vehiculos };
}

async function isVehicleRateLimited(clienteId, vehiculoId) {
  const windowMinutes = Number(process.env.CUSTOMER_VEHICLE_RATE_WINDOW_MINUTES || 60);
  const maxPerWindow = Number(process.env.CUSTOMER_VEHICLE_RATE_MAX || 2);
  const q = `
    SELECT COUNT(*)::int AS c
    FROM nip_reset_tokens
    WHERE cliente_id = $1
      AND vehiculo_id = $2
      AND created_at > now() - ($3 * interval '1 minute')
  `;
  const { rows } = await pool.query(q, [clienteId, vehiculoId, windowMinutes]);
  return (rows?.[0]?.c || 0) >= maxPerWindow;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildWebhookSignature(secret, timestamp, payloadString) {
  const stringToSign = `${timestamp}.${payloadString}`;
  return crypto.createHmac("sha256", secret).update(stringToSign).digest("hex");
}

async function sendNipPersistWebhook(payload) {
  const webhookUrl = process.env.NIP_PERSIST_WEBHOOK_URL;
  const webhookSecret = process.env.NIP_PERSIST_WEBHOOK_SECRET;
  if (!webhookUrl || !webhookSecret) {
    throw new Error("Webhook persistencia NIP no configurado");
  }

  const timeoutMs = Number(process.env.NIP_PERSIST_WEBHOOK_TIMEOUT_MS || 8000);
  const retryDelayMs = Number(process.env.NIP_PERSIST_WEBHOOK_RETRY_DELAY_MS || 400);
  const maxAttempts = 2;

  const body = JSON.stringify(payload);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const timestamp = new Date().toISOString();
    const signature = buildWebhookSignature(webhookSecret, timestamp, body);

    try {
      const resp = await fetchWithTimeout(
        webhookUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-ama-event": payload.evento,
            "x-ama-timestamp": timestamp,
            "x-ama-signature": signature,
          },
          body,
        },
        timeoutMs
      );

      if (resp.ok) return;

      const txt = await resp.text().catch(() => "");
      const err = new Error(`Webhook persist failed (${resp.status}): ${txt.slice(0, 200)}`);
      if (attempt === maxAttempts) throw err;
    } catch (e) {
      if (attempt === maxAttempts) throw e;
    }

    await sleep(retryDelayMs);
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
 * POST /nip-reset/lookup
 */
app.post("/nip-reset/lookup", nipLookupLimiter, async (req, res) => {
  const parsed = nipResetLookupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      message: "Datos inválidos. Revisa correo y teléfono.",
      errors: parsed.error.issues.map((i) => ({ field: i.path.join("."), msg: i.message })),
    });
  }

  const { email, whatsapp_id } = parsed.data;

  try {
    const found = await findContactoAndVehiculos(email, whatsapp_id);
    if (!found || !Array.isArray(found.vehiculos) || found.vehiculos.length === 0) {
      return res.status(404).json({ ok: false, message: "Datos incorrectos" });
    }

    const step = found.vehiculos.length === 1 ? "confirmar_vehiculo_unico" : "seleccionar_vehiculo";
    return res.status(200).json({
      ok: true,
      step,
      cliente_id: found.cliente_id,
      contacto_record_id: found.contacto_record_id,
      vehiculos: found.vehiculos.map((v) => ({
        vehiculoId: v.vehiculoId,
        vehiculo_record_id: v.vehiculo_record_id,
        identifica_tu_vehiculo: v.identifica_tu_vehiculo,
      })),
    });
  } catch (e) {
    console.error("[nip-reset/lookup] error:", e?.message || e);
    return res.status(500).json({ ok: false, message: "No fue posible completar la operación." });
  }
});

/**
 * POST /nip-reset/send-link
 */
app.post("/nip-reset/send-link", nipSendLinkLimiter, async (req, res) => {
  const parsed = nipResetSendLinkSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      message: "Datos inválidos. Revisa correo, teléfono y vehículo.",
      errors: parsed.error.issues.map((i) => ({ field: i.path.join("."), msg: i.message })),
    });
  }

  const { email, whatsapp_id, cliente_id, vehiculoId } = parsed.data;

  try {
    const found = await findContactoAndVehiculos(email, whatsapp_id);
    if (!found || found.cliente_id !== cliente_id) {
      return res.status(404).json({ ok: false, message: "Datos incorrectos" });
    }

    const selectedVehicle = (found.vehiculos || []).find((v) => v.vehiculoId === vehiculoId);
    if (!selectedVehicle) {
      return res.status(404).json({ ok: false, message: "Datos incorrectos" });
    }

    const vehicleLimited = await isVehicleRateLimited(cliente_id, vehiculoId);
    if (vehicleLimited) {
      return res.status(429).json({
        ok: false,
        message: "Demasiados intentos. Intenta nuevamente más tarde.",
      });
    }

    const ttlMinutes = Number(process.env.RESET_TOKEN_TTL_MINUTES || 60);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE nip_reset_tokens
         SET used_at = now()
         WHERE cliente_id = $1
           AND vehiculo_id = $2
           AND used_at IS NULL`,
        [cliente_id, vehiculoId]
      );

      await client.query(
        `INSERT INTO nip_reset_tokens (
           customer_ref,
           cliente_id,
           contacto_record_id,
           vehiculo_id,
           vehiculo_record_id,
           vehiculo_apodo,
           token_hash,
           expires_at,
           request_ip,
           user_agent
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          found.contacto_record_id,
          cliente_id,
          found.contacto_record_id,
          vehiculoId,
          selectedVehicle.vehiculo_record_id,
          selectedVehicle.apodo,
          tokenHash,
          expiresAt,
          req.ip || null,
          req.get("user-agent") || null,
        ]
      );

      await client.query("COMMIT");
    } catch (txError) {
      await client.query("ROLLBACK").catch(() => {});
      throw txError;
    } finally {
      client.release();
    }

    try {
      await sendResetEmail(email, token, ttlMinutes);
    } catch (mailErr) {
      await pool.query(
        "UPDATE nip_reset_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL",
        [tokenHash]
      );
      throw mailErr;
    }

    return res.status(200).json({
      ok: true,
      message: "Hemos enviado al correo registrado la URL para reiniciar tu NIP.",
    });
  } catch (e) {
    console.error("[nip-reset/send-link] error:", e?.message || e);
    return res.status(500).json({ ok: false, message: "No fue posible completar la operación." });
  }
});

/**
 * GET /nip-reset/token-info?token=...
 */
app.get("/nip-reset/token-info", async (req, res) => {
  const parsed = nipResetTokenInfoSchema.safeParse({ token: req.query?.token });
  if (!parsed.success) {
    return res.status(400).json({ ok: false, message: "Token inválido." });
  }

  const tokenHash = crypto.createHash("sha256").update(parsed.data.token).digest("hex");

  try {
    const { rows } = await pool.query(
      `SELECT cliente_id, vehiculo_id, vehiculo_apodo, expires_at, used_at
       FROM nip_reset_tokens
       WHERE token_hash = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [tokenHash]
    );

    if (!rows.length) {
      return res.status(403).json({ ok: false, message: "Liga inválida o expirada." });
    }

    const row = rows[0];
    if (row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(403).json({ ok: false, message: "Liga inválida o expirada." });
    }

    return res.status(200).json({
      ok: true,
      cliente_id: row.cliente_id,
      vehiculoId: row.vehiculo_id,
      identifica_tu_vehiculo: row.vehiculo_apodo || "Vehículo sin apodo",
    });
  } catch (e) {
    console.error("[nip-reset/token-info] error:", e?.message || e);
    return res.status(500).json({ ok: false, message: "No fue posible completar la operación." });
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
      `SELECT
         customer_ref,
         cliente_id,
         contacto_record_id,
         vehiculo_id,
         vehiculo_record_id,
         vehiculo_apodo,
         expires_at,
         used_at
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

    if (!row.cliente_id || !row.vehiculo_id) {
      await client.query("ROLLBACK");
      return res.status(503).json({
        ok: false,
        message: "Función en configuración. Solicita un nuevo restablecimiento.",
      });
    }

    const requestId =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString("hex");

    const webhookPayload = {
      evento: "NIP_RESET_CONFIRMADO",
      request_id: requestId,
      timestamp: new Date().toISOString(),
      cliente_id: row.cliente_id,
      vehiculoId: row.vehiculo_id,
      contacto_record_id: row.contacto_record_id || row.customer_ref || null,
      vehiculo_record_id: row.vehiculo_record_id || null,
      apodo: row.vehiculo_apodo || null,
      nuevo_nip: nip,
    };

    try {
      await sendNipPersistWebhook(webhookPayload);
    } catch (webhookError) {
      await client.query("ROLLBACK");
      console.error("[nip-reset/confirm] webhook error:", webhookError?.message || webhookError);
      return res.status(503).json({
        ok: false,
        message: "No fue posible completar la operación. Intenta nuevamente.",
      });
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
