// db.js
const { Pool } = require('pg')

const config = {
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : undefined,

  // 🔧 límites del pool (ajustables por .env)
  max: parseInt(process.env.PG_POOL_MAX || '10', 10),        // conexiones simultáneas desde ESTE proceso
  idleTimeoutMillis: parseInt(process.env.PG_IDLE_MS || '30000', 10),
  connectionTimeoutMillis: parseInt(process.env.PG_CONN_TIMEOUT_MS || '2000', 10),

  application_name: 'tienda-local',                           // para identificar conexiones en pg_stat_activity
  // maxUses: 750, // opcional: recicla el cliente tras N usos
}

let pool

// 👉 En desarrollo, reutiliza un único Pool aunque el código se recargue.
if (process.env.NODE_ENV !== 'production') {
  if (!global.__PG_POOL__) {
    global.__PG_POOL__ = new Pool(config)
    global.__PG_POOL__.on('error', (err) => console.error('[pg] idle client error', err))
  }
  pool = global.__PG_POOL__
} else {
  pool = new Pool(config)
  pool.on('error', (err) => console.error('[pg] idle client error', err))
}

module.exports = { pool }
