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

CREATE TABLE IF NOT EXISTS owner_cu_areas (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  province TEXT NOT NULL,
  municipality TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS delivery_events (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  client_tx_id TEXT NOT NULL,
  notes TEXT,
  photo_url TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(order_id, client_tx_id)
);

-- Índices útiles
CREATE INDEX IF NOT EXISTS idx_delivery_events_order ON delivery_events(order_id);

ALTER TABLE owner_shipping_config
  ADD COLUMN IF NOT EXISTS cu_restrict_to_list boolean DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status      ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders (customer_id);
CREATE INDEX IF NOT EXISTS idx_line_items_order   ON line_items (order_id);
CREATE INDEX IF NOT EXISTS idx_customers_role ON customers ((metadata->>'role'));
CREATE UNIQUE INDEX IF NOT EXISTS uniq_owner_cu_area
  ON owner_cu_areas(owner_id, lower(province), COALESCE(lower(municipality), ''));

  CREATE INDEX IF NOT EXISTS idx_owner_cu_areas_owner_prov_mun
ON owner_cu_areas (owner_id, lower(province), lower(COALESCE(municipality, '')));

ALTER TABLE products
  ADD CONSTRAINT stock_qty_nonnegative CHECK (stock_qty >= 0);

  ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS image_url TEXT;

  ALTER TABLE checkout_sessions
ADD COLUMN IF NOT EXISTS payment_method text;

-- 🔹 Seed categorías (con comas y upsert)
INSERT INTO categories (slug, name) VALUES
  ('food', 'Food'),
  ('clothing', 'Clothing'),
  ('medicine', 'Medicine'),
  ('appliances', 'Appliances'),
  ('hygiene', 'Hygiene'),
  ('technology', 'Technology')
ON CONFLICT (slug) DO NOTHING;

-- 🔹 Productos de ejemplo (usa title + image_url)
INSERT INTO products (title, description, price, weight, category_id, image_url)
SELECT 'Cafe La Llave','Cafe La Llave',5.00,1.00,c.id,
       'https://valeleebackend.onrender.com/img/cafeLaLlave.jpg'
FROM categories c
WHERE c.slug='food'
  AND NOT EXISTS (SELECT 1 FROM products p WHERE p.title='Cafe La Llave');

INSERT INTO products (title, description, price, weight, category_id, image_url)
SELECT 'Cafe Bustelo','Cafe Bustelo',6.00,1.00,c.id,
       'https://valeleebackend.onrender.com/img/cafeBustelo.jpg'
FROM categories c
WHERE c.slug='food'
  AND NOT EXISTS (SELECT 1 FROM products p WHERE p.title='Cafe Bustelo');

INSERT INTO products (title, description, price, weight, category_id, image_url)
SELECT 'Planta Electrica','Planta Electrica',300.00,100.00,c.id,
       'https://valeleebackend.onrender.com/img/planta.jpg'
FROM categories c
WHERE c.slug='appliances'
  AND NOT EXISTS (SELECT 1 FROM products p WHERE p.title='Planta Electrica');
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
