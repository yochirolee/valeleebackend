const express = require('express')
require('dotenv').config()
const { pool } = require('./db')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const fs = require('fs')
const crypto = require('crypto');
const { sendPasswordResetEmail } = require('./helpers/resend');
const { ownersRouter, ownersPublicRouter } = require('./routes/owners');
const ownerAreasRouter = require('./routes/ownerAreas');
const shippingRouter = require('./routes/shipping');

const PORT = process.env.PORT || 4000
const HOST = process.env.HOST || '0.0.0.0'
const API_BASE_URL = process.env.API_BASE_URL || `http://${HOST}:${PORT}`

const SECRET = process.env.JWT_SECRET || 'secret'

const app = express()
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const path = require('path');

// Carpeta de uploads (misma que usa tu ruta de delivery)
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
// Crea la carpeta si no existe
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const cors = require('cors')

const originsFromEnv = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)

const allowedOrigins = ['http://localhost:3000', ...originsFromEnv]

const allowVercelPreviews = true
const isAllowed = (origin) => {
  if (!origin) return true
  if (allowedOrigins.includes(origin)) return true
  if (allowVercelPreviews && /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) return true
  return false
}

const corsOptions = {
  origin: process.env.NODE_ENV === 'production'
    ? (origin, cb) => isAllowed(origin) ? cb(null, true) : cb(new Error('Not allowed by CORS'))
    : true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}

app.use(cors(corsOptions))
app.use((req, res, next) => (req.method === 'OPTIONS' ? res.sendStatus(204) : next()))

app.use(express.json())

// crea directorios
for (const dir of ['img', 'cats']) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

app.use('/img', express.static('img'))
app.use('/cats', express.static('cats'))

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]
  if (!token) return res.sendStatus(401)
  jwt.verify(token, SECRET, (err, user) => {
    if (err) return res.sendStatus(403)
    req.user = user
    next()
  })
}

app.set('authenticateToken', authenticateToken);

app.get('/', (req, res) => {
  res.send('¡Tu backend con Express está funcionando! 🚀')
})

// checkout
const checkoutRoutes = require('./routes/checkout')
const paymentsRouter = require('./routes/payments')
// Protegida con authenticateToken, como ya haces con otras
app.use('/checkout', authenticateToken, checkoutRoutes)
// callback público (BMSpay no enviará tu token)
app.use('/payments', paymentsRouter)

// === Flujos nuevos (directo con tarjeta) — PREFIJOS NUEVOS ===
const checkoutDirectRoutes = require('./routes/checkout_direct');
const paymentsDirectRoutes = require('./routes/payments_direct');
app.use('/checkout-direct', checkoutDirectRoutes);   // POST /checkout-direct/start-direct
app.use('/payments-direct', paymentsDirectRoutes);

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean)

const requireAdmin = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT email, metadata FROM customers WHERE id = $1',
      [req.user.id]
    )
    if (!rows.length) return res.sendStatus(403)
    const email = (rows[0].email || '').toLowerCase()
    const role = rows[0].metadata?.role
    if (role === 'admin' || ADMIN_EMAILS.includes(email)) return next()
    return res.sendStatus(403)
  } catch {
    return res.sendStatus(403)
  }
}

async function isAdminUser(userId) {
  try {
    const { rows } = await pool.query(
      'SELECT email, metadata FROM customers WHERE id = $1',
      [userId]
    )
    if (!rows.length) return false
    const email = (rows[0].email || '').toLowerCase()
    const role = rows[0].metadata?.role
    return role === 'admin' || ADMIN_EMAILS.includes(email)
  } catch {
    return false
  }
}

async function getUserRoleAndOwnerId(userId) {
  try {
    const { rows } = await pool.query('SELECT metadata FROM customers WHERE id = $1 LIMIT 1', [userId])
    if (!rows.length) return { role: null, owner_id: null }
    const md = rows[0].metadata || {}
    return {
      role: md.role || null,
      owner_id: Number.isInteger(md.owner_id) ? md.owner_id : null
    }
  } catch {
    return { role: null, owner_id: null }
  }
}

async function requirePartnerOrAdmin(req, res, next) {
  try {
    const { role } = await getUserRoleAndOwnerId(req.user.id)
    if (role === 'admin' || role === 'owner' || role === 'delivery') return next()
    return res.sendStatus(403)
  } catch {
    return res.sendStatus(403)
  }
}


function zoneKeyForCuba(province, area_type) {
  const isHabana = String(province || '').trim().toLowerCase() === 'la habana';
  const isCity = (String(area_type || '').toLowerCase() === 'city');
  if (isHabana) return isCity ? 'habana_city' : 'habana_municipio';
  return isCity ? 'provincias_city' : 'provincias_municipio';
}

/* PRODUCTS */

// 🔎 Listar productos (oculta archivados salvo que se pida) + filtro por ubicación + lista blanca CU
app.get('/products', async (req, res) => {
  const {
    category_id,
    include_archived,
    country,
    province,
    area_type,
    municipality, // opcional (también aceptaremos "municipio" más abajo)
  } = req.query;

  try {
    const where = [];
    const params = [];

    // Archivados (comportamiento actual)
    if (!include_archived) {
      where.push(`COALESCE(
        CASE
          WHEN jsonb_typeof(metadata->'archived') = 'boolean'
            THEN (metadata->>'archived')::boolean
          WHEN jsonb_typeof(metadata->'archived') = 'string'
            THEN lower(metadata->>'archived') IN ('true','t','yes','1')
          ELSE false
        END
      , false) = false`);
    }

    if (category_id) {
      params.push(Number(category_id));
      where.push(`category_id = $${params.length}`);
    }

    // -------- Filtro por ubicación (opcional) --------
    const countryNorm = String(country || '').toUpperCase();
    const prov = String(province || '').trim();
    const mun = String(municipality || req.query.municipio || '').trim();

    if (countryNorm === 'US') {
      // Mostrar productos sin owner o con config US activa
      where.push(`
        (
          owner_id IS NULL
          OR EXISTS (
            SELECT 1 FROM owner_shipping_config osc
             WHERE osc.owner_id = products.owner_id
               AND osc.active = true
               AND osc.country = 'US'
          )
        )
      `);
    } else if (countryNorm === 'CU') {
      const zone = zoneKeyForCuba(prov, area_type);

      // columnas por zona (para validar que la config tenga algo para esa zona)
      let zoneFixedCol, zoneBaseCol;
      if (zone === 'habana_city') { zoneFixedCol = 'cu_hab_city_flat'; zoneBaseCol = 'cu_hab_city_base'; }
      else if (zone === 'habana_municipio') { zoneFixedCol = 'cu_hab_rural_flat'; zoneBaseCol = 'cu_hab_rural_base'; }
      else if (zone === 'provincias_city') { zoneFixedCol = 'cu_other_city_flat'; zoneBaseCol = 'cu_other_city_base'; }
      else if (zone === 'provincias_municipio') { zoneFixedCol = 'cu_other_rural_flat'; zoneBaseCol = 'cu_other_rural_base'; }

      const zoneClause = (zoneFixedCol && zoneBaseCol) ? `
        (
          (osc.mode = 'fixed'  AND osc.${zoneFixedCol} IS NOT NULL)
          OR
          (osc.mode <> 'fixed' AND (osc.cu_rate_per_lb IS NOT NULL OR osc.${zoneBaseCol} IS NOT NULL OR osc.cu_min_fee IS NOT NULL))
        )
      ` : `TRUE`;

      // Lista blanca: si osc.cu_restrict_to_list = true, debe existir fila en owner_cu_areas
      params.push(prov); const iProv = params.length;
      params.push(mun); const iMun = params.length;

      where.push(`
        (
          owner_id IS NULL
          OR EXISTS (
            SELECT 1 FROM owner_shipping_config osc
             WHERE osc.owner_id = products.owner_id
               AND osc.active = true
               AND osc.country = 'CU'
               AND ${zoneClause}
               AND (
                 -- si NO se restringe: pasa
                 COALESCE(osc.cu_restrict_to_list, false) = false
                 -- si se restringe: debe estar en la lista
                 OR EXISTS (
                   SELECT 1 FROM owner_cu_areas oa
                    WHERE oa.owner_id = products.owner_id
                      AND lower(oa.province) = lower($${iProv})
                      AND (oa.municipality IS NULL OR lower(oa.municipality) = lower($${iMun}))
                 )
               )
          )
        )
      `);
    }
    // -----------------------------------------------

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const sql = `
      WITH src AS (
        SELECT id, title, description, price, weight, category_id, image_url, metadata, stock_qty, owner_id
        FROM products
        ${whereSql}
      ),
      calc AS (
        SELECT
          *,
          COALESCE((metadata->>'price_cents')::int, ROUND(price*100)::int)                AS base_cents,
          COALESCE(NULLIF(metadata->>'margin_pct','')::numeric, 0)                        AS margin_pct,
          CASE
            WHEN jsonb_typeof(metadata->'taxable')='boolean' THEN (metadata->>'taxable')::boolean
            WHEN jsonb_typeof(metadata->'taxable')='string'  THEN lower(metadata->>'taxable') IN ('true','t','yes','1')
            ELSE true
          END                                                                              AS taxable,
          COALESCE(NULLIF(metadata->>'tax_pct','')::numeric, 0)                            AS tax_pct
        FROM src
      )
      SELECT
        id, title, description, price, weight, category_id, image_url, metadata, stock_qty, owner_id,
        ROUND(base_cents * (100 + margin_pct) / 100.0)::int                                AS price_with_margin_cents,
        CASE WHEN taxable
             THEN ROUND((base_cents * (100 + margin_pct) / 100.0) * tax_pct / 100.0)::int
             ELSE 0 END                                                                    AS tax_cents,
        (ROUND(base_cents * (100 + margin_pct) / 100.0)::int
          + CASE WHEN taxable
                 THEN ROUND((base_cents * (100 + margin_pct) / 100.0) * tax_pct / 100.0)::int
                 ELSE 0 END)                                                               AS display_total_cents,
        ROUND(
          (
            ROUND(base_cents * (100 + margin_pct) / 100.0)::numeric
            + CASE WHEN taxable
                   THEN ROUND((base_cents * (100 + margin_pct) / 100.0) * tax_pct / 100.0)::numeric
                   ELSE 0 END
          ) / 100.0
        , 2)                                                                               AS display_total_usd
      FROM calc
      ORDER BY id DESC;
    `;

    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).send('Error al obtener productos');
  }
});

// ===== BEST SELLERS (últimos N días, con filtros de ubicación) =====
app.get('/products/best-sellers', async (req, res) => {
  const {
    limit = '12',
    days = '60',
    country,
    province,
    area_type,
    municipality, // acepta municipality o municipio
  } = req.query;

  const lim = Math.min(48, Math.max(1, Number(limit) || 12));
  const lastDays = Math.min(365, Math.max(1, Number(days) || 60));

  try {
    const countryNorm = String(country || '').toUpperCase();
    const prov = String(province || '').trim();
    const mun = String(municipality || req.query.municipio || '').trim();

    // --- Reutiliza tus reglas de ubicación existentes ---
    let locationSql = 'TRUE';
    const params = [lastDays]; // $1 = lastDays

    if (countryNorm === 'US') {
      locationSql = `
        (
          p.owner_id IS NULL
          OR EXISTS (
            SELECT 1 FROM owner_shipping_config osc
             WHERE osc.owner_id = p.owner_id
               AND osc.active = true
               AND osc.country = 'US'
          )
        )
      `;
    } else if (countryNorm === 'CU') {
      // Usa tu helper global ya definido en index.js
      const zone = zoneKeyForCuba(prov, area_type);
      let zoneFixedCol, zoneBaseCol;
      if (zone === 'habana_city') { zoneFixedCol = 'cu_hab_city_flat'; zoneBaseCol = 'cu_hab_city_base'; }
      else if (zone === 'habana_municipio') { zoneFixedCol = 'cu_hab_rural_flat'; zoneBaseCol = 'cu_hab_rural_base'; }
      else if (zone === 'provincias_city') { zoneFixedCol = 'cu_other_city_flat'; zoneBaseCol = 'cu_other_city_base'; }
      else if (zone === 'provincias_municipio') { zoneFixedCol = 'cu_other_rural_flat'; zoneBaseCol = 'cu_other_rural_base'; }

      const zoneClause = (zoneFixedCol && zoneBaseCol) ? `
        (
          (osc.mode = 'fixed'  AND osc.${zoneFixedCol} IS NOT NULL)
          OR
          (osc.mode <> 'fixed' AND (osc.cu_rate_per_lb IS NOT NULL OR osc.${zoneBaseCol} IS NOT NULL OR osc.cu_min_fee IS NOT NULL))
        )
      ` : `TRUE`;

      params.push(prov); const iProv = params.length;   // $2
      params.push(mun); const iMun = params.length;   // $3

      locationSql = `
        (
          p.owner_id IS NULL
          OR EXISTS (
            SELECT 1 FROM owner_shipping_config osc
             WHERE osc.owner_id = p.owner_id
               AND osc.active = true
               AND osc.country = 'CU'
               AND ${zoneClause}
               AND (
                 COALESCE(osc.cu_restrict_to_list, false) = false
                 OR EXISTS (
                   SELECT 1 FROM owner_cu_areas oa
                    WHERE oa.owner_id = p.owner_id
                      AND lower(oa.province) = lower($${iProv})
                      AND (oa.municipality IS NULL OR lower(oa.municipality) = lower($${iMun}))
                 )
               )
          )
        )
      `;
    }

    // --- Query: suma cantidades vendidas en últimos N días ---
    const sql = `
      WITH recent AS (
        SELECT li.product_id, SUM(li.quantity)::int AS sold_qty
          FROM line_items li
          JOIN orders o ON o.id = li.order_id
         WHERE o.created_at >= NOW() - ($1::int * INTERVAL '1 day')    -- 👈 FIX intervalo parametrizado
           -- Opcional: si quieres solo órdenes pagadas/completadas, descomenta:
           -- AND o.status IN ('paid','completed','shipped')
         GROUP BY li.product_id
      ),
      src AS (
        SELECT p.id, p.title, p.description, p.price, p.weight, p.category_id, p.image_url, p.metadata, p.stock_qty,
               COALESCE(r.sold_qty, 0) AS sold_qty
          FROM products p
          LEFT JOIN recent r ON r.product_id = p.id
         WHERE COALESCE(
                 CASE
                   WHEN jsonb_typeof(p.metadata->'archived') = 'boolean' THEN (p.metadata->>'archived')::boolean
                   WHEN jsonb_typeof(p.metadata->'archived') = 'string'  THEN lower(p.metadata->>'archived') IN ('true','t','yes','1')
                   ELSE false
                 END
               , false) = false                                            -- 👈 excluye archivados
           AND ${locationSql}
      ),
      calc AS (
        SELECT
          *,
          COALESCE((metadata->>'price_cents')::int, ROUND(price*100)::int) AS base_cents,
          COALESCE(NULLIF(metadata->>'margin_pct','')::numeric, 0)          AS margin_pct
        FROM src
      )
      SELECT
        id, title, description, price, weight, category_id, image_url, metadata, stock_qty,
        sold_qty,
        ROUND(base_cents * (100 + margin_pct) / 100.0)::int AS price_with_margin_cents,
        ROUND(ROUND(base_cents * (100 + margin_pct) / 100.0) / 100.0, 2) AS price_with_margin_usd
      FROM calc
      ORDER BY sold_qty DESC, id DESC
      LIMIT ${lim};
    `;

    const { rows } = await pool.query(sql, params);
    return res.json(rows);
  } catch (e) {
    console.error('GET /products/best-sellers error', e);
    return res.status(500).json({ error: 'Error al obtener más vendidos' });
  }
});

// === SEARCH PRODUCTS (público) ===
app.get('/products/search', async (req, res) => {
  const {
    q = '',
    page = '1',
    limit = '12',
    country,
    province,
    area_type,
    municipality,
  } = req.query;

  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(48, Math.max(1, Number(limit) || 12));
  const off = (p - 1) * l;

  try {
    const countryNorm = String(country || '').toUpperCase();
    const prov = String(province || '').trim();
    const mun = String(municipality || req.query.municipio || '').trim();

    // --- Ubicación (igual que tus endpoints) ---
    let locationSql = 'TRUE';
    const params = [];
    const where = [];

    if (countryNorm === 'US') {
      locationSql = `
        (
          p.owner_id IS NULL
          OR EXISTS (
            SELECT 1 FROM owner_shipping_config osc
             WHERE osc.owner_id = p.owner_id
               AND osc.active = true
               AND osc.country = 'US'
          )
        )
      `;
    } else if (countryNorm === 'CU') {
      const zone = zoneKeyForCuba(prov, area_type);
      let zoneFixedCol, zoneBaseCol;
      if (zone === 'habana_city') { zoneFixedCol = 'cu_hab_city_flat'; zoneBaseCol = 'cu_hab_city_base'; }
      else if (zone === 'habana_municipio') { zoneFixedCol = 'cu_hab_rural_flat'; zoneBaseCol = 'cu_hab_rural_base'; }
      else if (zone === 'provincias_city') { zoneFixedCol = 'cu_other_city_flat'; zoneBaseCol = 'cu_other_city_base'; }
      else if (zone === 'provincias_municipio') { zoneFixedCol = 'cu_other_rural_flat'; zoneBaseCol = 'cu_other_rural_base'; }

      const zoneClause = (zoneFixedCol && zoneBaseCol) ? `
        (
          (osc.mode = 'fixed'  AND osc.${zoneFixedCol} IS NOT NULL)
          OR
          (osc.mode <> 'fixed' AND (osc.cu_rate_per_lb IS NOT NULL OR osc.${zoneBaseCol} IS NOT NULL OR osc.cu_min_fee IS NOT NULL))
        )
      ` : `TRUE`;

      params.push(prov); const iProv = params.length;
      params.push(mun); const iMun = params.length;

      locationSql = `
        (
          p.owner_id IS NULL
          OR EXISTS (
            SELECT 1 FROM owner_shipping_config osc
             WHERE osc.owner_id = p.owner_id
               AND osc.active = true
               AND osc.country = 'CU'
               AND ${zoneClause}
               AND (
                 COALESCE(osc.cu_restrict_to_list, false) = false
                 OR EXISTS (
                   SELECT 1 FROM owner_cu_areas oa
                    WHERE oa.owner_id = p.owner_id
                      AND lower(oa.province) = lower($${iProv})
                      AND (oa.municipality IS NULL OR lower(oa.municipality) = lower($${iMun}))
                 )
               )
          )
        )
      `;
    }

    // --- Texto (ILIKE seguro) ---
    const text = String(q).trim();
    if (text) {
      params.push(`%${text}%`); const i1 = params.length;
      params.push(`%${text}%`); const i2 = params.length;
      where.push(`(p.title ILIKE $${i1} OR p.description ILIKE $${i2})`);
    }

    // Excluir archivados
    where.push(`COALESCE(
      CASE
        WHEN jsonb_typeof(p.metadata->'archived')='boolean' THEN (p.metadata->>'archived')::boolean
        WHEN jsonb_typeof(p.metadata->'archived')='string'  THEN lower(p.metadata->>'archived') IN ('true','t','yes','1')
        ELSE false
      END
    ,false) = false`);

    where.push(locationSql);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // 👇 CAMBIO 1: pedimos uno extra (l + 1)
    const sql = `
      WITH src AS (
        SELECT
          p.id, p.title, p.description, p.price, p.weight, p.category_id,
          p.image_url, p.metadata, p.stock_qty
        FROM products p
        ${whereSql}
        ORDER BY p.id DESC
        LIMIT ${l + 1} OFFSET ${off}
      ),
      calc AS (
        SELECT
          *,
          COALESCE((metadata->>'price_cents')::int, ROUND(price*100)::int) AS base_cents,
          COALESCE(NULLIF(metadata->>'margin_pct','')::numeric, 0)          AS margin_pct
        FROM src
      )
      SELECT
        id, title, description, price, weight, category_id, image_url, metadata, stock_qty,
        ROUND(base_cents * (100 + margin_pct) / 100.0)::int AS price_with_margin_cents,
        ROUND(ROUND(base_cents * (100 + margin_pct) / 100.0) / 100.0, 2) AS price_with_margin_usd
      FROM calc;
    `;

    const { rows } = await pool.query(sql, params);

    // 👇 CAMBIO 2 y 3: detectar si hay más y recortar
    const has_more = rows.length > l;
    const items = has_more ? rows.slice(0, l) : rows;

    // 👇 devolvemos has_more
    res.json({ items, page: p, limit: l, has_more });
  } catch (e) {
    console.error('GET /products/search error', e);
    res.status(500).json({ error: 'Error buscando productos' });
  }
});

// GET by id
app.get('/products/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, description, price, weight, category_id, image_url, metadata, stock_qty, owner_id FROM products WHERE id = $1',
      [req.params.id]
    )
    if (!result.rows.length) return res.status(404).send('Producto no encontrado')
    res.json(result.rows[0])
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al obtener producto')
  }
})

// ➕ Crear producto (admin) — sanitizar metadata
app.post('/products', authenticateToken, requireAdmin, async (req, res) => {
  const { title, price, weight, category_id, image_url, description, stock_qty, owner_id } = req.body
  if (!title || price == null) return res.status(400).json({ error: 'title y price son requeridos' })

  const rawMeta = req.body?.metadata ?? {}
  const cleanMeta = {
    owner: typeof rawMeta.owner === 'string' ? rawMeta.owner.trim() : undefined,
    taxable: rawMeta.taxable === false ? false : true,
    tax_pct: Number.isFinite(rawMeta.tax_pct) ? Math.max(0, Math.min(30, Number(rawMeta.tax_pct))) : 0,

    margin_pct: Number.isFinite(rawMeta.margin_pct) ? Math.max(0, Number(rawMeta.margin_pct)) : 0,
    price_cents: Number.isInteger(rawMeta.price_cents) && rawMeta.price_cents >= 0 ? rawMeta.price_cents : undefined,

    // regla: si stock_qty <= 0 ⇒ archived=true; si >0 ⇒ archived=false
    archived: (Number(stock_qty) || 0) <= 0 ? true : false,
  }
  Object.keys(cleanMeta).forEach(k => cleanMeta[k] === undefined && delete cleanMeta[k])

  try {
    const result = await pool.query(
      `INSERT INTO products (title, description, price, weight, category_id, image_url, metadata, stock_qty, owner_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, title, description, price, weight, category_id, image_url, metadata, stock_qty, owner_id`,
      [
        String(title).trim(),
        description || null,
        price,
        weight || null,
        category_id || null,
        image_url || null,
        JSON.stringify(cleanMeta),
        Number.isInteger(Number(stock_qty)) ? Number(stock_qty) : 0,
        (Number.isInteger(Number(owner_id)) ? Number(owner_id) : null)
      ]
    )
    res.status(201).json(result.rows[0])
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al crear producto')
  }
})

// ✏️ Actualizar producto (admin) — MERGE JSONB + sanitizar metadata
app.put('/products/:id', authenticateToken, requireAdmin, async (req, res) => {
  const {
    title, price, weight, category_id, image_url, description, stock_qty, owner_id
  } = req.body;
  const rawMeta = req.body?.metadata ?? {};

  const cleanMeta = {
    owner: typeof rawMeta.owner === 'string' ? rawMeta.owner.trim() : undefined,
    taxable: rawMeta.taxable === false ? false : true,
    tax_pct: Number.isFinite(rawMeta.tax_pct) ? Math.max(0, Math.min(30, Number(rawMeta.tax_pct))) : 0,
    margin_pct: Number.isFinite(rawMeta.margin_pct) ? Math.max(0, Number(rawMeta.margin_pct)) : 0,
    price_cents: Number.isInteger(rawMeta.price_cents) && rawMeta.price_cents >= 0 ? rawMeta.price_cents : undefined,
    archived: (stock_qty == null) ? undefined : ((Number(stock_qty) || 0) <= 0),
  };
  Object.keys(cleanMeta).forEach(k => cleanMeta[k] === undefined && delete cleanMeta[k]);

  const stockInt = (stock_qty === '' || stock_qty == null) ? null : Number(stock_qty);
  const ownerInt = (owner_id === '' || owner_id == null) ? null : Number(owner_id);

  try {
    const q = `
      UPDATE products
         SET title       = COALESCE($1, title),
             description = COALESCE($2, description),
             price       = COALESCE($3, price),
             weight      = COALESCE($4, weight),
             category_id = COALESCE($5, category_id),
             image_url   = COALESCE($6, image_url),
             metadata    = COALESCE(metadata,'{}'::jsonb) || COALESCE($7::jsonb,'{}'::jsonb),
             stock_qty   = COALESCE($8::int, stock_qty),
             owner_id    = COALESCE($9::int, owner_id)
       WHERE id = $10::int
   RETURNING id, title, description, price, weight, category_id, image_url, metadata, stock_qty, owner_id
    `;
    const params = [
      title ?? null,
      description ?? null,
      price ?? null,
      weight ?? null,
      category_id ?? null,
      image_url ?? null,
      JSON.stringify(cleanMeta),
      stockInt,
      ownerInt,
      Number(req.params.id),
    ];

    const result = await pool.query(q, params);
    if (!result.rows.length) return res.status(404).send('Producto no encontrado');
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).send('Error al actualizar producto');
  }
});

// 🗑️ Eliminar producto (admin)
app.delete('/products/:id', authenticateToken, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    // ¿Está en órdenes? -> no borrar, mejor archivar
    const usedInOrders = await pool.query(
      'SELECT 1 FROM line_items WHERE product_id = $1 LIMIT 1',
      [id]
    );
    if (usedInOrders.rows.length) {
      return res.status(409).json({
        error: 'No se puede borrar: el producto está referenciado en órdenes.',
        suggestion: 'Archívalo en lugar de borrarlo (PATCH /products/:id con metadata: { archived: true }).'
      });
    }

    // Limpia carritos antes de borrar
    await pool.query('DELETE FROM cart_items WHERE product_id = $1', [id]);

    const result = await pool.query('DELETE FROM products WHERE id = $1 RETURNING id', [id]);
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /products error', e);
    if (e.code === '23503') {
      return res.status(409).json({
        error: 'No se puede borrar por restricciones de clave foránea.'
      });
    }
    res.status(500).json({ error: 'Error al eliminar producto' });
  }
});

// BORRAR/ARCHIVAR producto (admin)
app.delete('/admin/products/:id', authenticateToken, requireAdmin, async (req, res) => {
  const client = await pool.connect()
  const id = Number(req.params.id)

  try {
    await client.query('BEGIN')

    const prod = await client.query('SELECT id FROM products WHERE id = $1', [id])
    if (!prod.rows.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Producto no encontrado' })
    }

    // ¿aparece en órdenes? -> archivar
    const inOrders = await client.query(
      'SELECT 1 FROM line_items WHERE product_id = $1 LIMIT 1',
      [id]
    )
    if (inOrders.rowCount > 0) {
      await client.query(
        `UPDATE products
           SET metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('archived', true)
         WHERE id = $1`,
        [id]
      )
      await client.query('DELETE FROM cart_items WHERE product_id = $1', [id])
      await client.query('COMMIT')
      return res.json({ archived: true, id })
    }

    // si no está en órdenes, limpiar carritos y eliminar
    await client.query('DELETE FROM cart_items WHERE product_id = $1', [id])
    const del = await client.query('DELETE FROM products WHERE id = $1 RETURNING id', [id])

    await client.query('COMMIT')
    return res.json({ deleted: true, id: del.rows[0].id })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('DELETE /admin/products', e)
    return res.status(500).json({ error: 'Error al eliminar producto' })
  } finally {
    client.release()
  }
})


/* ORDERS */

// Listado general (admin)
app.get('/orders', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, c.email, c.first_name, c.last_name
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       ORDER BY o.created_at DESC`
    )
    res.json(result.rows)
  } catch {
    res.status(500).send('Error al obtener órdenes')
  }
})

// sólo autenticados, y además dueño o admin
app.get('/orders/:id', authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const { rows } = await pool.query(
      `SELECT 
         o.*,
         ow.id   AS owner_id_join,
         ow.name AS owner_name,
         ow.phone AS owner_phone,
         ow.email AS owner_email
       FROM orders o
       LEFT JOIN owners ow ON ow.id = o.owner_id
       WHERE o.id = $1
       LIMIT 1`,
      [id]
    )
    if (!rows.length) return res.status(404).send('Orden no encontrada')
    const row = rows[0]

    const isOwner = Number(row.customer_id) === Number(req.user.id)
    const isAdmin = await isAdminUser(req.user.id)
    if (!isOwner && !isAdmin) return res.sendStatus(403)

    // 🔹 Inserta objeto owner en la respuesta
    const order = {
      ...row,
      owner: row.owner_id_join ? {
        id: row.owner_id_join,
        name: row.owner_name || null,
        phone: row.owner_phone || null,
        whatsapp: row.owner_phone || null,
        email: row.owner_email || null,
      } : null
    }

    return res.json(order)
  } catch (e) {
    console.error(e)
    return res.status(500).send('Error al obtener orden')
  }
})

// Crear orden (admin si lo usas manualmente; checkout ya crea)
app.post('/orders', authenticateToken, requireAdmin, async (req, res) => {
  const { customer_id, customer_name, total, status, payment_method, metadata } = req.body
  try {
    const result = await pool.query(
      'INSERT INTO orders (customer_id, customer_name, total, status, payment_method, metadata) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [customer_id, customer_name, total, status, payment_method, metadata || {}]
    )
    res.status(201).json(result.rows[0])
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al crear la orden')
  }
})

// Actualizar orden (admin)
app.put('/orders/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { customer_name, total, status, metadata } = req.body
  try {
    const result = await pool.query(
      `UPDATE orders
         SET customer_name = COALESCE($1, customer_name),
             total = COALESCE($2, total),
             status = COALESCE($3, status),
             metadata = COALESCE(metadata,'{}'::jsonb) || COALESCE($4::jsonb,'{}'::jsonb)
       WHERE id = $5
       RETURNING *`,
      [customer_name, total, status, metadata ? JSON.stringify(metadata) : null, req.params.id]
    )
    if (!result.rows.length) return res.status(404).send('Orden no encontrada')
    res.json(result.rows[0])
  } catch {
    res.status(500).send('Error al actualizar orden')
  }
})

// Eliminar orden (admin)
app.delete('/orders/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM orders WHERE id = $1 RETURNING id', [req.params.id])
    if (!result.rows.length) return res.status(404).send('Orden no encontrada')
    res.json({ message: 'Orden eliminada' })
  } catch {
    res.status(500).send('Error al eliminar orden')
  }
})

app.get('/checkout-sessions/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const { rows } = await pool.query(
      `SELECT id, status, created_order_ids, snapshot, payment, processed_at
         FROM checkout_sessions
        WHERE id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, message: 'Sesión no encontrada' });
    const s = rows[0];
    return res.json({ ok: true, session: s });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || 'Error leyendo sesión' });
  }
});

// Detalle de una orden (cliente dueño o admin) con items + image_url
app.get('/orders/:id/detail', authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);

    // Cabecera
    const { rows: head } = await pool.query(
      `SELECT 
          o.*,
          c.email, c.first_name, c.last_name,
          ow.id   AS owner_id_join,
          ow.name AS owner_name,
          ow.phone AS owner_phone,
          ow.email AS owner_email
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN owners   ow ON ow.id = o.owner_id
        WHERE o.id = $1
        LIMIT 1
        `,
      [id]
    );
    if (!head.length) return res.status(404).send('Orden no encontrada');

    const order = head[0];

    // Dueño o admin
    const isOwner = Number(order.customer_id) === Number(req.user.id);
    const isAdmin = await isAdminUser(req.user.id);
    if (!isOwner && !isAdmin) return res.sendStatus(403);

    // Items (con imagen)
    const { rows: items } = await pool.query(
      `SELECT
         li.product_id,
         p.title  AS product_name,
         p.image_url,
         li.quantity,
         li.unit_price
       FROM line_items li
       LEFT JOIN products p ON p.id = li.product_id
      WHERE li.order_id = $1
      ORDER BY li.id ASC`,
      [id]
    );

    return res.json({
      order: {
        id: order.id,
        created_at: order.created_at,
        status: order.status,
        payment_method: order.payment_method,
        metadata: order.metadata || {},
        owner: order.owner_id_join ? {
          id: order.owner_id_join,
          name: order.owner_name || null,
          phone: order.owner_phone || null,
          whatsapp: order.owner_phone || null,
          email: order.owner_email || null,
        } : null,
      },
      items: items.map(it => ({
        product_id: it.product_id,
        product_name: it.product_name || undefined,
        image_url: it.image_url || null,
        quantity: Number(it.quantity),
        unit_price: Number(it.unit_price),
      })),
    });
  } catch (e) {
    console.error('GET /orders/:id/detail error', e);
    return res.status(500).send('Error al obtener detalle de orden');
  }
});

// ADMIN ORDERS

// 👇 Details de órdenes para el panel admin
// % fee de tarjeta leída del backend (no del front)
const CARD_FEE_PCT_BACK = Number(process.env.CARD_FEE_PCT ?? '3');
const CARD_FEE_RATE = Number.isFinite(CARD_FEE_PCT_BACK) ? CARD_FEE_PCT_BACK / 100 : 0;

app.get('/admin/orders', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const {
      page = '1',
      limit = '20',
      sort_by = 'created_at',    // 'created_at' | 'id' | 'status' | 'total' | 'total_calc'
      sort_dir = 'desc',         // 'asc' | 'desc'
      q = '',                    // email/nombre parcial o id exacto
      status,
      payment_method,
      from,                      // YYYY-MM-DD
      to                         // YYYY-MM-DD
    } = req.query;

    const p = Math.max(1, Number(page) || 1);
    const l = Math.min(100, Math.max(1, Number(limit) || 20));
    const off = (p - 1) * l;

    const allowedSort = {
      created_at: 'created_at',
      id: 'id',
      status: 'status',
      total: 'base_total',       // ordenaremos por el total base calculado
      total_calc: 'subtotal',    // aproximación
    };
    const sortCol = allowedSort[String(sort_by)] || 'created_at';
    const dir = String(sort_dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const where = [];
    const vals = [];

    if (status) { vals.push(String(status)); where.push(`o.status = $${vals.length}`); }
    if (payment_method) { vals.push(String(payment_method)); where.push(`o.payment_method = $${vals.length}`); }
    const isDateOnly = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

    if (from) {
      const s = String(from);
      if (isDateOnly(s)) {
        vals.push(s);
        where.push(`o.created_at >= $${vals.length}::date`);
      } else {
        const d = new Date(s);
        if (!isNaN(d.getTime())) {
          vals.push(d);
          where.push(`o.created_at >= $${vals.length}`);
        }
      }
    }

    if (to) {
      const s = String(to);
      if (isDateOnly(s)) {
        vals.push(s);
        // < (to + 1 día) ⇒ incluye TODO el día "to"
        where.push(`o.created_at < ($${vals.length}::date + INTERVAL '1 day')`);
      } else {
        const d = new Date(s);
        if (!isNaN(d.getTime())) {
          vals.push(d);
          where.push(`o.created_at <= $${vals.length}`);
        }
      }
    }

    if (q) {
      const like = `%${q}%`;
      const isNum = Number.isFinite(Number(q));
      if (isNum) {
        vals.push(like, like, Number(q));
        const i1 = vals.length - 2, i2 = vals.length - 1, i3 = vals.length;
        where.push(`(c.email ILIKE $${i1} OR (COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) ILIKE $${i2} OR o.id = $${i3})`);
      } else {
        vals.push(like, like);
        const i1 = vals.length - 1, i2 = vals.length;
        where.push(`(c.email ILIKE $${i1} OR (COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) ILIKE $${i2})`);
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // CTE agrega line_items + snapshot de pricing si existe en metadata
    const sql = `
      WITH agg AS (
        SELECT
          o.id,
          o.created_at,
          o.status,
          o.payment_method,
          o.total::numeric AS total_col,                 -- por compatibilidad
          o.metadata,
          o.customer_id,
          c.email,
          c.first_name,
          c.last_name,

          -- suma line_items como "subtotal calculado"
          COALESCE(SUM(li.quantity * li.unit_price), 0)::numeric AS subtotal_calc,
          COUNT(li.id)::int AS items_count,

          -- snapshot si existe
          NULLIF((o.metadata->'pricing'->>'subtotal')::numeric, NULL) AS snap_subtotal,
          NULLIF((o.metadata->'pricing'->>'tax')::numeric, NULL)       AS snap_tax,
          NULLIF((o.metadata->'pricing'->>'total')::numeric, NULL)     AS snap_total

        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN line_items li ON li.order_id = o.id
        ${whereSql}
        GROUP BY o.id, c.email, c.first_name, c.last_name
      )
      SELECT *,
             COUNT(*) OVER() AS total_rows
      FROM agg
      ORDER BY ${sortCol} ${dir}
      LIMIT ${l} OFFSET ${off};
    `;

    const { rows } = await pool.query(sql, vals);
    const total = rows[0]?.total_rows ? Number(rows[0].total_rows) : 0;

    // Normalizamos y calculamos campos numéricos finales
    const items = rows.map(r => {
      const subtotal = Number(r.snap_subtotal ?? r.subtotal_calc ?? 0);
      const tax = Number(r.snap_tax ?? 0);

      // Preferencia para "base_total" (sin fee):
      // 1) snapshot total
      // 2) subtotal + tax
      // 3) columna orders.total
      // 4) subtotal_calc (fallback)
      const base_total =
        Number(
          (r.snap_total != null ? r.snap_total
            : (subtotal + tax) || r.total_col || r.subtotal_calc
          ) || 0
        );

      const card_fee = Math.round((base_total * CARD_FEE_RATE) * 100) / 100;
      const total_with_fee = Math.round((base_total + card_fee) * 100) / 100;

      return {
        id: r.id,
        created_at: r.created_at,
        status: r.status,
        payment_method: r.payment_method,
        customer_id: r.customer_id,
        email: r.email,
        first_name: r.first_name,
        last_name: r.last_name,
        items_count: Number(r.items_count || 0),

        // 👇 números listos para el front
        subtotal: Number.isFinite(subtotal) ? subtotal : 0,
        tax: Number.isFinite(tax) ? tax : 0,
        base_total: Number.isFinite(base_total) ? base_total : 0,
        card_fee,
        total_with_fee,
      };
    });

    res.json({
      items,
      page: p,
      pages: Math.max(1, Math.ceil(total / l)),
      total,
      limit: l,
      fee_pct: CARD_FEE_PCT_BACK,
    });
  } catch (e) {
    console.error('GET /admin/orders error:', e);
    res.status(500).send('Error al listar órdenes (admin)');
  }
});

// 🔎 Detalle de una orden (admin)
app.get('/admin/orders/:id/detail', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);

    // Cabecera + cliente
    const headQ = `
          SELECT 
            o.id, o.created_at, o.status, o.payment_method, o.total, o.metadata,
            o.customer_id, c.email, c.first_name, c.last_name, c.phone, c.address
          FROM orders o
          LEFT JOIN customers c ON c.id = o.customer_id
          WHERE o.id = $1
          LIMIT 1
        `;
    const { rows: headRows } = await pool.query(headQ, [id]);
    if (!headRows.length) return res.status(404).send('Orden no encontrada');

    const o = headRows[0];

    // Ítems (con nombres/imágenes de productos)
    const { rows: itemRows } = await pool.query(`
      SELECT
        li.product_id,
        p.title AS product_name,
        p.image_url,
        li.quantity,
        li.unit_price
      FROM line_items li
      LEFT JOIN products p ON p.id = li.product_id
      WHERE li.order_id = $1
      ORDER BY li.id ASC
    `, [id]);

    // Cálculos numéricos seguros
    const subtotalCalc = itemRows.reduce(
      (acc, it) => acc + Number(it.quantity) * Number(it.unit_price),
      0
    );

    // Snapshots guardados en metadata (si existen)
    const snapSubtotal = Number(o.metadata?.pricing?.subtotal ?? o.metadata?.payment?.subtotal);
    const snapTax = Number(o.metadata?.pricing?.tax ?? o.metadata?.payment?.tax);
    const snapTotal = Number(o.metadata?.pricing?.total);

    const subtotal = Number.isFinite(snapSubtotal) ? snapSubtotal : subtotalCalc;
    const tax = Number.isFinite(snapTax) ? snapTax : 0;

    // total base (sin fee): preferimos snapshot; si no, subtotal+tax; si no, columna total; si no, subtotalCalc
    let base_total;
    if (Number.isFinite(snapTotal)) base_total = snapTotal;
    else if (Number.isFinite(subtotal + tax)) base_total = subtotal + tax;
    else if (Number.isFinite(Number(o.total))) base_total = Number(o.total);
    else base_total = subtotalCalc;

    const card_fee = Math.round(base_total * CARD_FEE_RATE * 100) / 100;
    const total_with_fee = Math.round((base_total + card_fee) * 100) / 100;

    res.json({
      order: {
        id: o.id,
        created_at: o.created_at,
        status: o.status,
        payment_method: o.payment_method,
        customer: {
          id: o.customer_id,
          email: o.email || null,
          name: [o.first_name, o.last_name].filter(Boolean).join(' ') || null,
          phone: o.phone || null,
          address: o.address || null,
        },
        pricing: { subtotal, tax, total: base_total }, // "total" aquí = base_total (sin fee)
        card_fee_pct: CARD_FEE_PCT_BACK,
        card_fee,
        total_with_fee,
        metadata: o.metadata || {},
      },
      items: itemRows.map(it => ({
        product_id: it.product_id,
        product_name: it.product_name || undefined,
        image_url: it.image_url || null,
        quantity: Number(it.quantity),
        unit_price: Number(it.unit_price),
      })),
    });
  } catch (e) {
    console.error('GET /admin/orders/:id/detail', e);
    res.status(500).send('Error al obtener detalle de orden');
  }
});

// 👇 Cambiar solo el estado de una orden
app.patch('/admin/orders/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params
  const { status } = req.body
  if (!status) return res.status(400).json({ error: 'status requerido' })

  try {
    const upd = await pool.query(
      `UPDATE orders SET status = $1 WHERE id = $2 RETURNING id, created_at, status, payment_method, total`,
      [status, id]
    )
    if (!upd.rows.length) return res.status(404).send('Orden no encontrada')

    const agg = await pool.query(
      `SELECT COUNT(*)::int AS items_count,
              COALESCE(SUM(quantity*unit_price),0) AS total_calc
         FROM line_items
        WHERE order_id = $1`,
      [id]
    )

    res.json({ ...upd.rows[0], ...agg.rows[0] })
  } catch (e) {
    console.error(e)
    res.status(500).send('Error al actualizar estado')
  }
})

// GET /admin/products?q=&category_id=&owner_id=&archived=(true|false|all)&page=1&limit=12
app.get('/admin/products', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { q = '', page = '1', limit = '12', category_id, owner_id, archived = 'all' } = req.query

    const p = Math.max(1, Number(page) || 1)
    const l = Math.min(100, Math.max(1, Number(limit) || 12))
    const off = (p - 1) * l

    const where = []
    const vals = []

    if (q) {
      vals.push(`%${q}%`)
      where.push(`title ILIKE $${vals.length}`)
    }
    if (category_id) {
      vals.push(Number(category_id))
      where.push(`category_id = $${vals.length}`)
    }
    // NUEVO: filtro real por owner_id
    if (owner_id != null && owner_id !== '' && !Number.isNaN(Number(owner_id))) {
      vals.push(Number(owner_id))
      where.push(`owner_id = $${vals.length}`)
    }

    if (archived === 'true') {
      where.push(`COALESCE((metadata->>'archived')::boolean, false) = true`)
    } else if (archived === 'false') {
      where.push(`COALESCE((metadata->>'archived')::boolean, false) = false`)
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const sql = `
      SELECT
        id, title, description, price, weight, category_id, image_url, metadata, stock_qty, owner_id,
        COUNT(*) OVER() AS total
      FROM products
      ${whereSql}
      ORDER BY id DESC
      LIMIT ${l} OFFSET ${off}
    `
    const r = await pool.query(sql, vals)
    const total = r.rows[0]?.total ? Number(r.rows[0].total) : 0

    res.json({
      items: r.rows.map(({ total, ...row }) => row),
      page: p,
      limit: l,
      total,
      pages: Math.max(1, Math.ceil(total / l)),
    })
  } catch (e) {
    console.error(e)
    res.status(500).send('Error al listar productos')
  }
})

//ADMIN OWNER DELIVERY
app.get('/partner/orders', authenticateToken, requirePartnerOrAdmin, async (req, res) => {
  try {
    const { role, owner_id } = await getUserRoleAndOwnerId(req.user.id)
    const userId = req.user.id

    const { status = 'paid', scope = 'mine', page = '1', limit = '20' } = req.query
    const p = Math.max(1, Number(page) || 1)
    const l = Math.min(100, Math.max(1, Number(limit) || 20))
    const off = (p - 1) * l

    const vals = []
    const where = []

    const allowedStatus = new Set(['paid', 'shipped', 'delivered'])
    const st = allowedStatus.has(String(status)) ? String(status) : 'paid'
    vals.push(st); where.push(`o.status = $${vals.length}`)

    if (role === 'owner') {
      if (!owner_id) return res.status(403).json({ error: 'Owner no asignado' })
      vals.push(owner_id); where.push(`o.owner_id = $${vals.length}`)
    } else if (role === 'delivery') {
      if (scope === 'available') {
        // No asignadas
        where.push(`(o.metadata->>'delivery_assignee_id') IS NULL`)
      } else {
        // Mis asignadas
        vals.push(String(userId))
        where.push(`(o.metadata->>'delivery_assignee_id') = $${vals.length}`)
      }
    } // admin: sin filtro extra (o podrías aceptar ?owner_id=...)

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const sql = `
      WITH agg AS (
        SELECT o.id, o.created_at, o.status, o.payment_method, o.total, o.metadata,
               o.customer_id, o.owner_id,
               c.email AS customer_email, c.first_name, c.last_name,
               COUNT(*) OVER() AS total_rows
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        ${whereSql}
        ORDER BY o.created_at DESC
        LIMIT ${l} OFFSET ${off}
      )
      SELECT * FROM agg;
    `
    const { rows } = await pool.query(sql, vals)
    const total = rows[0]?.total_rows ? Number(rows[0].total_rows) : 0

    res.json({
      items: rows.map(({ total_rows, ...r }) => r),
      page: p,
      pages: Math.max(1, Math.ceil(total / l)),
      total,
      limit: l
    })
  } catch (e) {
    console.error('GET /partner/orders', e)
    res.status(500).json({ error: 'Error al listar órdenes' })
  }
})

app.patch('/partner/orders/:id/assign', authenticateToken, requirePartnerOrAdmin, async (req, res) => {
  const id = Number(req.params.id)
  const { action } = req.body || {}
  const userId = req.user.id

  const { role } = await getUserRoleAndOwnerId(userId)
  if (role !== 'delivery' && role !== 'admin') {
    return res.status(403).json({ error: 'Solo delivery o admin' })
  }

  const { rows } = await pool.query(`SELECT id, status, metadata FROM orders WHERE id = $1 LIMIT 1`, [id])
  if (!rows.length) return res.status(404).json({ error: 'Orden no encontrada' })
  const ord = rows[0]
  const md = ord.metadata || {}

  if (action === 'take') {
    if (md.delivery_assignee_id && Number(md.delivery_assignee_id) !== Number(userId)) {
      return res.status(409).json({ error: 'Orden ya asignada a otro repartidor' })
    }
    const me = await pool.query(`SELECT email, first_name, last_name FROM customers WHERE id = $1`, [userId])
    const name = [me.rows[0]?.first_name, me.rows[0]?.last_name].filter(Boolean).join(' ') || null
    const email = me.rows[0]?.email || null

    const upd = await pool.query(
      `UPDATE orders
          SET metadata = COALESCE(metadata,'{}'::jsonb)
                        || jsonb_build_object(
                             'delivery_assignee_id', $1::text,
                             'delivery_assignee_name', $2::text,
                             'delivery_assignee_email', $3::text
                           )
        WHERE id = $4
        RETURNING id, metadata`,
      [String(userId), name, email, id]
    )
    return res.json({ ok: true, id: upd.rows[0].id, metadata: upd.rows[0].metadata })
  }

  if (action === 'release') {
    if (!md.delivery_assignee_id) return res.json({ ok: true, id, metadata: md })
    if (role === 'delivery' && String(md.delivery_assignee_id) !== String(userId)) {
      return res.status(403).json({ error: 'No puedes liberar una orden que no es tuya' })
    }
    const upd = await pool.query(
      `UPDATE orders
          SET metadata = (COALESCE(metadata,'{}'::jsonb)
                           - 'delivery_assignee_id' - 'delivery_assignee_name' - 'delivery_assignee_email')
        WHERE id = $1
        RETURNING id, metadata`,
      [id]
    )
    return res.json({ ok: true, id: upd.rows[0].id, metadata: upd.rows[0].metadata })
  }

  return res.status(400).json({ error: 'Acción inválida' })
})

app.patch('/partner/orders/:id/status', authenticateToken, requirePartnerOrAdmin, async (req, res) => {
  const id = Number(req.params.id)
  const nextStatus = String(req.body?.status || '')
  const userId = req.user.id

  const { role, owner_id } = await getUserRoleAndOwnerId(userId)
  const allowed = new Set(['shipped', 'delivered'])
  if (!allowed.has(nextStatus)) return res.status(400).json({ error: 'Estado inválido' })

  const { rows } = await pool.query(`SELECT id, owner_id, status, metadata FROM orders WHERE id=$1 LIMIT 1`, [id])
  if (!rows.length) return res.status(404).json({ error: 'Orden no encontrada' })
  const ord = rows[0]
  const md = ord.metadata || {}
  const current = String(ord.status)

  // Autorización contextual
  if (role === 'owner') {
    if (!owner_id || Number(ord.owner_id) !== Number(owner_id)) return res.status(403).json({ error: 'No autorizado' })
    // Por defecto: owner puede paid→shipped (y opcionalmente shipped→delivered si quieres permitirlo)
    if (nextStatus === 'shipped' && current !== 'paid') return res.status(409).json({ error: 'Solo puedes marcar shipped si está paid' })
    // Si NO quieres que el owner marque delivered, descomenta:
    // if (nextStatus === 'delivered') return res.status(403).json({ error: 'Owner no puede marcar delivered' })
  } else if (role === 'delivery') {
    // Debe estar asignada a este repartidor
    if (String(md.delivery_assignee_id || '') !== String(userId)) {
      return res.status(403).json({ error: 'Orden no asignada a ti' })
    }
    // Delivery puede paid→shipped (cuando recoge) y shipped→delivered (cuando entrega)
    if (nextStatus === 'shipped' && current !== 'paid') return res.status(409).json({ error: 'Para marcar shipped debe estar en paid' })
    if (nextStatus === 'delivered' && current !== 'shipped') return res.status(409).json({ error: 'Para marcar delivered debe estar en shipped' })
  } // admin: todo permitido

  const nowISO = new Date().toISOString()
  const timeKey = nextStatus === 'shipped' ? 'shipped_at' : 'delivered_at'

  const upd = await pool.query(
    `UPDATE orders
        SET status = $1,
            metadata = COALESCE(metadata,'{}'::jsonb)
                       || jsonb_build_object(
                            'status_times',
                            COALESCE(metadata->'status_times','{}'::jsonb) || jsonb_build_object($2::text, $3::text)
                          )
                       || CASE WHEN $1 = 'delivered' THEN
                            jsonb_build_object(
                              'delivery',
                              COALESCE(metadata->'delivery','{}'::jsonb) ||
                              jsonb_build_object('delivered', true, 'delivered_at', $3::text)
                            )
                          ELSE '{}'::jsonb END
      WHERE id = $4
      RETURNING id, status, metadata, created_at`,
    [nextStatus, timeKey, nowISO, id]
  )

  return res.json({ ok: true, ...upd.rows[0] })
})

// === ADMIN: asignar rol y (opcional) owner_id a un cliente ===
// PATCH /admin/customers/:id/role-owner
// body: { role?: 'admin'|'owner'|'delivery'|''|null, owner_id?: number|null }
app.patch('/admin/customers/:id/role-owner', authenticateToken, requireAdmin, async (req, res) => {
  const id = Number(req.params.id)
  let { role, owner_id } = req.body || {}

  // Normaliza inputs
  if (role === '') role = null
  if (role === 'mensajero') role = 'delivery' // compat
  if (owner_id === '' || owner_id === undefined) owner_id = null
  if (owner_id != null && !Number.isInteger(Number(owner_id))) {
    return res.status(400).json({ error: 'owner_id inválido' })
  }

  try {
    // Lee estado previo (para decidir limpieza adicional)
    const prev = await pool.query(
      `SELECT id, email, first_name, last_name, metadata FROM customers WHERE id = $1 LIMIT 1`,
      [id]
    )
    if (!prev.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' })
    const prevMd = prev.rows[0].metadata || {}
    const prevRole = prevMd.role || null

    // Valida owner_id si viene
    if (owner_id != null) {
      const chk = await pool.query('SELECT 1 FROM owners WHERE id = $1', [owner_id])
      if (!chk.rows.length) return res.status(404).json({ error: 'Owner no encontrado' })
    }

    // Si el nuevo role es "sin rol" ⇒ limpiar claves y desasignar órdenes (si tuviera)
    if (role == null) {
      await pool.query('BEGIN')

      // 1) Limpia role/owner_id del cliente
      const upd = await pool.query(
        `UPDATE customers
            SET metadata = (COALESCE(metadata,'{}'::jsonb) - 'role' - 'owner_id')
          WHERE id = $1
        RETURNING id, email, first_name, last_name, metadata`,
        [id]
      )

      // 2) Si antes era delivery **o owner**, desasignar sus órdenes no entregadas
      if (String(prevRole) === 'delivery' || String(prevRole) === 'owner') {
        await pool.query(
          `UPDATE orders
              SET metadata = (COALESCE(metadata,'{}'::jsonb)
                               - 'delivery_assignee_id'
                               - 'delivery_assignee_name'
                               - 'delivery_assignee_email')
            WHERE (metadata->>'delivery_assignee_id') = $1
              AND status <> 'delivered'`,
          [String(id)]
        )
      }

      await pool.query('COMMIT')
      return res.json(upd.rows[0])
    }

    // Para roles válidos (admin | owner | delivery): fusiona valores
    if (!['admin', 'owner', 'delivery'].includes(String(role))) {
      return res.status(400).json({ error: 'Rol inválido' })
    }

    const patch = {
      role,
      // Para owner|delivery puedes guardar owner_id; para admin normalmente null
      owner_id: owner_id ?? null,
    }

    const upd = await pool.query(
      `UPDATE customers
          SET metadata = COALESCE(metadata,'{}'::jsonb) || $1::jsonb
        WHERE id = $2
      RETURNING id, email, first_name, last_name, metadata`,
      [JSON.stringify(patch), id]
    )

    return res.json(upd.rows[0])
  } catch (e) {
    try { await pool.query('ROLLBACK') } catch { }
    console.error('PATCH /admin/customers/:id/role-owner', e)
    return res.status(500).json({ error: 'No se pudo actualizar role/owner_id' })
  }
})

/* CUSTOMERS */

app.post('/customers', async (req, res) => {
  const { email, password, first_name, last_name, phone, address } = req.body
  if (!email || !password) return res.status(400).json({ error: 'Faltan campos requeridos' })

  try {
    const emailNorm = String(email).trim().toLowerCase()
    const hashedPassword = await bcrypt.hash(password, 10)

    const { rows } = await pool.query(
      `INSERT INTO customers (email, password, first_name, last_name, phone, address)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, first_name, last_name, phone, address, metadata`,
      [emailNorm, hashedPassword, first_name || null, last_name || null, phone || null, address || null]
    )

    res.status(201).json(rows[0])
  } catch (error) {
    if (error && error.code === '23505') {
      return res.status(409).json({ error: 'El email ya está registrado' })
    }
    console.error(error)
    res.status(500).json({ error: 'Error al crear el cliente' })
  }
})

app.get('/customers', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM customers')
    res.json(result.rows)
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al obtener los clientes')
  }
})

// Ruta protegida para obtener el cliente autenticado
app.get('/customers/me', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, first_name, last_name, phone, address, metadata FROM customers WHERE id = $1',
      [req.user.id]
    )
    if (!rows.length) return res.status(404).send('Cliente no encontrado')
    res.json(rows[0])
  } catch (e) {
    console.error(e)
    res.status(500).send('Error al obtener el cliente')
  }
})

app.get('/customers/:id', async (req, res) => {
  const { id } = req.params
  try {
    const result = await pool.query('SELECT * FROM customers WHERE id = $1', [id])
    if (!result.rows.length) return res.status(404).send('Cliente no encontrado')
    res.json(result.rows[0])
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al obtener el cliente')
  }
})

app.put('/customers/:id', async (req, res) => {
  const { id } = req.params
  const { name, email, address, payment_method, metadata } = req.body
  try {
    const result = await pool.query(
      `UPDATE customers
         SET name=$1, email=$2, address=$3, payment_method=$4,
             metadata = COALESCE(metadata,'{}'::jsonb) || COALESCE($5::jsonb,'{}'::jsonb)
       WHERE id=$6 RETURNING *`,
      [name, email, address, payment_method, metadata ? JSON.stringify(metadata) : null, id]
    )
    if (!result.rows.length) return res.status(404).send('Cliente no encontrado')
    res.json(result.rows[0])
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al actualizar el cliente')
  }
})

app.delete('/customers/:id', async (req, res) => {
  const { id } = req.params
  try {
    const result = await pool.query('DELETE FROM customers WHERE id = $1 RETURNING id', [id])
    if (!result.rows.length) return res.status(404).send('Cliente no encontrado')
    res.send('Cliente eliminado')
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al eliminar el cliente')
  }
})

// ===== ADMIN CUSTOMERS =====

// GET /admin/customers?q=&role=&page=1&limit=20
app.get('/admin/customers', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { q = '', role = '', page = '1', limit = '20' } = req.query
    const p = Math.max(1, Number(page) || 1)
    const l = Math.min(100, Math.max(1, Number(limit) || 20))
    const off = (p - 1) * l

    const where = []
    const vals = []

    if (q) {
      const like = `%${q}%`
      vals.push(like, like, like)
      const i1 = vals.length - 2, i2 = vals.length - 1, i3 = vals.length
      where.push(`(lower(email) ILIKE lower($${i1}) OR lower(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) ILIKE lower($${i2}) OR COALESCE(phone,'') ILIKE $${i3})`)
    }

    if (role) {
      vals.push(role)
      where.push(`(metadata->>'role') = $${vals.length}`)
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const sql = `
      SELECT
        id, email, first_name, last_name, phone, address, metadata,
        (metadata->>'role') AS role,
        created_at,
        COUNT(*) OVER() AS total_rows
      FROM customers
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT ${l} OFFSET ${off};
    `
    const { rows } = await pool.query(sql, vals)
    const total = rows[0]?.total_rows ? Number(rows[0].total_rows) : 0
    res.json({
      items: rows.map(({ total_rows, ...r }) => r),
      page: p,
      pages: Math.max(1, Math.ceil(total / l)),
      total,
      limit: l
    })
  } catch (e) {
    console.error('GET /admin/customers', e)
    res.status(500).json({ error: 'Error al listar clientes' })
  }
})

// PATCH /admin/customers/:id/role  { role: 'admin'|'owner'|'delivery'|null }
app.patch('/admin/customers/:id/role', authenticateToken, requireAdmin, async (req, res) => {
  const id = Number(req.params.id)
  const { role } = req.body || {}

  const allowed = new Set(['admin', 'owner', 'delivery', null, ''])
  const roleNorm = role === '' ? null : role
  if (!allowed.has(roleNorm)) return res.status(400).json({ error: 'Rol inválido' })

  // opcional: impedir auto-deshabilitar tu propio admin
  if (roleNorm !== 'admin' && Number(req.user.id) === id) {
    return res.status(400).json({ error: 'No puedes quitarte tu propio rol admin' })
  }

  try {
    const q = roleNorm == null
      ? `UPDATE customers SET metadata = (COALESCE(metadata,'{}'::jsonb) - 'role') WHERE id = $1 RETURNING id, email, metadata`
      : `UPDATE customers SET metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('role',$2::text) WHERE id = $1 RETURNING id, email, metadata`
    const params = roleNorm == null ? [id] : [id, String(roleNorm)]
    const { rows } = await pool.query(q, params)
    if (!rows.length) return res.status(404).json({ error: 'Cliente no encontrado' })
    res.json({ ok: true, id, role: rows[0].metadata?.role ?? null })
  } catch (e) {
    console.error('PATCH /admin/customers/:id/role', e)
    res.status(500).json({ error: 'No se pudo actualizar el rol' })
  }
})

// DELETE /admin/customers/:id
app.delete('/admin/customers/:id', authenticateToken, requireAdmin, async (req, res) => {
  const id = Number(req.params.id)

  // opcional: no permitir borrarte
  if (Number(req.user.id) === id) return res.status(400).json({ error: 'No puedes borrarte a ti misma' })

  try {
    // chequear referencias (órdenes)
    const used = await pool.query('SELECT 1 FROM orders WHERE customer_id = $1 LIMIT 1', [id])
    if (used.rows.length) {
      return res.status(409).json({ error: 'Tiene órdenes asociadas. No se puede eliminar.' })
    }

    await pool.query('DELETE FROM carts WHERE customer_id = $1', [id])
    const del = await pool.query('DELETE FROM customers WHERE id = $1 RETURNING id', [id])
    if (!del.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' })
    res.json({ ok: true })
  } catch (e) {
    console.error('DELETE /admin/customers/:id', e)
    res.status(500).json({ error: 'Error al eliminar cliente' })
  }
})

/* LINE ITEMS */

app.get('/line-items', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM line_items')
    res.json(result.rows)
  } catch {
    res.status(500).send('Error al obtener los line items')
  }
})

app.get('/line-items/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM line_items WHERE id = $1', [req.params.id])
    if (!result.rows.length) return res.status(404).send('No encontrado')
    res.json(result.rows[0])
  } catch {
    res.status(500).send('Error al obtener el line item')
  }
})

app.post('/line-items', async (req, res) => {
  const { order_id, product_id, quantity, unit_price, metadata } = req.body
  try {
    const result = await pool.query(
      'INSERT INTO line_items (order_id, product_id, quantity, unit_price, metadata) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [order_id, product_id, quantity, unit_price, metadata || {}]
    )
    res.status(201).json(result.rows[0])
  } catch {
    res.status(500).send('Error al crear el line item')
  }
})

app.delete('/line-items/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM line_items WHERE id = $1', [req.params.id])
    res.sendStatus(204)
  } catch {
    res.status(500).send('Error al eliminar el line item')
  }
})

/* CART */

app.post('/cart', async (req, res) => {
  try {
    const { customer_id } = req.body
    const result = await pool.query(
      'INSERT INTO carts (customer_id) VALUES ($1) RETURNING *',
      [customer_id || null]
    )
    res.status(201).json(result.rows[0])
  } catch {
    res.status(500).send('Error al crear el carrito')
  }
})

app.post('/cart/:id/items', async (req, res) => {
  try {
    const cartId = req.params.id
    const { product_id, quantity, unit_price } = req.body
    const result = await pool.query(
      `INSERT INTO cart_items (cart_id, product_id, quantity, unit_price)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [cartId, product_id, quantity, unit_price]
    )
    res.status(201).json(result.rows[0])
  } catch {
    res.status(500).send('Error al agregar item al carrito')
  }
})

app.get('/cart/:id/items', async (req, res) => {
  try {
    const cartId = req.params.id
    const result = await pool.query(
      `SELECT * FROM cart_items WHERE cart_id = $1`,
      [cartId]
    )
    res.json(result.rows)
  } catch {
    res.status(500).send('Error al obtener los items del carrito')
  }
})

app.delete('/cart/:cartId/items/:itemId', async (req, res) => {
  try {
    const { cartId, itemId } = req.params
    await pool.query(
      `DELETE FROM cart_items WHERE id = $1 AND cart_id = $2`,
      [itemId, cartId]
    )
    res.sendStatus(204)
  } catch {
    res.status(500).send('Error al eliminar el item del carrito')
  }
})

app.get('/cart', authenticateToken, async (req, res) => {
  const customerId = req.user.id
  try {
    const cartRes = await pool.query(
      'SELECT * FROM carts WHERE customer_id = $1 AND completed = false LIMIT 1',
      [customerId]
    )
    if (!cartRes.rows.length) return res.json({ cart: null, items: [] })
    const cart = cartRes.rows[0]
    const itemsRes = await pool.query(
      `SELECT
        ci.id,
        ci.product_id,
        ci.quantity,
        ci.unit_price,
        ci.metadata,
        p.title                         AS title,
        p.image_url                     AS thumbnail,
        COALESCE(p.weight, 0)::float    AS weight,
        p.owner_id                      AS owner_id,
        o.name                          AS owner_name,
        COALESCE(p.stock_qty, 0)::int   AS available_stock   -- 👈 NUEVO
      FROM cart_items ci
      LEFT JOIN products p ON p.id = ci.product_id
      LEFT JOIN owners   o ON o.id = p.owner_id
      WHERE ci.cart_id = $1
      ORDER BY ci.id ASC;`,
      [cart.id]
    )
    res.json({ cart, items: itemsRes.rows })
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al obtener el carrito')
  }
})

// 🛒 Agregar/actualizar ítem en carrito (server calcula precio)
app.post('/cart/add', authenticateToken, async (req, res) => {
  const customerId = req.user.id
  const { product_id, quantity } = req.body

  if (!product_id || !Number.isInteger(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'product_id y quantity válidos son requeridos' })
  }

  try {
    // 1) Cart activo (o crearlo)
    let cart = await pool.query(
      'SELECT * FROM carts WHERE customer_id = $1 AND completed = false LIMIT 1',
      [customerId]
    )
    if (!cart.rows.length) {
      cart = await pool.query('INSERT INTO carts (customer_id) VALUES ($1) RETURNING *', [customerId])
    }
    const cartId = cart.rows[0].id

    // 2) Producto con stock_qty
    const prodRes = await pool.query(
      'SELECT id, title, price, metadata, COALESCE(stock_qty,0)::int AS stock_qty FROM products WHERE id = $1',
      [product_id]
    )
    if (!prodRes.rows.length) return res.status(404).json({ error: 'Producto no encontrado' })
    const prod = prodRes.rows[0]
    const m = prod.metadata || {}

    if (m.archived === true) {
      return res.status(409).json({ error: 'Producto archivado, no disponible' })
    }

    // 3) Cantidad actual en el carrito
    const existing = await pool.query(
      'SELECT id, quantity FROM cart_items WHERE cart_id = $1 AND product_id = $2',
      [cartId, product_id]
    )
    const currentQty = existing.rows.length ? Number(existing.rows[0].quantity) : 0
    const requestedTotal = currentQty + Number(quantity)

    // 4) Validación de stock_qty
    const stock = Number(prod.stock_qty) || 0
    if (stock <= 0) {
      return res.status(409).json({
        ok: false,
        reason: 'insufficient_stock',
        product_id,
        title: prod.title,
        requested: requestedTotal,
        available: 0,
        message: 'Sin stock'
      })
    }
    if (requestedTotal > stock) {
      const availableToAdd = Math.max(stock - currentQty, 0)
      return res.status(409).json({
        ok: false,
        reason: 'insufficient_stock',
        product_id,
        title: prod.title,
        requested: requestedTotal,
        available: availableToAdd,
        message: 'Cantidad solicitada supera el stock disponible'
      })
    }

    // 5) Cálculo de precios/impuestos (igual que tenías)
    const taxable = m.taxable !== false
    const tax_pct = Number.isFinite(m.tax_pct) ? Math.max(0, Math.min(30, Number(m.tax_pct))) : 0
    const margin_pct = Number.isFinite(m.margin_pct) ? Math.max(0, Number(m.margin_pct)) : 0

    const base_cents = Number.isInteger(m.price_cents) && m.price_cents >= 0
      ? m.price_cents
      : Math.round(Number(prod.price) * 100)

    const price_with_margin_cents = Math.round(base_cents * (100 + margin_pct) / 100)
    const tax_cents = taxable ? Math.round(price_with_margin_cents * tax_pct / 100) : 0

    const unit_price_usd = (price_with_margin_cents / 100).toFixed(2)

    const itemMeta = {
      price_source: (Number.isInteger(m.price_cents) ? 'price_cents' : 'price'),
      base_cents,
      margin_pct,
      taxable,
      tax_pct,
      price_with_margin_cents,
      tax_cents,
      computed_at: new Date().toISOString(),
    }

    // 6) Upsert
    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE cart_items
           SET quantity = quantity + $1,
               unit_price = $2,
               metadata = COALESCE(metadata,'{}'::jsonb) || $3::jsonb
         WHERE cart_id = $4 AND product_id = $5`,
        [quantity, unit_price_usd, JSON.stringify(itemMeta), cartId, product_id]
      )
    } else {
      await pool.query(
        `INSERT INTO cart_items (cart_id, product_id, quantity, unit_price, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [cartId, product_id, quantity, unit_price_usd, JSON.stringify(itemMeta)]
      )
    }

    return res.json({
      ok: true,
      cart_id: cartId,
      product_id,
      quantity_added: quantity,
      unit_price: Number(unit_price_usd),
      tax_cents
    })
  } catch (error) {
    console.error(error)
    return res.status(500).json({ error: 'Error al agregar al carrito' })
  }
})

// Quitar/disminuir item del carrito (idempotente)
app.delete('/cart/remove/:itemId', authenticateToken, async (req, res) => {
  const itemId = Number(req.params.itemId)
  const customerId = req.user.id

  try {
    const cart = await pool.query(
      'SELECT id FROM carts WHERE customer_id = $1 AND completed = false LIMIT 1',
      [customerId]
    )

    // Si no hay carrito abierto, no hay nada que borrar
    if (cart.rows.length === 0) {
      return res.sendStatus(204)
    }

    const cartId = cart.rows[0].id

    const itemRes = await pool.query(
      'SELECT quantity FROM cart_items WHERE id = $1 AND cart_id = $2',
      [itemId, cartId]
    )

    // Si el item ya no existe (porque lo limpiamos al archivar/borrar producto), ok no-op
    if (itemRes.rows.length === 0) {
      return res.sendStatus(204)
    }

    const quantity = itemRes.rows[0].quantity
    if (quantity > 1) {
      await pool.query('UPDATE cart_items SET quantity = quantity - 1 WHERE id = $1', [itemId])
    } else {
      await pool.query('DELETE FROM cart_items WHERE id = $1', [itemId])
    }

    return res.sendStatus(204)
  } catch (error) {
    console.error(error)
    return res.status(500).send('Error al eliminar del carrito')
  }
})

// POST /cart/validate
app.post('/cart/validate', authenticateToken, async (req, res) => {
  const { cartId } = req.body
  // 1) Traer items del carrito
  const items = await pool.query(`
    SELECT ci.product_id, ci.quantity as requested,
           p.title, p.stock_qty, o.name as owner_name
    FROM cart_items ci
    JOIN products p ON p.id = ci.product_id
    LEFT JOIN owners o ON o.id = p.owner_id
    WHERE ci.cart_id = $1
  `, [cartId])

  const unavailable = []
  for (const it of items.rows) {
    const available = Number(it.stock_qty) // si controlas stock reservado, ajusta aquí
    if (available < it.requested) {
      unavailable.push({
        product_id: it.product_id,
        title: it.title,
        owner_name: it.owner_name,
        requested: it.requested,
        available,
      })
    }
  }

  if (unavailable.length > 0) {
    return res.json({
      ok: false,
      message: 'Hay productos sin disponibilidad.',
      unavailable,
    })
  }

  return res.json({ ok: true })
})

/* CATEGORIES */

// Público
app.get('/categories', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, slug, name, image_url FROM categories ORDER BY name')
    res.json(rows)
  } catch (e) {
    console.error(e); res.status(500).send('Error al listar categorías')
  }
})

// ===== Admin Categories (alias explícito) =====
app.post('/admin/categories', authenticateToken, requireAdmin, async (req, res) => {
  const { slug, name, image_url } = req.body
  if (!slug || !name) return res.status(400).json({ error: 'slug y name son requeridos' })
  try {
    const { rows } = await pool.query(
      'INSERT INTO categories (slug, name, image_url) VALUES ($1, $2, $3) RETURNING id, slug, name, image_url',
      [slug, name, image_url || null]
    )
    res.status(201).json(rows[0])
  } catch (e) {
    console.error(e); res.status(500).send('Error al crear categoría')
  }
})

app.put('/admin/categories/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { slug, name, image_url } = req.body
  try {
    const { rows } = await pool.query(
      `UPDATE categories
          SET slug = COALESCE($1, slug),
              name = COALESCE($2, name),
              image_url = COALESCE($3, image_url)
        WHERE id = $4
        RETURNING id, slug, name, image_url`,
      [slug ?? null, name ?? null, image_url ?? null, req.params.id]
    )
    if (!rows.length) return res.status(404).send('Categoría no encontrada')
    res.json(rows[0])
  } catch (e) {
    console.error(e); res.status(500).send('Error al actualizar categoría')
  }
})

app.delete('/admin/categories/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM categories WHERE id=$1', [req.params.id])
    if (!rowCount) return res.status(404).send('Categoría no encontrada')
    res.sendStatus(204)
  } catch (e) {
    console.error(e); res.status(500).send('Error al eliminar categoría (puede tener productos)')
  }
})

// OWNERS
app.use('/owners', ownersPublicRouter); // público: /owners/options

app.use('/admin/owners', authenticateToken, requireAdmin, ownersRouter); // admin CRUD

app.use('/admin/owners/:ownerId/areas', authenticateToken, requireAdmin, ownerAreasRouter);

//shipping
app.use('/shipping', authenticateToken, shippingRouter);

// Guardar shipping-config
app.put(
  '/admin/owners/:ownerId/shipping-config',
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const ownerId = Number(req.params.ownerId);
    const cfg = req.body || {};

    const cuRestrict = !!cfg.cu_restrict_to_list; // flag

    const cuMode = (cfg.cu?.mode === 'by_weight') ? 'weight' : 'fixed';

    const fixed = cfg.cu?.fixed || {};
    const byW = cfg.cu?.by_weight || {};
    const base = byW.base || {};

    const usFixed = cfg.us?.fixed_usd ?? null;

    const cuHabCityFlat = fixed.habana_city ?? null;
    const cuHabRuralFlat = fixed.habana_municipio ?? null;
    const cuOtherCityFlat = fixed.provincias_city ?? null;
    const cuOtherRuralFlat = fixed.provincias_municipio ?? null;

    const cuRatePerLb = byW.rate_per_lb ?? null;
    const cuHabCityBase = base.habana_city ?? null;
    const cuHabRuralBase = base.habana_municipio ?? null;
    const cuOtherCityBase = base.provincias_city ?? null;
    const cuOtherRuralBase = base.provincias_municipio ?? null;

    const cuMinFee = cfg.cu?.min_fee ?? null;

    try {
      await pool.query('BEGIN');

      // US: incluir mode='fixed' para satisfacer NOT NULL
      await pool.query(`
  INSERT INTO owner_shipping_config (owner_id, country, active, mode, us_flat)
  VALUES ($1, 'US', true, 'fixed', $2)
  ON CONFLICT (owner_id, country) DO UPDATE
    SET active = EXCLUDED.active,
        mode   = EXCLUDED.mode,
        us_flat= EXCLUDED.us_flat
`, [ownerId, usFixed]);

      // CU (incluye el flag)
      await pool.query(`
        INSERT INTO owner_shipping_config (
          owner_id, country, active, mode,
          cu_hab_city_flat,    cu_hab_rural_flat,
          cu_other_city_flat,  cu_other_rural_flat,
          cu_rate_per_lb,
          cu_hab_city_base,    cu_hab_rural_base,
          cu_other_city_base,  cu_other_rural_base,
          cu_min_fee,
          cu_restrict_to_list
        )
        VALUES ($1, 'CU', true, $2,
                $3, $4, $5, $6,
                $7,
                $8, $9, $10, $11,
                $12,
                $13)
        ON CONFLICT (owner_id, country) DO UPDATE SET
          active = EXCLUDED.active,
          mode   = EXCLUDED.mode,
          cu_hab_city_flat    = EXCLUDED.cu_hab_city_flat,
          cu_hab_rural_flat   = EXCLUDED.cu_hab_rural_flat,
          cu_other_city_flat  = EXCLUDED.cu_other_city_flat,
          cu_other_rural_flat = EXCLUDED.cu_other_rural_flat,
          cu_rate_per_lb      = EXCLUDED.cu_rate_per_lb,
          cu_hab_city_base    = EXCLUDED.cu_hab_city_base,
          cu_hab_rural_base   = EXCLUDED.cu_hab_rural_base,
          cu_other_city_base  = EXCLUDED.cu_other_city_base,
          cu_other_rural_base = EXCLUDED.cu_other_rural_base,
          cu_min_fee          = EXCLUDED.cu_min_fee,
          cu_restrict_to_list = EXCLUDED.cu_restrict_to_list
      `, [
        ownerId, cuMode,
        cuHabCityFlat, cuHabRuralFlat, cuOtherCityFlat, cuOtherRuralFlat,
        cuRatePerLb,
        cuHabCityBase, cuHabRuralBase, cuOtherCityBase, cuOtherRuralBase,
        cuMinFee,
        cuRestrict
      ]);

      await pool.query('COMMIT');
      return res.json({ ok: true });
    } catch (e) {
      await pool.query('ROLLBACK');
      console.error('update shipping-config error', e);
      return res.status(500).json({ error: 'No se pudo actualizar shipping_config' });
    }
  }
);

/* CUSTOMER ORDERS (historial) */
app.get('/customers/:customerId/orders', async (req, res) => {
  const { customerId } = req.params
  try {
    const ordersResult = await pool.query(
      `SELECT 
         o.id AS order_id,
         o.created_at,
         o.status,              
         o.payment_method,
         o.metadata,
         li.product_id,
         li.quantity,
         li.unit_price,
         p.title AS product_name,
         p.weight,
         p.image_url
       FROM orders o
       JOIN line_items li ON o.id = li.order_id
       JOIN products p ON li.product_id = p.id
       WHERE o.customer_id = $1
       ORDER BY o.created_at DESC`,
      [customerId]
    )
    const rows = ordersResult.rows
    const grouped = {}
    for (const row of rows) {
      if (!grouped[row.order_id]) {
        grouped[row.order_id] = {
          order_id: row.order_id,
          created_at: row.created_at,
          status: row.status,
          payment_method: row.payment_method,
          metadata: row.metadata,
          items: [],
        }
      }
      grouped[row.order_id].items.push({
        product_id: row.product_id,
        product_name: row.product_name,
        quantity: row.quantity,
        unit_price: row.unit_price,
        weight: row.weight,
        image_url: row.image_url,
      })
    }
    const result = Object.values(grouped)
    res.json(result)
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al obtener el historial de órdenes')
  }
})

/* AUTH */

// Register:
app.post('/register', async (req, res) => {
  const { email, password, address = null, phone = null, first_name = null, last_name = null } = req.body
  if (!email || !password) return res.status(400).json({ error: 'Faltan campos requeridos' })

  try {
    const emailNorm = String(email).trim().toLowerCase()
    const hashedPassword = await bcrypt.hash(password, 10)

    const { rows } = await pool.query(
      `INSERT INTO customers (email, password, first_name, last_name, phone, address)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, first_name, last_name, phone, address, metadata`,
      [emailNorm, hashedPassword, first_name, last_name, phone, address]
    )
    res.status(201).json({ customer: rows[0] })
  } catch (error) {
    if (error && error.code === '23505') {
      return res.status(409).json({ error: 'El email ya está registrado' })
    }
    console.error(error)
    res.status(500).json({ error: 'Error al registrar el usuario' })
  }
})

app.post('/login', async (req, res) => {
  const { email, password } = req.body
  try {
    const emailNorm = String(email || '').trim().toLowerCase()
    const userRes = await pool.query(
      'SELECT * FROM customers WHERE lower(email) = $1',
      [emailNorm]
    )
    if (!userRes.rows.length) return res.status(400).json({ message: 'Usuario no encontrado' })

    const user = userRes.rows[0]
    const match = await bcrypt.compare(password, user.password)
    if (!match) return res.status(401).json({ message: 'Contraseña incorrecta' })

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET || 'secret', { expiresIn: '1h' })
    res.json({ token })
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al iniciar sesión')
  }
})

// ⚠️ Tabla customers ya existe; guardaremos el token en metadata
app.post('/auth/forgot-password', async (req, res) => {
  const { email, locale } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email requerido' });

  try {
    const emailNorm = String(email).trim().toLowerCase();
    const { rows } = await pool.query('SELECT id, metadata FROM customers WHERE lower(email) = $1', [emailNorm]);

    // No revelamos si existe o no (mejor UX/seguridad)
    if (!rows.length) {
      console.log('[forgot] Email no encontrado, devolvemos OK para no filtrar existencia');
      return res.json({ ok: true });
    }

    const userId = rows[0].id;
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hora

    await pool.query(
      `UPDATE customers
         SET metadata = COALESCE(metadata,'{}'::jsonb) ||
                        jsonb_build_object('reset_token', $1::text, 'reset_expires', $2::text)
       WHERE id = $3`,
      [token, expiresAt, userId]
    )

    const base = process.env.CLIENT_BASE_URL || 'http://localhost:3000';
    const loc = (locale === 'en' || locale === 'es') ? locale : (process.env.DEFAULT_LOCALE || 'es');
    const link = `${base}/${loc}/reset?token=${token}`;

    console.log('[forgot] Enviando email a', emailNorm, 'link:', link);

    await sendPasswordResetEmail(emailNorm, link, loc);

    return res.json({ ok: true });
  } catch (e) {
    console.error('[forgot] Error:', e);
    return res.status(500).json({ error: 'No se pudo procesar la solicitud' });
  }
});

app.post('/auth/reset-password', async (req, res) => {
  const { token, new_password } = req.body || {};
  if (!token || !new_password) return res.status(400).json({ error: 'token y new_password requeridos' });

  try {
    const { rows } = await pool.query(
      `SELECT id, metadata
         FROM customers
        WHERE (metadata->>'reset_token') = $1
        LIMIT 1`,
      [token]
    );

    if (!rows.length) return res.status(400).json({ error: 'Token inválido' });

    const user = rows[0];
    const expires = user.metadata?.reset_expires;
    if (!expires || new Date(expires).getTime() < Date.now()) {
      return res.status(400).json({ error: 'Token expirado' });
    }

    const hash = await bcrypt.hash(String(new_password), 10);

    await pool.query(
      `UPDATE customers
          SET password = $1,
              metadata = (COALESCE(metadata,'{}'::jsonb) - 'reset_token' - 'reset_expires')
        WHERE id = $2`,
      [hash, user.id]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error('[reset] Error:', e);
    return res.status(500).json({ error: 'No se pudo restablecer la contraseña' });
  }
});

// CATEGORY → PRODUCTS (precio base + margen, sin taxes) + filtro por ubicación + lista blanca CU
app.get('/products/category/:slug', async (req, res) => {
  const { slug } = req.params;
  const { country, province, area_type, municipality } = req.query;

  try {
    const categoryRes = await pool.query('SELECT id FROM categories WHERE slug = $1', [slug]);
    if (!categoryRes.rows.length) return res.status(404).send('Categoría no encontrada');
    const categoryId = categoryRes.rows[0].id;

    const countryNorm = String(country || '').toUpperCase();
    const prov = String(province || '').trim();
    const mun = String(municipality || req.query.municipio || '').trim();

    let locationSql = 'TRUE';
    let params = [categoryId];

    if (countryNorm === 'US') {
      locationSql = `
        (
          p.owner_id IS NULL
          OR EXISTS (
            SELECT 1 FROM owner_shipping_config osc
             WHERE osc.owner_id = p.owner_id
               AND osc.active = true
               AND osc.country = 'US'
          )
        )
      `;
    } else if (countryNorm === 'CU') {
      const zone = zoneKeyForCuba(prov, area_type);
      let zoneFixedCol, zoneBaseCol;
      if (zone === 'habana_city') { zoneFixedCol = 'cu_hab_city_flat'; zoneBaseCol = 'cu_hab_city_base'; }
      else if (zone === 'habana_municipio') { zoneFixedCol = 'cu_hab_rural_flat'; zoneBaseCol = 'cu_hab_rural_base'; }
      else if (zone === 'provincias_city') { zoneFixedCol = 'cu_other_city_flat'; zoneBaseCol = 'cu_other_city_base'; }
      else if (zone === 'provincias_municipio') { zoneFixedCol = 'cu_other_rural_flat'; zoneBaseCol = 'cu_other_rural_base'; }

      const zoneClause = (zoneFixedCol && zoneBaseCol) ? `
        (
          (osc.mode = 'fixed'  AND osc.${zoneFixedCol} IS NOT NULL)
          OR
          (osc.mode <> 'fixed' AND (osc.cu_rate_per_lb IS NOT NULL OR osc.${zoneBaseCol} IS NOT NULL OR osc.cu_min_fee IS NOT NULL))
        )
      ` : `TRUE`;

      params.push(prov); const iProv = params.length;
      params.push(mun); const iMun = params.length;

      locationSql = `
        (
          p.owner_id IS NULL
          OR EXISTS (
            SELECT 1 FROM owner_shipping_config osc
             WHERE osc.owner_id = p.owner_id
               AND osc.active = true
               AND osc.country = 'CU'
               AND ${zoneClause}
               AND (
                 COALESCE(osc.cu_restrict_to_list, false) = false
                 OR EXISTS (
                   SELECT 1 FROM owner_cu_areas oa
                    WHERE oa.owner_id = p.owner_id
                      AND lower(oa.province) = lower($${iProv})
                      AND (oa.municipality IS NULL OR lower(oa.municipality) = lower($${iMun}))
                 )
               )
          )
        )
      `;
    }

    const sql = `
      WITH src AS (
        SELECT id, title, description, price, weight, category_id, image_url, metadata, stock_qty
        FROM products p
        WHERE p.category_id = $1
          AND COALESCE(
                CASE
                  WHEN jsonb_typeof(p.metadata->'archived') = 'boolean'
                    THEN (p.metadata->>'archived')::boolean
                  WHEN jsonb_typeof(p.metadata->'archived') = 'string'
                    THEN lower(p.metadata->>'archived') IN ('true','t','yes','1')
                  ELSE false
                END
              , false) = false
          AND ${locationSql}
      ),
      calc AS (
        SELECT
          *,
          COALESCE((metadata->>'price_cents')::int, ROUND(price*100)::int) AS base_cents,
          COALESCE(NULLIF(metadata->>'margin_pct','')::numeric, 0)          AS margin_pct
        FROM src
      )
      SELECT
        id, title, description, price, weight, category_id, image_url, metadata, stock_qty,
        ROUND(base_cents * (100 + margin_pct) / 100.0)::int AS price_with_margin_cents,
        ROUND(ROUND(base_cents * (100 + margin_pct) / 100.0) / 100.0, 2) AS price_with_margin_usd
      FROM calc
      ORDER BY id DESC;
    `;

    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).send('Error al obtener productos por categoría');
  }
});

// Delivery Tracking
// Servir público con cabeceras seguras y caché de 1 día
app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 día
  }
}));

// Rutas de entrega
app.use('/deliver', require('./routes/deliver'));

// ====== LIMPIEZA AUTOMÁTICA DE UPLOADS ======
// Configurables por ENV (todos opcionales)
const RETENTION_DAYS = Number(process.env.DELIVERY_RETENTION_DAYS || 30);         // borra > 30 días
const CLEANUP_EVERY_HOURS = Number(process.env.DELIVERY_CLEANUP_EVERY_HOURS || 24); // corre cada 24 h
const DELETE_PREFIX = process.env.DELIVERY_CLEANUP_PREFIX || 'proof_';             // borra solo archivos que empiecen con 'proof_' (recomendado). Pon '' para borrar todos.

function cleanupUploads() {
  const now = Date.now();
  const maxAgeMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;

  let deleted = 0, kept = 0, errors = 0;

  try {
    const entries = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true });

    for (const ent of entries) {
      if (!ent.isFile()) continue;                  // solo archivos
      const name = ent.name;

      // No borrar archivos “de sistema”
      if (name === '.gitkeep' || name === '.keep') { kept++; continue; }

      // Opcional: solo borrar pruebas de entrega (más seguro)
      if (DELETE_PREFIX && !name.startsWith(DELETE_PREFIX)) { kept++; continue; }

      const full = path.join(UPLOAD_DIR, name);

      try {
        const stat = fs.statSync(full);
        const ageMs = now - stat.mtimeMs;

        if (ageMs > maxAgeMs) {
          fs.unlinkSync(full);
          deleted++;
        } else {
          kept++;
        }
      } catch (e) {
        errors++;
        console.error('[cleanupUploads] No se pudo procesar', name, e?.message || e);
      }
    }

    console.log(`[cleanupUploads] OK — borrados=${deleted}, conservados=${kept}, días=${RETENTION_DAYS}`);
  } catch (e) {
    console.error('[cleanupUploads] Falló el escaneo:', e?.message || e);
  }
}

// Programa la limpieza: 1ª vez al minuto, luego cada N horas
const RUN_CLEANUP = String(process.env.RUN_UPLOAD_CLEANUP ?? 'true') === 'true';
if (RUN_CLEANUP) {
  setTimeout(cleanupUploads, 60 * 1000);
  setInterval(cleanupUploads, CLEANUP_EVERY_HOURS * 60 * 60 * 1000);
}


app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`)
})

app.get('/health', (req, res) => res.json({ ok: true }))
