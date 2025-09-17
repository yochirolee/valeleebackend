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

CREATE TABLE IF NOT EXISTS pending_encargos (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NULL,
  asin VARCHAR(20) NULL,
  source_url TEXT NULL,
  title TEXT NULL,
  image_url TEXT NULL,
  price_estimate NUMERIC(12,2) NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- tabla de lotes de pago a owners
CREATE TABLE IF NOT EXISTS owner_payouts (
  id SERIAL PRIMARY KEY,
  owner_id INT NULL REFERENCES owners(id) ON DELETE SET NULL,
  from_date DATE NOT NULL,
  to_date   DATE NOT NULL,
  tz        TEXT NOT NULL DEFAULT 'America/New_York',
  delivered_only BOOLEAN NOT NULL DEFAULT true,
  orders_count INT NOT NULL DEFAULT 0,
  items_count  INT NOT NULL DEFAULT 0,
  base_cents BIGINT NOT NULL DEFAULT 0,
  shipping_owner_cents BIGINT NOT NULL DEFAULT 0,
  amount_to_owner_cents BIGINT NOT NULL DEFAULT 0, -- base + shipping
  margin_cents BIGINT NOT NULL DEFAULT 0,
  gateway_fee_cents BIGINT NOT NULL DEFAULT 0,
  created_by TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE pending_encargos
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'amazon',
  ADD COLUMN IF NOT EXISTS external_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS currency CHAR(3) DEFAULT 'USD'; 

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS owner_paid BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS owner_paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS owner_payout_id INT;

CREATE INDEX IF NOT EXISTS idx_orders_delivered_at ON orders (delivered_at DESC); 
CREATE INDEX IF NOT EXISTS idx_orders_owner_paid ON orders (owner_paid);
CREATE INDEX IF NOT EXISTS idx_orders_owner_payout_id ON orders (owner_payout_id);
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

-- =========================================
-- shipping_recipients (destinatarios guardados por cliente)
-- =========================================
CREATE TABLE IF NOT EXISTS shipping_recipients (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- comunes
  country CHAR(2) NOT NULL CHECK (country IN ('CU','US')),
  first_name TEXT NOT NULL,
  last_name  TEXT NOT NULL,
  phone      TEXT NOT NULL,
  email      TEXT,                 -- opcional
  instructions TEXT,               -- notas para el repartidor
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- etiquetas y notas de UI
  label TEXT,                      -- ej: "Casa de mamá", "Trabajo"
  notes TEXT,                      -- notas internas/cliente

  -- flag de default
  is_default BOOLEAN NOT NULL DEFAULT false,

  -- CU
  cu_province     TEXT,
  cu_municipality TEXT,
  cu_address      TEXT,            -- dirección exacta
  cu_ci           TEXT,            -- 11 dígitos
  cu_area_type    TEXT,            -- urbano/rural/habana/etc

  -- US
  us_address_line1 TEXT,
  us_address_line2 TEXT,
  us_city          TEXT,
  us_state         CHAR(2),
  us_zip           TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índices útiles
CREATE INDEX IF NOT EXISTS idx_recipients_customer
  ON shipping_recipients(customer_id);

CREATE INDEX IF NOT EXISTS idx_recipients_customer_country
  ON shipping_recipients(customer_id, country);

CREATE INDEX IF NOT EXISTS idx_recipients_default
  ON shipping_recipients(customer_id, is_default);

-- Garantiza UN solo default por cliente
CREATE UNIQUE INDEX IF NOT EXISTS ux_recipients_one_default_per_customer
  ON shipping_recipients(customer_id)
  WHERE is_default;

-- =========================================
-- Trigger actualizado updated_at
-- =========================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_shipping_recipients_updated_at'
  ) THEN
    CREATE TRIGGER trg_shipping_recipients_updated_at
      BEFORE UPDATE ON shipping_recipients
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- =========================================
-- Enforce: único is_default = true por cliente (auto-limpieza)
-- =========================================
CREATE OR REPLACE FUNCTION trg_enforce_single_default_recipient()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_default IS TRUE THEN
    UPDATE shipping_recipients
       SET is_default = FALSE
     WHERE customer_id = NEW.customer_id
       AND id <> COALESCE(NEW.id, 0)
       AND is_default = TRUE;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_shipping_recipients_single_default'
  ) THEN
    CREATE TRIGGER trg_shipping_recipients_single_default
      BEFORE INSERT OR UPDATE OF is_default ON shipping_recipients
      FOR EACH ROW EXECUTE FUNCTION trg_enforce_single_default_recipient();
  END IF;
END $$;

-- === Unicidad por combinación de campos normalizados ===
-- CU: mismo (first_name, last_name, ci, address, province, municipality) por customer
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='ux_recipient_cu_dedupe'
  ) THEN
    CREATE UNIQUE INDEX ux_recipient_cu_dedupe
      ON shipping_recipients (
        customer_id,
        country,
        lower(trim(first_name)),
        lower(trim(last_name)),
        -- address normalizado (espacios colapsados)
        regexp_replace(lower(trim(cu_address)), '\s+', ' ', 'g'),
        lower(trim(cu_province)),
        lower(trim(coalesce(cu_municipality, ''))),
        cu_ci
      )
      WHERE country = 'CU';
  END IF;
END $$;

-- US: mismo (first_name, last_name, address_line1, city, state, zip) por customer
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='ux_recipient_us_dedupe'
  ) THEN
    CREATE UNIQUE INDEX ux_recipient_us_dedupe
      ON shipping_recipients (
        customer_id,
        country,
        lower(trim(first_name)),
        lower(trim(last_name)),
        regexp_replace(lower(trim(us_address_line1)), '\s+', ' ', 'g'),
        lower(trim(us_city)),
        upper(trim(us_state)),
        regexp_replace(us_zip, '\D', '', 'g')  -- zip sin guiones/espacios
      )
      WHERE country = 'US';
  END IF;
END $$;


-- =========================================
-- Helper opcional (para uso manual desde app/SQL si lo necesitas)
-- =========================================
CREATE OR REPLACE FUNCTION set_unique_default_recipient(p_customer_id INT, p_recipient_id INT)
RETURNS VOID AS $$
BEGIN
  UPDATE shipping_recipients
     SET is_default = FALSE
   WHERE customer_id = p_customer_id
     AND id <> p_recipient_id
     AND is_default = TRUE;

  UPDATE shipping_recipients
     SET is_default = TRUE
   WHERE id = p_recipient_id
     AND customer_id = p_customer_id;
END; $$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='uniq_owner_payout_window'
  ) THEN
    CREATE UNIQUE INDEX uniq_owner_payout_window
      ON owner_payouts(owner_id, from_date, to_date);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_owner_payout_id_fkey'
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_owner_payout_id_fkey
      FOREIGN KEY (owner_payout_id) REFERENCES owner_payouts(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- 1) Agregar columnas si faltan
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- 2) Backfill seguro
UPDATE customers SET created_at = COALESCE(created_at, now());
UPDATE customers SET updated_at = COALESCE(updated_at, now());

-- 3) Defaults/constraints
ALTER TABLE customers
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN created_at SET NOT NULL;

ALTER TABLE customers
  ALTER COLUMN updated_at SET DEFAULT now();

-- 4) Trigger para mantener updated_at (re-usa tu set_updated_at())
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_customers_updated_at'
  ) THEN
    CREATE TRIGGER trg_customers_updated_at
      BEFORE UPDATE ON customers
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- 5) (Opcional) Índice para ORDER BY created_at
CREATE INDEX IF NOT EXISTS idx_customers_created_at
  ON customers (created_at DESC);

COMMIT;

BEGIN;

-- 1) owner_shipping_config: agregar columna de transporte para Cuba
ALTER TABLE owner_shipping_config
  ADD COLUMN IF NOT EXISTS cu_transport TEXT
    CHECK (cu_transport IN ('sea','air'));

-- 2) Quitar unicidad antigua (owner_id, country) para permitir dos filas CU (barco/avión)
DO $$
DECLARE cons TEXT;
BEGIN
  SELECT c.conname
    INTO cons
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  WHERE t.relname = 'owner_shipping_config'
    AND c.contype = 'u'
    AND pg_get_constraintdef(c.oid) LIKE '%(owner_id, country)%';
  IF cons IS NOT NULL THEN
    EXECUTE 'ALTER TABLE owner_shipping_config DROP CONSTRAINT '||quote_ident(cons);
  END IF;
END $$;

-- 3) Nueva unicidad: un registro por (owner, country, transporte/null)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='uniq_owner_country_transport'
  ) THEN
    CREATE UNIQUE INDEX uniq_owner_country_transport
      ON owner_shipping_config (owner_id, country, COALESCE(cu_transport, '_'));
  END IF;
END $$;

-- 4) Umbral y cargo extra para exceso de peso (por registro)
ALTER TABLE owner_shipping_config
  ADD COLUMN IF NOT EXISTS cu_over_weight_threshold_lbs NUMERIC(10,2) DEFAULT 100,
  ADD COLUMN IF NOT EXISTS cu_over_weight_fee NUMERIC(10,2) DEFAULT 0;

-- 5) Migración de datos: marcar CU existentes como 'sea' y duplicar a 'air'
--    (solo si aún no existen filas 'air')
WITH cu_base AS (
  SELECT *
  FROM owner_shipping_config
  WHERE country = 'CU' AND (cu_transport IS NULL OR cu_transport = 'sea')
)
UPDATE owner_shipping_config
   SET cu_transport = 'sea'
 WHERE country = 'CU' AND cu_transport IS NULL;

INSERT INTO owner_shipping_config (
  owner_id, country, mode, currency,
  us_flat,
  cu_hab_city_flat, cu_hab_rural_flat, cu_other_city_flat, cu_other_rural_flat,
  cu_rate_per_lb, cu_hab_city_base, cu_hab_rural_base, cu_other_city_base, cu_other_rural_base,
  cu_min_fee, active, created_at, cu_restrict_to_list, cu_transport,
  cu_over_weight_threshold_lbs, cu_over_weight_fee
)
SELECT
  owner_id, country, mode, currency,
  us_flat,
  cu_hab_city_flat, cu_hab_rural_flat, cu_other_city_flat, cu_other_rural_flat,
  cu_rate_per_lb, cu_hab_city_base, cu_hab_rural_base, cu_other_city_base, cu_other_rural_base,
  cu_min_fee, active, created_at, cu_restrict_to_list, 'air' AS cu_transport,
  cu_over_weight_threshold_lbs, cu_over_weight_fee
FROM owner_shipping_config s
WHERE s.country = 'CU' AND s.cu_transport = 'sea'
  AND NOT EXISTS (
    SELECT 1 FROM owner_shipping_config x
     WHERE x.owner_id = s.owner_id
       AND x.country = 'CU'
       AND x.cu_transport = 'air'
  );

COMMIT;
