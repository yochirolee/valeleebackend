BEGIN;

-- Categorías (ok, con upsert)
INSERT INTO categories (slug, name)
VALUES
  ('food', 'Food'),
  ('clothing', 'Clothing'),
  ('medicine', 'Medicine'),
  ('appliances', 'Appliances'),
  ('hygiene', 'Hygiene'),
  ('technology', 'Technology')
ON CONFLICT (slug) DO NOTHING;

-- Productos (usa title + image_url, y evita duplicados por title)
-- Cafe La Llave
INSERT INTO products (title, description, price, weight, category_id, image_url)
SELECT
  'Cafe La Llave',
  'Cafe La Llave',
  5.00,
  1.00,
  c.id,
  'https://valeleebackend.onrender.com/img/cafeLaLlave.jpg'
FROM categories c
WHERE c.slug = 'food'
  AND NOT EXISTS (SELECT 1 FROM products p WHERE p.title = 'Cafe La Llave');

-- Cafe Bustelo
INSERT INTO products (title, description, price, weight, category_id, image_url)
SELECT
  'Cafe Bustelo',
  'Cafe Bustelo',
  6.00,
  1.00,
  c.id,
  'https://valeleebackend.onrender.com/img/cafeBustelo.jpg'
FROM categories c
WHERE c.slug = 'food'
  AND NOT EXISTS (SELECT 1 FROM products p WHERE p.title = 'Cafe Bustelo');

-- Planta Electrica
INSERT INTO products (title, description, price, weight, category_id, image_url)
SELECT
  'Planta Electrica',
  'Planta Electrica',
  300.00,
  100.00,
  c.id,
  'https://valeleebackend.onrender.com/img/planta.jpg'
FROM categories c
WHERE c.slug = 'appliances'
  AND NOT EXISTS (SELECT 1 FROM products p WHERE p.title = 'Planta Electrica');

COMMIT;
