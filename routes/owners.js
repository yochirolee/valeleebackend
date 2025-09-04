// routes/owners.js
const express = require('express');
const { pool } = require('../db');

const ownersRouter = express.Router();         // ADMIN
const ownersPublicRouter = express.Router();   // PUBLIC

function rowsFromShippingPayload(ownerId, cfg = {}) {
  const rows = [];
  if (cfg.us) {
    rows.push({
      owner_id: ownerId, country: 'US', mode: 'fixed', currency: 'USD',
      us_flat: Number(cfg.us.fixed_usd || 0) || 0,
      cu_hab_city_flat: null, cu_hab_rural_flat: null, cu_other_city_flat: null, cu_other_rural_flat: null,
      cu_rate_per_lb: null, cu_hab_city_base: null, cu_hab_rural_base: null, cu_other_city_base: null, cu_other_rural_base: null, cu_min_fee: null,
      active: true,
    });
  }
  if (cfg.cu) {
    const fixed = cfg.cu.fixed || {};
    const byW   = cfg.cu.by_weight || {};
    const mode  = (String(cfg.cu.mode||'fixed').toLowerCase()==='by_weight') ? 'weight' : 'fixed';
    rows.push({
      owner_id: ownerId, country: 'CU', mode, currency: 'USD',
      us_flat: null,
      cu_hab_city_flat: fixed.habana_city ?? null,
      cu_hab_rural_flat: fixed.habana_municipio ?? null,
      cu_other_city_flat: fixed.provincias_city ?? null,
      cu_other_rural_flat: fixed.provincias_municipio ?? null,
      cu_rate_per_lb: byW.rate_per_lb ?? null,
      cu_hab_city_base: byW.base?.habana_city ?? null,
      cu_hab_rural_base: byW.base?.habana_municipio ?? null,
      cu_other_city_base: byW.base?.provincias_city ?? null,
      cu_other_rural_base: byW.base?.provincias_municipio ?? null,
      cu_min_fee: cfg.cu.min_fee ?? null,
      active: true,
    });
  }
  return rows;
}


/* ---------- PUBLIC: opciones para selects ---------- */
ownersPublicRouter.get('/options', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name FROM owners ORDER BY name ASC');
    res.json(rows);
  } catch (e) {
    console.error('GET /owners/options', e);
    res.status(500).json({ error: 'Error al listar owners' });
  }
});

/* ---------- ADMIN: CRUD completo ---------- */
// LIST
ownersRouter.get('/', async (_req, res) => {
  try {
    const sql = `
      SELECT
        o.id,
        o.name,
        o.email,
        o.phone,

        -- Construimos el JSON de shipping_config efectivo
        jsonb_build_object(
          'us', jsonb_build_object(
            'fixed_usd', osc_us.us_flat
          ),
          'cu', jsonb_build_object(
            'mode', CASE WHEN osc_cu.mode = 'weight' THEN 'by_weight' ELSE 'fixed' END,
            'fixed', jsonb_build_object(
              'habana_city',         osc_cu.cu_hab_city_flat,
              'habana_municipio',    osc_cu.cu_hab_rural_flat,
              'provincias_city',     osc_cu.cu_other_city_flat,
              'provincias_municipio',osc_cu.cu_other_rural_flat
            ),
            'by_weight', jsonb_build_object(
              'rate_per_lb', osc_cu.cu_rate_per_lb,
              'base', jsonb_build_object(
                'habana_city',         osc_cu.cu_hab_city_base,
                'habana_municipio',    osc_cu.cu_hab_rural_base,
                'provincias_city',     osc_cu.cu_other_city_base,
                'provincias_municipio',osc_cu.cu_other_rural_base
              )
            ),
            'min_fee', osc_cu.cu_min_fee
          ),
          'cu_restrict_to_list', COALESCE(osc_cu.cu_restrict_to_list, false)
        ) AS shipping_config

      FROM owners o
      LEFT JOIN owner_shipping_config osc_us
        ON osc_us.owner_id = o.id AND osc_us.country = 'US'
      LEFT JOIN owner_shipping_config osc_cu
        ON osc_cu.owner_id = o.id AND osc_cu.country = 'CU'
      ORDER BY o.id DESC;
    `;

    const { rows } = await pool.query(sql);
    res.json(rows);
  } catch (e) {
    console.error('GET /admin/owners error', e);
    res.status(500).json({ error: 'Error al listar owners' });
  }
});

// GET one
ownersRouter.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, phone, shipping_config
         FROM owners
        WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Owner no encontrado' });
    res.json(rows[0]);
  } catch (e) {
    console.error('GET /admin/owners/:id', e);
    res.status(500).json({ error: 'Error al obtener owner' });
  }
});

// CREATE
ownersRouter.post('/', async (req, res) => {
  const { name, email, phone, shipping_config } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'name y email requeridos' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // crea el owner (opcional: guardas el JSON para mostrar en admin)
    const { rows } = await client.query(
      `INSERT INTO owners (name, email, phone, shipping_config)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id, name, email, phone, shipping_config`,
      [String(name), String(email), phone || null, JSON.stringify(shipping_config || {})]
    );
    const owner = rows[0];

    // inserta/actualiza tarifas directamente en owner_shipping_config
    const shipRows = rowsFromShippingPayload(owner.id, shipping_config || {});
    for (const r of shipRows) {
      await client.query(
        `INSERT INTO owner_shipping_config (
           owner_id,country,mode,currency,
           us_flat,
           cu_hab_city_flat,cu_hab_rural_flat,cu_other_city_flat,cu_other_rural_flat,
           cu_rate_per_lb,cu_hab_city_base,cu_hab_rural_base,cu_other_city_base,cu_other_rural_base,cu_min_fee,
           active
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (owner_id,country) DO UPDATE SET
           mode=EXCLUDED.mode,currency=EXCLUDED.currency,us_flat=EXCLUDED.us_flat,
           cu_hab_city_flat=EXCLUDED.cu_hab_city_flat,cu_hab_rural_flat=EXCLUDED.cu_hab_rural_flat,
           cu_other_city_flat=EXCLUDED.cu_other_city_flat,cu_other_rural_flat=EXCLUDED.cu_other_rural_flat,
           cu_rate_per_lb=EXCLUDED.cu_rate_per_lb,
           cu_hab_city_base=EXCLUDED.cu_hab_city_base,cu_hab_rural_base=EXCLUDED.cu_hab_rural_base,
           cu_other_city_base=EXCLUDED.cu_other_city_base,cu_other_rural_base=EXCLUDED.cu_other_rural_base,
           cu_min_fee=EXCLUDED.cu_min_fee,active=EXCLUDED.active`,
        [
          r.owner_id, r.country, r.mode, r.currency,
          r.us_flat,
          r.cu_hab_city_flat, r.cu_hab_rural_flat, r.cu_other_city_flat, r.cu_other_rural_flat,
          r.cu_rate_per_lb, r.cu_hab_city_base, r.cu_hab_rural_base, r.cu_other_city_base, r.cu_other_rural_base, r.cu_min_fee,
          r.active
        ]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(owner);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /admin/owners', e);
    res.status(500).json({ error: 'Error al crear owner' });
  } finally {
    client.release();
  }
});

// UPDATE
ownersRouter.put('/:id', async (req, res) => {
  const { name, email, phone, shipping_config } = req.body || {};
  const id = Number(req.params.id);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Actualiza datos básicos del owner (guarda el JSON si lo quieres seguir mostrando en el admin)
    const { rows } = await client.query(
      `UPDATE owners
          SET name = COALESCE($1, name),
              email = COALESCE($2, email),
              phone = COALESCE($3, phone),
              shipping_config = COALESCE($4::jsonb, shipping_config)
        WHERE id = $5
      RETURNING id, name, email, phone, shipping_config`,
      [name ?? null, email ?? null, phone ?? null,
       shipping_config ? JSON.stringify(shipping_config) : null, id]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Owner no encontrado' }); }

    // Si viene shipping_config en el payload, upsert directo en owner_shipping_config
    if (shipping_config && typeof shipping_config === 'object') {
      const shipRows = rowsFromShippingPayload(id, shipping_config);
      for (const r of shipRows) {
        await client.query(
          `INSERT INTO owner_shipping_config (
             owner_id,country,mode,currency,
             us_flat,
             cu_hab_city_flat,cu_hab_rural_flat,cu_other_city_flat,cu_other_rural_flat,
             cu_rate_per_lb,cu_hab_city_base,cu_hab_rural_base,cu_other_city_base,cu_other_rural_base,cu_min_fee,
             active
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (owner_id,country) DO UPDATE SET
             mode=EXCLUDED.mode,currency=EXCLUDED.currency,us_flat=EXCLUDED.us_flat,
             cu_hab_city_flat=EXCLUDED.cu_hab_city_flat,cu_hab_rural_flat=EXCLUDED.cu_hab_rural_flat,
             cu_other_city_flat=EXCLUDED.cu_other_city_flat,cu_other_rural_flat=EXCLUDED.cu_other_rural_flat,
             cu_rate_per_lb=EXCLUDED.cu_rate_per_lb,
             cu_hab_city_base=EXCLUDED.cu_hab_city_base,cu_hab_rural_base=EXCLUDED.cu_hab_rural_base,
             cu_other_city_base=EXCLUDED.cu_other_city_base,cu_other_rural_base=EXCLUDED.cu_other_rural_base,
             cu_min_fee=EXCLUDED.cu_min_fee,active=EXCLUDED.active`,
          [
            r.owner_id, r.country, r.mode, r.currency,
            r.us_flat,
            r.cu_hab_city_flat, r.cu_hab_rural_flat, r.cu_other_city_flat, r.cu_other_rural_flat,
            r.cu_rate_per_lb, r.cu_hab_city_base, r.cu_hab_rural_base, r.cu_other_city_base, r.cu_other_rural_base, r.cu_min_fee,
            r.active
          ]
        );
      }
    }

    await client.query('COMMIT');
    return res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('PUT /admin/owners/:id', e);
    return res.status(500).json({ error: 'Error al actualizar owner' });
  } finally {
    client.release();
  }
});

// DELETE (si no tiene productos)
ownersRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const used = await pool.query('SELECT 1 FROM products WHERE owner_id = $1 LIMIT 1', [id]);
    if (used.rows.length) {
      return res.status(409).json({ error: 'No se puede borrar: hay productos que referencian este owner.' });
    }
    const del = await pool.query('DELETE FROM owners WHERE id = $1 RETURNING id', [id]);
    if (!del.rows.length) return res.status(404).json({ error: 'Owner no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /admin/owners/:id', e);
    res.status(500).json({ error: 'Error al eliminar owner' });
  }
});

// ⚙️ Guardar shipping-config de un owner (ADMIN)
// Ruta completa: PUT /admin/owners/:ownerId/shipping-config
ownersRouter.put('/:ownerId/shipping-config', async (req, res) => {
  const ownerId = Number(req.params.ownerId);
  const cfg = req.body || {};

  const cuRestrict = !!cfg.cu_restrict_to_list; // flag

  const cuMode = (cfg.cu?.mode === 'by_weight') ? 'weight' : 'fixed';

  const fixed = cfg.cu?.fixed || {};
  const byW   = cfg.cu?.by_weight || {};
  const base  = byW.base || {};

  const usFixed = cfg.us?.fixed_usd ?? null;

  const cuHabCityFlat   = fixed.habana_city ?? null;
  const cuHabRuralFlat  = fixed.habana_municipio ?? null;
  const cuOtherCityFlat = fixed.provincias_city ?? null;
  const cuOtherRuralFlat= fixed.provincias_municipio ?? null;

  const cuRatePerLb     = byW.rate_per_lb ?? null;
  const cuHabCityBase   = base.habana_city ?? null;
  const cuHabRuralBase  = base.habana_municipio ?? null;
  const cuOtherCityBase = base.provincias_city ?? null;
  const cuOtherRuralBase= base.provincias_municipio ?? null;

  const cuMinFee        = cfg.cu?.min_fee ?? null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // US: incluir mode='fixed' para satisfacer NOT NULL (si aplica)
    await client.query(`
      INSERT INTO owner_shipping_config (owner_id, country, active, mode, us_flat)
      VALUES ($1, 'US', true, 'fixed', $2)
      ON CONFLICT (owner_id, country) DO UPDATE
        SET active = EXCLUDED.active,
            mode   = EXCLUDED.mode,
            us_flat= EXCLUDED.us_flat
    `, [ownerId, usFixed]);

    // CU (incluye el flag cu_restrict_to_list)
    await client.query(`
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

    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('PUT /admin/owners/:ownerId/shipping-config error', e);
    return res.status(500).json({ error: 'No se pudo actualizar shipping_config' });
  } finally {
    client.release();
  }
});


module.exports = { ownersRouter, ownersPublicRouter };
