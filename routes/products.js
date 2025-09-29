const express = require('express')
const router = express.Router()
const { pool } = require('../db')
const authenticateToken = require('../middleware/authenticateToken')
const { requireAdmin } = require('../middleware/roles')
const { zoneKeyForCuba } = require('../utils/geo')

/* ============================
   Helpers nuevos (no rompen nada)
   ============================ */
function parseDutyCents(body) {
  const u = Number(body?.duty_usd)
  if (Number.isFinite(u) && u >= 0) return Math.round(u * 100)
  const c = Number(body?.duty_cents)
  if (Number.isInteger(c) && c >= 0) return c
  return 0
}
function parseKeywords(body) {
  const raw = body?.keywords
  let arr = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : [])
  const out = Array.from(new Set(arr.map(s => String(s).trim().toLowerCase()).filter(Boolean)))
  return out.slice(0, 50)
}

/* ============================================================
   LIST + filtros (incluye lógica de shipping/zonas) (GET /products)
   ============================================================ */
router.get('/products', async (req, res) => {
  const {
    category_id,
    country,
    province,
    area_type,
    municipality,
  } = req.query;

  try {
    const where = [];
    const params = [];
    where.push(`COALESCE(
    CASE
      WHEN jsonb_typeof(metadata->'archived') = 'boolean'
        THEN (metadata->>'archived')::boolean
      WHEN jsonb_typeof(metadata->'archived') = 'string'
        THEN lower(metadata->>'archived') IN ('true','t','yes','1')
      ELSE false
    END
  , false) = false`);

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
        SELECT
          id, title, description, title_en, description_en,
          price, weight, category_id, image_url,
          metadata, stock_qty, owner_id,
          duty_cents, keywords
        FROM products
        ${whereSql}
      ),
      calc AS (
        SELECT
          *,
          COALESCE((metadata->>'price_cents')::int, ROUND(price*100)::int) AS base_cents,
          COALESCE(duty_cents, 0)                                          AS duty_cents_safe,
          COALESCE(NULLIF(metadata->>'margin_pct','')::numeric, 0)         AS margin_pct,
          CASE
            WHEN jsonb_typeof(metadata->'taxable')='boolean' THEN (metadata->>'taxable')::boolean
            WHEN jsonb_typeof(metadata->'taxable')='string'  THEN lower(metadata->>'taxable') IN ('true','t','yes','1')
            ELSE true
          END AS taxable,
          COALESCE(NULLIF(metadata->>'tax_pct','')::numeric, 0)            AS tax_pct,
          (COALESCE((metadata->>'price_cents')::int, ROUND(price*100)::int) + COALESCE(duty_cents,0)) AS effective_cents
        FROM src
      )
      SELECT
        id, title, description, title_en, description_en,
        price, weight, category_id, image_url,
        metadata, stock_qty, owner_id,
        duty_cents, keywords,

        ROUND(effective_cents * (100 + margin_pct) / 100.0)::int AS price_with_margin_cents,

        CASE WHEN taxable
             THEN ROUND((effective_cents * (100 + margin_pct) / 100.0) * tax_pct / 100.0)::int
             ELSE 0 END                                          AS tax_cents,

        (ROUND(effective_cents * (100 + margin_pct) / 100.0)::int
          + CASE WHEN taxable
                 THEN ROUND((effective_cents * (100 + margin_pct) / 100.0) * tax_pct / 100.0)::int
                 ELSE 0 END)                                     AS display_total_cents,

        ROUND(
          (
            ROUND(effective_cents * (100 + margin_pct) / 100.0)::numeric
            + CASE WHEN taxable
                   THEN ROUND((effective_cents * (100 + margin_pct) / 100.0) * tax_pct / 100.0)::numeric
                   ELSE 0 END
          ) / 100.0
        , 2)                                                     AS display_total_usd
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

/* ===================
   BEST SELLERS
   =================== */
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
      WITH recent AS (
        SELECT li.product_id, SUM(li.quantity)::int AS sold_qty
          FROM line_items li
          JOIN orders o ON o.id = li.order_id
         WHERE o.created_at >= NOW() - ($1::int * INTERVAL '1 day')
         GROUP BY li.product_id
      ),
      src AS (
        SELECT p.id, p.title, p.description, p.title_en, p.description_en,
               p.price, p.weight, p.category_id, p.image_url, p.metadata, p.stock_qty,
               p.owner_id, p.duty_cents, p.keywords,
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
          COALESCE(duty_cents, 0)                                          AS duty_cents_safe,
          COALESCE(NULLIF(metadata->>'margin_pct','')::numeric, 0)         AS margin_pct,
          (COALESCE((metadata->>'price_cents')::int, ROUND(price*100)::int) + COALESCE(duty_cents,0)) AS effective_cents
        FROM src
      )
      SELECT
        id, title, description, title_en, description_en,
        price, weight, category_id, image_url, metadata, stock_qty,
        owner_id, duty_cents, keywords,
        sold_qty,
        ROUND(effective_cents * (100 + margin_pct) / 100.0)::int AS price_with_margin_cents,
        ROUND(ROUND(effective_cents * (100 + margin_pct) / 100.0) / 100.0, 2) AS price_with_margin_usd
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

/* ===================
   SEARCH
   =================== */
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

    const text = String(q).trim();
    if (text) {
      params.push(`%${text}%`); const i1 = params.length; // title es
      params.push(`%${text}%`); const i2 = params.length; // description es
      params.push(`%${text}%`); const i3 = params.length; // title en
      params.push(`%${text}%`); const i4 = params.length; // description en
      params.push(`%${text}%`); const i5 = params.length; // keywords like

      where.push(`(
        p.title ILIKE $${i1}
        OR p.description ILIKE $${i2}
        OR p.title_en ILIKE $${i3}
        OR p.description_en ILIKE $${i4}
        OR EXISTS (
          SELECT 1 FROM unnest(COALESCE(p.keywords, '{}')) kw
          WHERE kw ILIKE $${i5}
        )
      )`);
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
          p.id, p.title, p.description, p.title_en, p.description_en,
          p.price, p.weight, p.category_id,
          p.image_url, p.metadata, p.stock_qty, p.owner_id,
          p.duty_cents, p.keywords
        FROM products p
        ${whereSql}
        ORDER BY p.id DESC
        LIMIT ${l + 1} OFFSET ${off}
      ),
      calc AS (
        SELECT
          *,
          COALESCE((metadata->>'price_cents')::int, ROUND(price*100)::int) AS base_cents,
          COALESCE(duty_cents, 0)                                          AS duty_cents_safe,
          COALESCE(NULLIF(metadata->>'margin_pct','')::numeric, 0)         AS margin_pct,
          (COALESCE((metadata->>'price_cents')::int, ROUND(price*100)::int) + COALESCE(duty_cents,0)) AS effective_cents
        FROM src
      )
      SELECT
        id, title, description, title_en, description_en,
        price, weight, category_id, image_url, metadata, stock_qty, owner_id,
        duty_cents, keywords,
        ROUND(effective_cents * (100 + margin_pct) / 100.0)::int AS price_with_margin_cents,
        ROUND(ROUND(effective_cents * (100 + margin_pct) / 100.0) / 100.0, 2) AS price_with_margin_usd
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

/* ============================
   PRODUCTS BY OWNERS (PUBLIC)
   ============================ */
   router.get('/products/by-owners', async (req, res) => {
    const {
      country,
      province,
      area_type,
      municipality,
      owners_limit = '8',
      per_owner = '4',
      owner_ids, // "1,2,3"
    } = req.query;
  
    // Límites seguros
    const ownersLim = Math.min(24, Math.max(1, Number(owners_limit) || 8));
    const perOwnerLim = Math.min(12, Math.max(1, Number(per_owner) || 4));
  
    // Parse de owner_ids si viene
    const ownerIdList = String(owner_ids || '')
      .split(',')
      .map(s => Number(s.trim()))
      .filter(n => Number.isInteger(n) && n > 0);
  
    try {
      const countryNorm = String(country || '').toUpperCase();
      const prov = String(province || '').trim();
      const mun = String(municipality || req.query.municipio || '').trim();
  
      let params = [];
      let locationSql = 'TRUE';
  
      // Disponibilidad por país + zona (idéntico criterio a /products, pero
      // aquí *exigimos* owner_id porque agrupamos por dueño).
      if (countryNorm === 'US') {
        locationSql = `
          EXISTS (
            SELECT 1 FROM owner_shipping_config osc
             WHERE osc.owner_id = p.owner_id
               AND osc.active = true
               AND osc.country = 'US'
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
          EXISTS (
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
        `;
      }
  
      // Filtro de archivados (idéntico a /products)
      const archivedClause = `
        COALESCE(
          CASE
            WHEN jsonb_typeof(p.metadata->'archived')='boolean' THEN (p.metadata->>'archived')::boolean
            WHEN jsonb_typeof(p.metadata->'archived')='string'  THEN lower(p.metadata->>'archived') IN ('true','t','yes','1')
            ELSE false
          END
        , false) = false
      `;
  
      // Si filtran por owner_ids
      let ownersFilterSql = 'TRUE';
      if (ownerIdList.length) {
        params.push(ownerIdList); // $idx ::int[]
        ownersFilterSql = `p.owner_id = ANY($${params.length}::int[])`;
      }
  
      // SQL:
      // 1) src: productos válidos por owner
      // 2) calc: mismos cálculos de precio que /products
      // 3) owners_pick: los top owners por cantidad de productos (o por nombre si empata)
      // 4) ranked: top N productos por owner
      const sql = `
        WITH src AS (
          SELECT
            p.id, p.title, p.description, p.title_en, p.description_en,
            p.price, p.weight, p.category_id, p.image_url,
            p.metadata, p.stock_qty, p.owner_id,
            p.duty_cents, p.keywords,
            o.name AS owner_name
          FROM products p
          LEFT JOIN owners o ON o.id = p.owner_id
          WHERE ${archivedClause}
            AND p.owner_id IS NOT NULL
            AND ${ownersFilterSql}
            AND ${locationSql}
        ),
        calc AS (
          SELECT
            *,
            COALESCE((metadata->>'price_cents')::int, ROUND(price*100)::int) AS base_cents,
            COALESCE(duty_cents, 0)                                          AS duty_cents_safe,
            COALESCE(NULLIF(metadata->>'margin_pct','')::numeric, 0)         AS margin_pct,
            CASE
              WHEN jsonb_typeof(metadata->'taxable')='boolean' THEN (metadata->>'taxable')::boolean
              WHEN jsonb_typeof(metadata->'taxable')='string'  THEN lower(metadata->>'taxable') IN ('true','t','yes','1')
              ELSE true
            END AS taxable,
            COALESCE(NULLIF(metadata->>'tax_pct','')::numeric, 0)            AS tax_pct,
            (COALESCE((metadata->>'price_cents')::int, ROUND(price*100)::int) + COALESCE(duty_cents,0)) AS effective_cents
          FROM src
        ),
        owners_pick AS (
          SELECT owner_id, COALESCE(owner_name,'Sin dueño') AS owner_name, COUNT(*) AS n
          FROM calc
          GROUP BY owner_id, owner_name
          ORDER BY n DESC, owner_name ASC
          LIMIT ${ownersLim}
        ),
        ranked AS (
          SELECT
            c.*,
            ROW_NUMBER() OVER (PARTITION BY c.owner_id ORDER BY c.id DESC) AS rn
          FROM calc c
          JOIN owners_pick op ON op.owner_id = c.owner_id
        )
        SELECT
          id, title, description, title_en, description_en,
          price, weight, category_id, image_url,
          metadata, stock_qty, owner_id, owner_name,
          duty_cents, keywords,
          -- valores finales para UI (idénticos a /products)
          ROUND(effective_cents * (100 + margin_pct) / 100.0)::int AS price_with_margin_cents,
          CASE WHEN taxable
               THEN ROUND((effective_cents * (100 + margin_pct) / 100.0) * tax_pct / 100.0)::int
               ELSE 0 END                                          AS tax_cents,
          (ROUND(effective_cents * (100 + margin_pct) / 100.0)::int
            + CASE WHEN taxable
                   THEN ROUND((effective_cents * (100 + margin_pct) / 100.0) * tax_pct / 100.0)::int
                   ELSE 0 END)                                     AS display_total_cents,
          ROUND(
            (
              ROUND(effective_cents * (100 + margin_pct) / 100.0)::numeric
              + CASE WHEN taxable
                     THEN ROUND((effective_cents * (100 + margin_pct) / 100.0) * tax_pct / 100.0)::numeric
                     ELSE 0 END
            ) / 100.0
          , 2)                                                     AS display_total_usd
        FROM ranked
        WHERE rn <= ${perOwnerLim}
        ORDER BY owner_name ASC, id DESC;
      `;
  
      const { rows } = await pool.query(sql, params);
  
      // Agrupar en JSON por owner
      const map = new Map();
      for (const r of rows) {
        const key = Number(r.owner_id);
        if (!map.has(key)) {
          map.set(key, {
            owner_id: key,
            owner_name: r.owner_name || 'Sin dueño',
            products: [],
          });
        }
        map.get(key).products.push({
          id: r.id,
          title: r.title,
          description: r.description,
          title_en: r.title_en,
          description_en: r.description_en,
          image_url: r.image_url,
          metadata: r.metadata,
          stock_qty: r.stock_qty,
          duty_cents: r.duty_cents,
          keywords: r.keywords,
          price_with_margin_cents: r.price_with_margin_cents,
          tax_cents: r.tax_cents,
          display_total_cents: r.display_total_cents,
          display_total_usd: r.display_total_usd,
        });
      }
  
      res.json({ owners: Array.from(map.values()) });
    } catch (e) {
      console.error('GET /products/by-owners error', e);
      res.status(500).json({ error: 'Error al obtener productos por owner' });
    }
  });

  // ===================
// OWNER DETAILS (PUBLIC)
// ===================
router.get('/owners/:id', async (req, res) => {
  const ownerId = Number(req.params.id);
  if (!Number.isInteger(ownerId) || ownerId <= 0) return res.status(400).json({ error: 'owner id inválido' });

  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, phone, active, metadata, created_at
         FROM owners WHERE id = $1`,
      [ownerId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Owner no encontrado' });
    res.json(rows[0]);
  } catch (e) {
    console.error('GET /owners/:id error', e);
    res.status(500).json({ error: 'Error al obtener owner' });
  }
});

// ===================
// PRODUCTS BY OWNER (PUBLIC, paginado)
// GET /products/owner/:owner_id?page=1&limit=24&country=CU&province=...&area_type=...&municipality=...
// ===================
router.get('/products/owner/:owner_id', async (req, res) => {
  const ownerId = Number(req.params.owner_id);
  if (!Number.isInteger(ownerId) || ownerId <= 0) return res.status(400).json({ error: 'owner id inválido' });

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(48, Math.max(1, Number(req.query.limit) || 24));
  const off = (page - 1) * limit;

  const { country, province, area_type, municipality } = req.query;

  try {
    const countryNorm = String(country || '').toUpperCase();
    const prov = String(province || '').trim();
    const mun = String(municipality || req.query.municipio || '').trim();

    let params = [ownerId];
    let locationSql = 'TRUE';

    // Igual criterio de disponibilidad que en /products, pero forzando owner_id
    if (countryNorm === 'US') {
      locationSql = `
        EXISTS (
          SELECT 1 FROM owner_shipping_config osc
           WHERE osc.owner_id = p.owner_id
             AND osc.active = true
             AND osc.country = 'US'
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
        EXISTS (
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
      `;
    }

    const archivedClause = `
      COALESCE(
        CASE
          WHEN jsonb_typeof(p.metadata->'archived')='boolean' THEN (p.metadata->>'archived')::boolean
          WHEN jsonb_typeof(p.metadata->'archived')='string'  THEN lower(p.metadata->>'archived') IN ('true','t','yes','1')
          ELSE false
        END
      , false) = false
    `;

    const sql = `
      WITH src AS (
        SELECT
          p.id, p.title, p.description, p.title_en, p.description_en,
          p.price, p.weight, p.category_id, p.image_url, p.metadata, p.stock_qty,
          p.owner_id, p.duty_cents, p.keywords,
          o.name AS owner_name
        FROM products p
        LEFT JOIN owners o ON o.id = p.owner_id
        WHERE p.owner_id = $1
          AND ${archivedClause}
          AND ${locationSql}
        ORDER BY p.id DESC
        LIMIT ${limit + 1} OFFSET ${off}
      ),
      calc AS (
        SELECT
          *,
          COALESCE((metadata->>'price_cents')::int, ROUND(price*100)::int) AS base_cents,
          COALESCE(duty_cents, 0)                                          AS duty_cents_safe,
          COALESCE(NULLIF(metadata->>'margin_pct','')::numeric, 0)         AS margin_pct,
          CASE
            WHEN jsonb_typeof(metadata->'taxable')='boolean' THEN (metadata->>'taxable')::boolean
            WHEN jsonb_typeof(metadata->'taxable')='string'  THEN lower(metadata->>'taxable') IN ('true','t','yes','1')
            ELSE true
          END AS taxable,
          COALESCE(NULLIF(metadata->>'tax_pct','')::numeric, 0)            AS tax_pct,
          (COALESCE((metadata->>'price_cents')::int, ROUND(price*100)::int) + COALESCE(duty_cents,0)) AS effective_cents
        FROM src p
      )
      SELECT
        id, title, description, title_en, description_en,
        price, weight, category_id, image_url, metadata, stock_qty,
        owner_id, owner_name, duty_cents, keywords,
        ROUND(effective_cents * (100 + margin_pct) / 100.0)::int AS price_with_margin_cents,
        CASE WHEN taxable
             THEN ROUND((effective_cents * (100 + margin_pct) / 100.0) * tax_pct / 100.0)::int
             ELSE 0 END AS tax_cents,
        (ROUND(effective_cents * (100 + margin_pct) / 100.0)::int
          + CASE WHEN taxable
                 THEN ROUND((effective_cents * (100 + margin_pct) / 100.0) * tax_pct / 100.0)::int
                 ELSE 0 END) AS display_total_cents,
        ROUND(
          (
            ROUND(effective_cents * (100 + margin_pct) / 100.0)::numeric
            + CASE WHEN taxable
                   THEN ROUND((effective_cents * (100 + margin_pct) / 100.0) * tax_pct / 100.0)::numeric
                   ELSE 0 END
          ) / 100.0
        , 2) AS display_total_usd
      FROM calc;
    `;

    const { rows } = await pool.query(sql, params);
    const has_more = rows.length > limit;
    const items = has_more ? rows.slice(0, limit) : rows;

    // nombre para encabezado
    const ownerName = items[0]?.owner_name || null;
    return res.json({ owner: { id: ownerId, name: ownerName }, items, page, limit, has_more });
  } catch (e) {
    console.error('GET /products/owner/:owner_id error', e);
    return res.status(500).json({ error: 'Error al obtener productos del owner' });
  }
});


/* ===================
   GET by id (con precios calculados)
   =================== */
   router.get('/products/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).send('Id inválido');
  
    try {
      const sql = `
        WITH src AS (
          SELECT
            p.id, p.title, p.description, p.title_en, p.description_en,
            p.price, p.weight, p.category_id, p.image_url, p.metadata, p.stock_qty,
            p.owner_id, p.duty_cents, p.keywords
          FROM products p
          WHERE p.id = $1
          LIMIT 1
        ),
        calc AS (
          SELECT
            *,
            COALESCE((metadata->>'price_cents')::int, ROUND(price*100)::int) AS base_cents,
            COALESCE(duty_cents, 0)                                          AS duty_cents_safe,
            COALESCE(NULLIF(metadata->>'margin_pct','')::numeric, 0)         AS margin_pct,
            CASE
              WHEN jsonb_typeof(metadata->'taxable')='boolean' THEN (metadata->>'taxable')::boolean
              WHEN jsonb_typeof(metadata->'taxable')='string'  THEN lower(metadata->>'taxable') IN ('true','t','yes','1')
              ELSE true
            END AS taxable,
            COALESCE(NULLIF(metadata->>'tax_pct','')::numeric, 0)            AS tax_pct,
            (COALESCE((metadata->>'price_cents')::int, ROUND(price*100)::int) + COALESCE(duty_cents,0)) AS effective_cents
          FROM src
        )
        SELECT
          id, title, description, title_en, description_en,
          price, weight, category_id, image_url, metadata, stock_qty,
          owner_id, duty_cents, keywords,
  
          -- precio base + arancel + margen
          ROUND(effective_cents * (100 + margin_pct) / 100.0)::int AS price_with_margin_cents,
          ROUND(ROUND(effective_cents * (100 + margin_pct) / 100.0) / 100.0, 2) AS price_with_margin_usd,
  
          -- impuesto (si aplica)
          CASE WHEN taxable
               THEN ROUND((effective_cents * (100 + margin_pct) / 100.0) * tax_pct / 100.0)::int
               ELSE 0 END AS tax_cents,
  
          -- total final para UI
          (ROUND(effective_cents * (100 + margin_pct) / 100.0)::int
            + CASE WHEN taxable
                   THEN ROUND((effective_cents * (100 + margin_pct) / 100.0) * tax_pct / 100.0)::int
                   ELSE 0 END) AS display_total_cents,
  
          ROUND(
            (
              ROUND(effective_cents * (100 + margin_pct) / 100.0)::numeric
              + CASE WHEN taxable
                     THEN ROUND((effective_cents * (100 + margin_pct) / 100.0) * tax_pct / 100.0)::numeric
                     ELSE 0 END
            ) / 100.0
          , 2) AS display_total_usd
        FROM calc;
      `;
  
      const { rows } = await pool.query(sql, [id]);
      if (!rows.length) return res.status(404).send('Producto no encontrado');
      res.json(rows[0]);
    } catch (error) {
      console.error(error);
      res.status(500).send('Error al obtener producto');
    }
  });
  

/* ===================
   CREATE (admin)
   =================== */
router.post('/products', authenticateToken, requireAdmin, async (req, res) => {
  const {
    title, price, weight, category_id, image_url, description, stock_qty, owner_id,
    title_en, description_en
  } = req.body
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

  // nuevos
  const dutyCents = parseDutyCents(req.body)
  const keywords = parseKeywords(req.body)

  try {
    const result = await pool.query(
      `INSERT INTO products (
         title, description, title_en, description_en,
         price, weight, category_id, image_url,
         metadata, stock_qty, owner_id,
         duty_cents, keywords
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id, title, description, title_en, description_en,
                 price, weight, category_id, image_url, metadata, stock_qty, owner_id,
                 duty_cents, keywords`,
      [
        String(title).trim(),
        description || null,
        title_en ? String(title_en).trim() : null,
        description_en || null,
        price,
        weight || null,
        category_id || null,
        image_url || null,
        JSON.stringify(cleanMeta),
        Number.isInteger(Number(stock_qty)) ? Number(stock_qty) : 0,
        (Number.isInteger(Number(owner_id)) ? Number(owner_id) : null),
        dutyCents,
        keywords.length ? keywords : null,
      ]
    )
    res.status(201).json(result.rows[0])
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al crear producto')
  }
})

/* ===================
   UPDATE (admin)
   =================== */
router.put('/products/:id', authenticateToken, requireAdmin, async (req, res) => {
  const {
    title, price, weight, category_id, image_url, description, stock_qty, owner_id,
    title_en, description_en
  } = req.body

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

  // nuevos
  const dutyCents = parseDutyCents(req.body)
  const keywords = parseKeywords(req.body)

  try {
    const q = `
      UPDATE products
         SET title          = COALESCE($1, title),
             description    = COALESCE($2, description),
             price          = COALESCE($3, price),
             weight         = COALESCE($4, weight),
             category_id    = COALESCE($5, category_id),
             image_url      = COALESCE($6, image_url),
             metadata       = COALESCE(metadata,'{}'::jsonb) || COALESCE($7::jsonb,'{}'::jsonb),
             stock_qty      = COALESCE($8::int, stock_qty),
             owner_id       = COALESCE($9::int, owner_id),
             title_en       = COALESCE($10, title_en),
             description_en = COALESCE($11, description_en),
             duty_cents     = COALESCE($12, duty_cents),
             keywords       = COALESCE($13::text[], keywords)
       WHERE id = $14::int
   RETURNING id, title, description, title_en, description_en,
             price, weight, category_id, image_url, metadata, stock_qty, owner_id,
             duty_cents, keywords
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
      title_en ? String(title_en).trim() : null,
      description_en ?? null,
      dutyCents,
      (keywords.length ? keywords : null),
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

/* ===================
   DELETE (admin, con lógica de archivar si tiene órdenes)
   =================== */
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

/* ===================
   DELETE/ARCHIVE admin back-compat
   =================== */
router.delete('/admin/products/:id', authenticateToken, requireAdmin, async (req, res) => {
  const client = await pool.connect()
  const id = Number(req.params.id)
  try {
    await client.query('BEGIN')
    const prod = await client.query('SELECT id FROM products WHERE id = $1', [id])
    if (!prod.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Producto no encontrado' }) }

    const inOrders = await client.query('SELECT 1 FROM line_items WHERE product_id = $1 LIMIT 1', [id])
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

/* ===================
   ADMIN list
   =================== */
router.get('/admin/products', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { q = '', page = '1', limit = '12', category_id, owner_id, archived = 'all' } = req.query
    const p = Math.max(1, Number(page) || 1)
    const l = Math.min(100, Math.max(1, Number(limit) || 12))
    const off = (p - 1) * l

    const where = []
    const vals = []

    if (q) { vals.push(`%${q}%`); where.push(`(title ILIKE $${vals.length} OR title_en ILIKE $${vals.length} OR EXISTS (SELECT 1 FROM unnest(COALESCE(keywords,'{}')) kw WHERE kw ILIKE $${vals.length}))`) }
    if (category_id) { vals.push(Number(category_id)); where.push(`category_id = $${vals.length}`) }
    if (owner_id != null && owner_id !== '' && !Number.isNaN(Number(owner_id))) {
      vals.push(Number(owner_id)); where.push(`owner_id = $${vals.length}`)
    }
    if (archived === 'true') { where.push(`COALESCE((metadata->>'archived')::boolean, false) = true`) }
    else if (archived === 'false') { where.push(`COALESCE((metadata->>'archived')::boolean, false) = false`) }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const sql = `
      SELECT id, title, description, title_en, description_en,
             price, weight, category_id, image_url, metadata, stock_qty, owner_id,
             duty_cents, keywords,
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

/* ===================
   CATEGORY → PRODUCTS
   =================== */
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
        SELECT id, title, description, title_en, description_en,
               price, weight, category_id, image_url, metadata, stock_qty,
               owner_id, duty_cents, keywords
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
          COALESCE(duty_cents, 0)                                          AS duty_cents_safe,
          COALESCE(NULLIF(metadata->>'margin_pct','')::numeric, 0)         AS margin_pct,
          (COALESCE((metadata->>'price_cents')::int, ROUND(price*100)::int) + COALESCE(duty_cents,0)) AS effective_cents
        FROM src
      )
      SELECT
        id, title, description, title_en, description_en,
        price, weight, category_id, image_url, metadata, stock_qty,
        owner_id, duty_cents, keywords,
        ROUND(effective_cents * (100 + margin_pct) / 100.0)::int AS price_with_margin_cents,
        ROUND(ROUND(effective_cents * (100 + margin_pct) / 100.0) / 100.0, 2) AS price_with_margin_usd
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
