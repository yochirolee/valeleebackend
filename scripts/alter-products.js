// scripts/alter-products.js
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

CREATE UNIQUE INDEX IF NOT EXISTS customers_email_lower_uk
ON customers ((lower(email)));

ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS total NUMERIC(12,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status      ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders (customer_id);
CREATE INDEX IF NOT EXISTS idx_line_items_order   ON line_items (order_id);
CREATE INDEX IF NOT EXISTS idx_customers_role ON customers ((metadata->>'role'));

ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS image_url TEXT;
  
ALTER TABLE products
  ADD CONSTRAINT stock_qty_nonnegative CHECK (stock_qty >= 0);

-- 1) Owners
CREATE TABLE owners (
  id SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,
  phone       TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2) products.owner_id
ALTER TABLE products ADD COLUMN owner_id INT;
ALTER TABLE products
  ADD CONSTRAINT fk_products_owner
  FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE RESTRICT;
CREATE INDEX idx_products_owner ON products(owner_id);

-- (opcional) Si hoy guardas "metadata->>'owner'":
-- INSERT INTO owners(name,email) SELECT DISTINCT metadata->>'owner', concat((metadata->>'owner'),'@example.com')
--   FROM products WHERE metadata ? 'owner';
-- UPDATE products p SET owner_id = o.id
--   FROM owners o WHERE (p.metadata->>'owner') = o.name;

-- 3) Ordenes por owner (para identificar dueño directo de cada orden)
ALTER TABLE orders ADD COLUMN owner_id INT REFERENCES owners(id);
CREATE INDEX idx_orders_owner ON orders(owner_id);

-- 4) Config simple de tarifas por owner (desnormalizada para no enredarte)
CREATE TABLE owner_shipping_config (
  id SERIAL PRIMARY KEY,
  owner_id INT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  country  CHAR(2) NOT NULL,                 -- 'US' o 'CU'
  mode     TEXT NOT NULL CHECK (mode IN ('fixed','weight')),
  currency CHAR(3) NOT NULL DEFAULT 'USD',

  -- US (siempre fija)
  us_flat NUMERIC(10,2),

  -- Cuba (fijas)
  cu_hab_city_flat   NUMERIC(10,2),
  cu_hab_rural_flat  NUMERIC(10,2),
  cu_other_city_flat NUMERIC(10,2),
  cu_other_rural_flat NUMERIC(10,2),

  -- Cuba (por peso): total = base_region + (rate_per_lb * total_lbs), y minimo opcional
  cu_rate_per_lb     NUMERIC(10,2),
  cu_hab_city_base   NUMERIC(10,2),
  cu_hab_rural_base  NUMERIC(10,2),
  cu_other_city_base NUMERIC(10,2),
  cu_other_rural_base NUMERIC(10,2),
  cu_min_fee         NUMERIC(10,2),

  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(owner_id, country)
);

-- 5) checkout_sessions para cobrar 1 vez e idempotencia
CREATE TABLE checkout_sessions (
  id BIGSERIAL PRIMARY KEY,
  customer_id INT REFERENCES customers(id),
  cart_id     INT REFERENCES carts(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','expired')),
  amount_total NUMERIC(10,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  snapshot JSONB NOT NULL,    -- items agrupados por owner, shipping_by_owner, taxes, weights, address
  metadata JSONB NOT NULL DEFAULT '{}',
  payment  JSONB,             -- link_id, link_url, invoiceNumber, status...
  created_order_ids INT[] DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX idx_chk_sessions_cart ON checkout_sessions(cart_id);
CREATE INDEX idx_chk_sessions_customer ON checkout_sessions(customer_id);
ALTER TABLE owners
  ADD COLUMN shipping_config jsonb NOT NULL DEFAULT '{}'::jsonb;

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
  
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_customer_id_fkey'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_customer_id_fkey
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='products' AND column_name='name'
  ) THEN
    EXECUTE 'UPDATE products SET title = COALESCE(title, name) WHERE title IS NULL';
  END IF;
END $$;

-- scripts/migrations/2025-02-products-stock.sql
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_qty INTEGER NOT NULL DEFAULT 0;

UPDATE products
SET image_url = CASE
  WHEN LOWER(title) LIKE '%llave%'   THEN 'https://valeleebackend.onrender.com/img/cafeLaLlave.jpg'
  WHEN LOWER(title) LIKE '%bustelo%' THEN 'https://valeleebackend.onrender.com/img/cafeBustelo.jpg'
  WHEN LOWER(title) LIKE '%planta%'  THEN 'https://valeleebackend.onrender.com/img/planta.jpg'
  ELSE image_url
END
WHERE image_url IS NULL OR image_url = '';

-- opcional:
-- ALTER TABLE products DROP COLUMN IF EXISTS name;


COMMIT;
`;

async function run() {
  const client = await pool.connect()
  try {
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
