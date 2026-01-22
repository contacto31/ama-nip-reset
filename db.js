const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("Falta DATABASE_URL en variables de entorno");
}

// Pool con timeouts razonables (seguridad/estabilidad)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

module.exports = { pool };
