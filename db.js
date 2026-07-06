const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10000),
  query_timeout: Number(process.env.DB_QUERY_TIMEOUT_MS || 30000),
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 30000),
});

pool.on("error", (err) => {
  console.error("POSTGRES POOL ERROR:", err.message);
});

module.exports = pool;
