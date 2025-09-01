// scripts/init-db.js
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { Client } = require('pg')

// Leer el archivo schema.sql
const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')

;(async () => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.POSTGRES_SSL === 'true' ||
      /render\.com|sslmode=require/.test(process.env.DATABASE_URL || '')
        ? { rejectUnauthorized: false }
        : undefined,
  })

  try {
    await client.connect()
    await client.query(sql)
    console.log('✅ DB init completed successfully')
  } catch (err) {
    console.error('❌ DB init error:', err.message)
    process.exit(1)
  } finally {
    await client.end()
  }
})()
