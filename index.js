const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { pool } = require("./db");

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

// Error handler final
app.use((err, req, res, next) => {
  res.status(500).json({ ok: false });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  // No logueamos secretos
  console.log(`ama-reset-nip-api listening on port ${port}`);
});
