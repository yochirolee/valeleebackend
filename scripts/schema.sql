BEGIN;

-- 0) Extensiones (si en el futuro las necesitas)
-- CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1) Núcleo
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,                -- único (sensible a mayúsculas por defecto)
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
  name TEXT NOT NULL,
  image_url TEXT
);

CREATE TABLE IF NOT EXISTS owners (
  id SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,
  phone       TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  image_url TEXT,
  description TEXT,
  price NUMERIC(10, 2) NOT NULL,
  weight NUMERIC(10, 2),
  stock_qty INTEGER NOT NULL DEFAULT 0,
  category_id INTEGER REFERENCES categories(id),
  owner_id INTEGER REFERENCES owners(id) ON DELETE RESTRICT,
  metadata JSONB
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  owner_id INTEGER REFERENCES owners(id),
  customer_name TEXT,
  total NUMERIC(10, 2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  payment_method TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed BOOLEAN NOT NULL DEFAULT FALSE,
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

-- 2) Config envíos por owner (simple)
CREATE TABLE IF NOT EXISTS owner_shipping_config (
  id SERIAL PRIMARY KEY,
  owner_id INT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  country  CHAR(2) NOT NULL,                  -- 'US' o 'CU'
  mode     TEXT NOT NULL CHECK (mode IN ('fixed','weight')),
  currency CHAR(3) NOT NULL DEFAULT 'USD',

  -- US fijo
  us_flat NUMERIC(10,2),

  -- Cuba fijas
  cu_hab_city_flat    NUMERIC(10,2),
  cu_hab_rural_flat   NUMERIC(10,2),
  cu_other_city_flat  NUMERIC(10,2),
  cu_other_rural_flat NUMERIC(10,2),

  -- Cuba por peso
  cu_rate_per_lb      NUMERIC(10,2),
  cu_hab_city_base    NUMERIC(10,2),
  cu_hab_rural_base   NUMERIC(10,2),
  cu_other_city_base  NUMERIC(10,2),
  cu_other_rural_base NUMERIC(10,2),
  cu_min_fee          NUMERIC(10,2),

  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(owner_id, country)
);

-- Flags/ajustes adicionales
ALTER TABLE owner_shipping_config
  ADD COLUMN IF NOT EXISTS cu_restrict_to_list boolean DEFAULT false;

-- 3) Áreas Cuba por owner
CREATE TABLE IF NOT EXISTS owner_cu_areas (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  province TEXT NOT NULL,
  municipality TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4) Checkout sessions
CREATE TABLE IF NOT EXISTS checkout_sessions (
  id BIGSERIAL PRIMARY KEY,
  customer_id INT REFERENCES customers(id),
  cart_id     INT REFERENCES carts(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','expired')),
  amount_total NUMERIC(10,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  snapshot JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  payment  JSONB,
  payment_method TEXT,
  created_order_ids INT[] NOT NULL DEFAULT '{}'::int[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- 5) Eventos de entrega
CREATE TABLE IF NOT EXISTS delivery_events (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  client_tx_id TEXT NOT NULL,
  notes TEXT,
  photo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(order_id, client_tx_id)
);

-- ==========================================================
-- Asegurar compatibilidad con BD que ya existía (columnas/FKs)
-- ==========================================================

-- customers: unicidad case-insensitive (limpieza + índice único)
DO $$
BEGIN
  -- 1) Normaliza espacios
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='customers' AND column_name='email') THEN
    UPDATE customers SET email = trim(BOTH FROM email);
  END IF;

  -- 2) Elimina duplicados por lower(email), dejando el menor id
  IF EXISTS (
    SELECT 1 FROM customers GROUP BY lower(email) HAVING count(*) > 1
  ) THEN
    WITH ranked AS (
      SELECT id, lower(email) AS e, ROW_NUMBER() OVER (PARTITION BY lower(email) ORDER BY id) AS rn
      FROM customers
    )
    DELETE FROM customers c USING ranked r
    WHERE c.id = r.id AND r.rn > 1;
  END IF;

  -- 3) Crea el índice único si no existe
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'customers_email_lower_uk'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX customers_email_lower_uk ON customers ((lower(email)))';
  END IF;
END $$;

-- products: asegurar columnas si ya existía vieja
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS weight NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS metadata JSONB,
  ADD COLUMN IF NOT EXISTS owner_id INT,
  ADD COLUMN IF NOT EXISTS stock_qty INTEGER NOT NULL DEFAULT 0;

-- CHECK para stock_qty >= 0 (compatible con distintas versiones)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_qty_nonnegative'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT stock_qty_nonnegative CHECK (stock_qty >= 0);
  END IF;
END $$;

-- FK products.owner_id -> owners(id), solo si no existe ya
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
    WHERE t.relname = 'products' AND c.contype = 'f' AND a.attname = 'owner_id'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT fk_products_owner
      FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- orders: owner_id si faltara + FK
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS owner_id INT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
    WHERE t.relname = 'orders' AND c.contype = 'f' AND a.attname = 'owner_id'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_owner_id_fkey
      FOREIGN KEY (owner_id) REFERENCES owners(id);
  END IF;
END $$;

-- owner_cu_areas: por si existía sin owner_id + FK
ALTER TABLE owner_cu_areas
  ADD COLUMN IF NOT EXISTS owner_id INT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
    WHERE t.relname = 'owner_cu_areas' AND c.contype = 'f' AND a.attname = 'owner_id'
  ) THEN
    ALTER TABLE owner_cu_areas
      ADD CONSTRAINT owner_cu_areas_owner_id_fkey
      FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE;
  END IF;
END $$;

-- owners: shipping_config si faltara
ALTER TABLE owners
  ADD COLUMN IF NOT EXISTS shipping_config jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS image_url TEXT;

-- (ya lo tenías, pero no molesta repetir)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS image_url TEXT;  

-- ==========================================================
-- Índices (crear al final para que ya existan todas las columnas)
-- ==========================================================

-- products
CREATE INDEX IF NOT EXISTS idx_products_owner    ON products(owner_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);

-- orders
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status      ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders (customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_owner       ON orders (owner_id);

-- line_items
CREATE INDEX IF NOT EXISTS idx_line_items_order   ON line_items (order_id);
CREATE INDEX IF NOT EXISTS idx_line_items_product ON line_items (product_id);

-- carts / cart_items
CREATE INDEX IF NOT EXISTS idx_carts_customer     ON carts(customer_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_cart    ON cart_items(cart_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_product ON cart_items(product_id);

-- owner_cu_areas
CREATE UNIQUE INDEX IF NOT EXISTS uniq_owner_cu_area
  ON owner_cu_areas(owner_id, lower(province), COALESCE(lower(municipality), ''));
CREATE INDEX IF NOT EXISTS idx_owner_cu_areas_owner_prov_mun
  ON owner_cu_areas (owner_id, lower(province), lower(COALESCE(municipality, '')));

-- checkout_sessions
CREATE INDEX IF NOT EXISTS idx_chk_sessions_cart     ON checkout_sessions(cart_id);
CREATE INDEX IF NOT EXISTS idx_chk_sessions_customer ON checkout_sessions(customer_id);

-- delivery_events
CREATE INDEX IF NOT EXISTS idx_delivery_events_order ON delivery_events(order_id);

-- customers (consultas por rol)
CREATE INDEX IF NOT EXISTS idx_customers_role
  ON customers ((metadata->>'role'));

-- === Migración: eliminar 'name' y quedarnos con 'title' ===

-- 1) Asegurar que 'title' exista (por si la tabla venía muy vieja)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS title TEXT;

-- 3) (Opcional pero recomendado) establece NOT NULL en 'title' si ya no quedan nulls
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='products' AND column_name='title'
  ) AND NOT EXISTS (
    SELECT 1 FROM products WHERE title IS NULL
  ) THEN
    ALTER TABLE products ALTER COLUMN title SET NOT NULL;
  END IF;
END $$;

COMMIT;
