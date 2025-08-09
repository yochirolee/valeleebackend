// scripts/init-db.js
require('dotenv').config()
const { Client } = require('pg')

const sql = `
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  password TEXT NOT NULL,
  address TEXT,
  payment_method TEXT,
  metadata JSONB
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  title TEXT,
  image_url TEXT,
  description TEXT,
  price NUMERIC(10, 2) NOT NULL,
  weight NUMERIC(10, 2),
  category_id INTEGER REFERENCES categories(id),
  metadata JSONB
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  total NUMERIC(10, 2) NOT NULL,
  status TEXT DEFAULT 'pending',
  payment_method TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB
);

CREATE TABLE IF NOT EXISTS line_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_price NUMERIC(10, 2),
  metadata JSONB
);

CREATE TABLE IF NOT EXISTS carts (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  completed BOOLEAN DEFAULT FALSE,
  metadata JSONB
);

CREATE TABLE IF NOT EXISTS cart_items (
  id SERIAL PRIMARY KEY,
  cart_id INTEGER REFERENCES carts(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL,
  metadata JSONB
);

-- 🔹 Seed
INSERT INTO categories (slug, name) VALUES
  ('food','Food'),
  ('appliances','Appliances')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO products (name, description, price, weight, category_id, metadata)
SELECT 'Cafe La Llave','Cafe La Llave',5.00,1.00,c.id,
       jsonb_build_object('image_url','https://valeleebackend.onrender.com/img/cafeLaLlave.jpg')
FROM categories c
WHERE c.slug='food'
AND NOT EXISTS (SELECT 1 FROM products p WHERE p.name='Cafe La Llave');

INSERT INTO products (name, description, price, weight, category_id, metadata)
SELECT 'Cafe Bustelo','Cafe Bustelo',6.00,1.00,c.id,
       jsonb_build_object('image_url','https://valeleebackend.onrender.com/img/cafeBustelo.jpg')
FROM categories c
WHERE c.slug='food'
AND NOT EXISTS (SELECT 1 FROM products p WHERE p.name='Cafe Bustelo');

INSERT INTO products (name, description, price, weight, category_id, metadata)
SELECT 'Planta Electrica','Planta Electrica',300.00,100.00,c.id,
       jsonb_build_object('image_url','https://valeleebackend.onrender.com/img/planta.jpg')
FROM categories c
WHERE c.slug='appliances'
AND NOT EXISTS (SELECT 1 FROM products p WHERE p.name='Planta Electrica');
`;

(async () => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  })
  try {
    await client.connect()
    await client.query('BEGIN')
    await client.query(sql)
    await client.query('COMMIT')
    console.log('DB init + seed OK')
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{})
    console.error('DB init error:', err.message)
    process.exit(1)
  } finally {
    await client.end()
  }
})()
