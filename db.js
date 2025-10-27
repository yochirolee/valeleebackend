// db.js
const { Pool } = require('pg')

const config = {
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.POSTGRES_SSL === 'false'
      ? false
      : { rejectUnauthorized: false }, // por defecto true, salvo que digas explícitamente false

  // 🔧 límites del pool (ajustables por .env)
  max: parseInt(process.env.PG_POOL_MAX || '20', 10),            
  idleTimeoutMillis: parseInt(process.env.PG_IDLE_MS || '30000', 10),
  connectionTimeoutMillis: parseInt(process.env.PG_CONN_TIMEOUT_MS || '5000', 10),

  application_name: 'tienda-local',
  keepAlive: true,
}

let pool

if (process.env.NODE_ENV !== 'production') {
  if (!global.__PG_POOL__) {
    global.__PG_POOL__ = new Pool(config)
    global.__PG_POOL__.on('error', (err) => console.error('[pg] idle client error', err))
    // timeouts por sesión/conexión
    global.__PG_POOL__.on('connect', (client) => {
      client.query("SET statement_timeout = 4000")                         // 4s por consulta
      client.query("SET idle_in_transaction_session_timeout = 5000")       // 5s
      client.query("SET lock_timeout = 2000")                              // 2s
    })
  }
  pool = global.__PG_POOL__
} else {
  pool = new Pool(config)
  pool.on('error', (err) => console.error('[pg] idle client error', err))
  pool.on('connect', (client) => {
    client.query("SET statement_timeout = 4000")
    client.query("SET idle_in_transaction_session_timeout = 5000")
    client.query("SET lock_timeout = 2000")
  })
}

module.exports = { pool }
