const express = require('express')
const router = express.Router()
const { pool } = require('../db')
const authenticateToken = require('../middleware/authenticateToken')
const { requireAdmin } = require('../middleware/roles')
const { zoneKeyForCuba } = require('../utils/geo')

// LIST + filtros (incluye lógica de shipping/zonas)
router.get('/products', async (req, res) => {
  const {
    category_id,
    include_archived,
    country,
    province,
    area_type,
    municipality,
  } = req.query;

  try {
    const where = [];
    const params = [];

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

    const countryNorm = String(country || '').toUpperCase();
    const prov = String(province || '').trim();
    const mun = String(municipality || req.query.municipio || '').trim();

    if (countryNorm === 'US') {
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
      params.push(mun);  const iMun  = params.length;

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
                 COALESCE(osc.cu_restrict_to_list, false) = false
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
          COALESCE((metadata->>'price_cents')::int, ROUND(price*100)::int) AS base_cents,
          COALESCE(NULLIF(metadata->>'margin_pct','')::numeric, 0)          AS margin_pct,
          CASE
            WHEN jsonb_typeof(metadata->'taxable')='boolean' THEN (metadata->>'taxable')::boolean
            WHEN jsonb_typeof(metadata->'taxable')='string'  THEN lower(metadata->>'taxable') IN ('true','t','yes','1')
            ELSE true
          END AS taxable,
          COALESCE(NULLIF(metadata->>'tax_pct','')::numeric, 0) AS tax_pct
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

// BEST SELLERS
router.get('/products/best-sellers', async (req, res) => {
  const {
    limit = '12',
    days = '60',
    country,
    province,
    area_type,
    municipality,
  } = req.query;

  const lim = Math.min(48, Math.max(1, Number(limit) || 12));
  const lastDays = Math.min(365, Math.max(1, Number(days) || 60));

  try {
    const countryNorm = String(country || '').toUpperCase();
    const prov = String(province || '').trim();
    const mun = String(municipality || req.query.municipio || '').trim();

    let locationSql = 'TRUE';
    const params = [lastDays];

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
      params.push(mun);  const iMun  = params.length;

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
      WITH recent AS (
        SELECT li.product_id, SUM(li.quantity)::int AS sold_qty
          FROM line_items li
          JOIN orders o ON o.id = li.order_id
         WHERE o.created_at >= NOW() - ($1::int * INTERVAL '1 day')
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

// SEARCH
router.get('/products/search', async (req, res) => {
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
      params.push(mun);  const iMun  = params.length;

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

    const text = String(q).trim();
    if (text) {
      params.push(`%${text}%`); const i1 = params.length;
      params.push(`%${text}%`); const i2 = params.length;
      where.push(`(p.title ILIKE $${i1} OR p.description ILIKE $${i2})`);
    }

    where.push(`COALESCE(
      CASE
        WHEN jsonb_typeof(p.metadata->'archived')='boolean' THEN (p.metadata->>'archived')::boolean
        WHEN jsonb_typeof(p.metadata->'archived')='string'  THEN lower(p.metadata->>'archived') IN ('true','t','yes','1')
        ELSE false
      END
    ,false) = false`);

    where.push(locationSql);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

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
    const has_more = rows.length > l;
    const items = has_more ? rows.slice(0, l) : rows;

    res.json({ items, page: p, limit: l, has_more });
  } catch (e) {
    console.error('GET /products/search error', e);
    res.status(500).json({ error: 'Error buscando productos' });
  }
});

// GET by id
router.get('/products/:id', async (req, res) => {
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

// CREATE (admin)
router.post('/products', authenticateToken, requireAdmin, async (req, res) => {
  const { title, price, weight, category_id, image_url, description, stock_qty, owner_id } = req.body
  if (!title || price == null) return res.status(400).json({ error: 'title y price son requeridos' })

  const rawMeta = req.body?.metadata ?? {}
  const cleanMeta = {
    owner: typeof rawMeta.owner === 'string' ? rawMeta.owner.trim() : undefined,
    taxable: rawMeta.taxable === false ? false : true,
    tax_pct: Number.isFinite(rawMeta.tax_pct) ? Math.max(0, Math.min(30, Number(rawMeta.tax_pct))) : 0,
    margin_pct: Number.isFinite(rawMeta.margin_pct) ? Math.max(0, Number(rawMeta.margin_pct)) : 0,
    price_cents: Number.isInteger(rawMeta.price_cents) && rawMeta.price_cents >= 0 ? rawMeta.price_cents : undefined,
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

// UPDATE (admin)
router.put('/products/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { title, price, weight, category_id, image_url, description, stock_qty, owner_id } = req.body
  const rawMeta = req.body?.metadata ?? {}
  const cleanMeta = {
    owner: typeof rawMeta.owner === 'string' ? rawMeta.owner.trim() : undefined,
    taxable: rawMeta.taxable === false ? false : true,
    tax_pct: Number.isFinite(rawMeta.tax_pct) ? Math.max(0, Math.min(30, Number(rawMeta.tax_pct))) : 0,
    margin_pct: Number.isFinite(rawMeta.margin_pct) ? Math.max(0, Number(rawMeta.margin_pct)) : 0,
    price_cents: Number.isInteger(rawMeta.price_cents) && rawMeta.price_cents >= 0 ? rawMeta.price_cents : undefined,
    archived: (stock_qty == null) ? undefined : ((Number(stock_qty) || 0) <= 0),
  }
  Object.keys(cleanMeta).forEach(k => cleanMeta[k] === undefined && delete cleanMeta[k])

  const stockInt = (stock_qty === '' || stock_qty == null) ? null : Number(stock_qty)
  const ownerInt = (owner_id === '' || owner_id == null) ? null : Number(owner_id)

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
})

// DELETE (admin, con lógica de archivar si tiene órdenes)
router.delete('/products/:id', authenticateToken, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const usedInOrders = await pool.query('SELECT 1 FROM line_items WHERE product_id = $1 LIMIT 1', [id])
    if (usedInOrders.rows.length) {
      return res.status(409).json({
        error: 'No se puede borrar: el producto está referenciado en órdenes.',
        suggestion: 'Archívalo en lugar de borrarlo (PATCH /products/:id con metadata: { archived: true }).'
      })
    }

    await pool.query('DELETE FROM cart_items WHERE product_id = $1', [id])
    const result = await pool.query('DELETE FROM products WHERE id = $1 RETURNING id', [id])
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Producto no encontrado' })
    }
    res.json({ ok: true })
  } catch (e) {
    console.error('DELETE /products error', e)
    if (e.code === '23503') {
      return res.status(409).json({ error: 'No se puede borrar por restricciones de clave foránea.' })
    }
    res.status(500).json({ error: 'Error al eliminar producto' })
  }
})

// DELETE/ARCHIVE admin back-compat
router.delete('/admin/products/:id', authenticateToken, requireAdmin, async (req, res) => {
  const client = await pool.connect()
  const id = Number(req.params.id)
  try {
    await client.query('BEGIN')
    const prod = await client.query('SELECT id FROM products WHERE id = $1', [id])
    if (!prod.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Producto no encontrado' }) }

    const inOrders = await client.query('SELECT 1 FROM line_items WHERE product_id = $1 LIMIT 1',[id])
    if (inOrders.rowCount > 0) {
      await client.query(
        `UPDATE products
           SET metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('archived', true)
         WHERE id = $1`, [id]
      )
      await client.query('DELETE FROM cart_items WHERE product_id = $1', [id])
      await client.query('COMMIT')
      return res.json({ archived: true, id })
    }

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

// ADMIN list
router.get('/admin/products', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { q = '', page = '1', limit = '12', category_id, owner_id, archived = 'all' } = req.query
    const p = Math.max(1, Number(page) || 1)
    const l = Math.min(100, Math.max(1, Number(limit) || 12))
    const off = (p - 1) * l

    const where = []
    const vals = []

    if (q) { vals.push(`%${q}%`); where.push(`title ILIKE $${vals.length}`) }
    if (category_id) { vals.push(Number(category_id)); where.push(`category_id = $${vals.length}`) }
    if (owner_id != null && owner_id !== '' && !Number.isNaN(Number(owner_id))) {
      vals.push(Number(owner_id)); where.push(`owner_id = $${vals.length}`)
    }
    if (archived === 'true') { where.push(`COALESCE((metadata->>'archived')::boolean, false) = true`) }
    else if (archived === 'false') { where.push(`COALESCE((metadata->>'archived')::boolean, false) = false`) }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const sql = `
      SELECT id, title, description, price, weight, category_id, image_url, metadata, stock_qty, owner_id,
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

// CATEGORY → PRODUCTS
router.get('/products/category/:slug', async (req, res) => {
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
      params.push(mun);  const iMun  = params.length;

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

module.exports = router
