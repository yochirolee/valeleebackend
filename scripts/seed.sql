BEGIN;

-- Categorías
INSERT INTO categories (slug, name)
VALUES
  ('food', 'Food'),
  ('appliances', 'Appliances')
ON CONFLICT (slug) DO NOTHING;

-- Productos
-- Cafe La Llave
INSERT INTO products (name, description, price, weight, category_id, metadata)
SELECT
  'Cafe La Llave',
  'Cafe La Llave',
  5.00,
  1.00,
  c.id,
  jsonb_build_object('image_url', 'http://localhost:4000/img/cafeLaLlave.jpg')
FROM categories c
WHERE c.slug = 'food'
AND NOT EXISTS (
  SELECT 1 FROM products p WHERE p.name = 'Cafe La Llave'
);

-- Cafe Bustelo
INSERT INTO products (name, description, price, weight, category_id, metadata)
SELECT
  'Cafe Bustelo',
  'Cafe Bustelo',
  6.00,
  1.00,
  c.id,
  jsonb_build_object('image_url', 'http://localhost:4000/img/cafeBustelo.jpg')
FROM categories c
WHERE c.slug = 'food'
AND NOT EXISTS (
  SELECT 1 FROM products p WHERE p.name = 'Cafe Bustelo'
);

-- Planta Electrica
INSERT INTO products (name, description, price, weight, category_id, metadata)
SELECT
  'Planta Electrica',
  'Planta Electrica',
  300.00,
  100.00,
  c.id,
  jsonb_build_object('image_url', 'http://localhost:4000/img/planta.jpg')
FROM categories c
WHERE c.slug = 'appliances'
AND NOT EXISTS (
  SELECT 1 FROM products p WHERE p.name = 'Planta Electrica'
);

COMMIT;
