// scripts/alter-products.js
/* Idempotente: puedes correrlo en cada arranque sin romper nada */
const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.POSTGRES_SSL === 'true' ||
    /render\.com|sslmode=require/.test(process.env.DATABASE_URL || '')
      ? { rejectUnauthorized: false }
      : undefined,
})

const SQL = `
BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS weight NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS metadata JSONB;

-- Si alguna fila tenía "name", la copiamos a title
UPDATE products SET title = COALESCE(title, name) WHERE title IS NULL;

-- Rellenar image_url si está vacío (ajusta a tus nombres reales de archivo)
UPDATE products
SET image_url = CASE
  WHEN LOWER(title) LIKE '%llave%'   THEN 'https://valeleebackend.onrender.com/img/cafeLaLlave.jpg'
  WHEN LOWER(title) LIKE '%bustelo%' THEN 'https://valeleebackend.onrender.com/img/cafeBustelo.jpg'
  WHEN LOWER(title) LIKE '%planta%'  THEN 'https://valeleebackend.onrender.com/img/planta.jpg'
  ELSE image_url
END
WHERE image_url IS NULL OR image_url = '';

COMMIT;
`;

async function run() {
  const client = await pool.connect()
  try {
    console.log('🔧 Running products migration…')
    await client.query(SQL)
    console.log('✅ Migration completed.')
  } catch (err) {
    console.error('❌ Migration failed:', err)
    process.exitCode = 1
  } finally {
    client.release()
    await pool.end()
  }
}

run()
