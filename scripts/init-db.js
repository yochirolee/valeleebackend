// scripts/init-db.js
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { Client } = require('pg')

const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')

  ; (async () => {
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

      // --- Bootstrap de admins desde ENV ---
      const admins = (process.env.ADMIN_EMAILS || '')
        .split(',')
        .map(e => e.trim().toLowerCase())
        .filter(Boolean)

      if (admins.length) {
        await client.query('BEGIN')

        // (Opcional) autocreación con contraseña por defecto
        const bcrypt = require('bcrypt')
        const defaultPwd = process.env.ADMIN_DEFAULT_PASSWORD || 'changeme123!'
        const hash = await bcrypt.hash(defaultPwd, 10)

        for (const email of admins) {
          // ¿Existe ya (case-insensitive)?
          const { rows } = await client.query(
            `SELECT id FROM customers WHERE lower(email) = lower($1) LIMIT 1`,
            [email]
          )

          if (rows.length) {
            // Solo asegurar rol admin
            await client.query(
              `UPDATE customers
             SET metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('role','admin')
             WHERE id = $1`,
              [rows[0].id]
            )
          } else {
            // Insertar nuevo admin con pass por defecto
            await client.query(
              `INSERT INTO customers (email, password, metadata)
             VALUES ($1, $2, jsonb_build_object('role','admin'))`,
              [email, hash]
            )
          }
        }

        await client.query('COMMIT')
        console.log('✅ Admin role aplicado a:', admins)
      } else {
        console.log('ℹ️ ADMIN_EMAILS vacío; no se aplicaron roles.')
      }

      const purge = (process.env.PURGE_PRODUCTS || '').toLowerCase();

      if (purge === 'all') {
        console.warn('⚠️ PURGE_PRODUCTS=all -> TRUNCATE products (cascade).');
        await client.query('BEGIN');
        await client.query('TRUNCATE TABLE products RESTART IDENTITY CASCADE');
        await client.query('COMMIT');
        console.log('✅ Purga completa: products (y dependientes) vaciados.');
      }

      console.log('✅ DB init completed successfully')
    } catch (err) {
      try { await client.query('ROLLBACK') } catch { }
      console.error('❌ DB init error:', err.message)
      process.exit(1)
    } finally {
      await client.end()
    }
  })()
