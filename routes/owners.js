// routes/owners.js
const express = require('express');
const { pool } = require('../db');

const ownersRouter = express.Router();         // ADMIN
const ownersPublicRouter = express.Router();   // PUBLIC

/**
 * rowsFromShippingPayload:
 * - Acepta estructura NUEVA:
 *   {
 *     us: { fixed_usd },
 *     cu: {
 *       sea: { mode, fixed, by_weight, min_fee, over_weight_threshold_lbs, over_weight_fee },
 *       air: { ...mismo schema... }
 *     },
 *     cu_restrict_to_list: boolean
 *   }
 * - Soporta LEGACY (cfg.cu.mode/fixed/by_weight/min_fee) -> lo guarda como 'sea' por defecto
 */
function rowsFromShippingPayload(ownerId, cfg = {}) {
  const rows = [];

  // US
  if (cfg.us) {
    rows.push({
      owner_id: ownerId, country: 'US', cu_transport: null,
      mode: 'fixed', currency: 'USD',
      us_flat: Number(cfg.us.fixed_usd || 0) || 0,

      cu_hab_city_flat: null, cu_hab_rural_flat: null, cu_other_city_flat: null, cu_other_rural_flat: null,
      cu_rate_per_lb: null,
      cu_hab_city_base: null, cu_hab_rural_base: null, cu_other_city_base: null, cu_other_rural_base: null,
      cu_min_fee: null,

      cu_restrict_to_list: null,
      cu_over_weight_threshold_lbs: null,
      cu_over_weight_fee: null,

      active: true,
    });
  }

  // Helper para armar fila CU por transporte
  const buildCuRow = (transport, cuCfg, restrictFlag) => {
    if (!cuCfg) return null;
    const fixed = cuCfg.fixed || {};
    const byW   = cuCfg.by_weight || {};
    const mode  = (String(cuCfg.mode || 'fixed').toLowerCase() === 'by_weight') ? 'weight' : 'fixed';
    return {
      owner_id: ownerId, country: 'CU', cu_transport: transport,
      mode, currency: 'USD',
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

      cu_min_fee: cuCfg.min_fee ?? null,

      cu_restrict_to_list: !!restrictFlag,
      cu_over_weight_threshold_lbs: cuCfg.over_weight_threshold_lbs ?? 100,
      cu_over_weight_fee: cuCfg.over_weight_fee ?? 0,

      active: true,
    };
  };

  const restrictFlag = !!cfg.cu_restrict_to_list;

  // NUEVO esquema (sea/air)
  if (cfg.cu && (cfg.cu.sea || cfg.cu.air)) {
    const seaRow = buildCuRow('sea', cfg.cu.sea, restrictFlag);
    const airRow = buildCuRow('air', cfg.cu.air, restrictFlag);
    if (seaRow) rows.push(seaRow);
    if (airRow) rows.push(airRow);
  } else if (cfg.cu) {
    // LEGACY: una sola fila CU, la guardamos como 'sea'
    const legacy = buildCuRow('sea', cfg.cu, restrictFlag);
    if (legacy) rows.push(legacy);
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

// LIST (devuelve shipping_config con ramas cu.sea y cu.air)
ownersRouter.get('/', async (_req, res) => {
  try {
    const sql = `
      SELECT
        o.id,
        o.name,
        o.email,
        o.phone,

        -- US (cualquier fila country='US', tomamos us_flat)
        (SELECT us_flat
           FROM owner_shipping_config x
          WHERE x.owner_id = o.id AND x.country = 'US'
          ORDER BY id DESC LIMIT 1) AS us_flat,

        -- CU SEA
        (SELECT row_to_json(r) FROM (
          SELECT
            CASE WHEN x.mode = 'weight' THEN 'by_weight' ELSE 'fixed' END AS mode,
            jsonb_build_object(
              'habana_city',          x.cu_hab_city_flat,
              'habana_municipio',     x.cu_hab_rural_flat,
              'provincias_city',      x.cu_other_city_flat,
              'provincias_municipio', x.cu_other_rural_flat
            ) AS fixed,
            jsonb_build_object(
              'rate_per_lb', x.cu_rate_per_lb,
              'base', jsonb_build_object(
                'habana_city',          x.cu_hab_city_base,
                'habana_municipio',     x.cu_hab_rural_base,
                'provincias_city',      x.cu_other_city_base,
                'provincias_municipio', x.cu_other_rural_base
              )
            ) AS by_weight,
            x.cu_min_fee AS min_fee,
            x.cu_over_weight_threshold_lbs AS over_weight_threshold_lbs,
            x.cu_over_weight_fee AS over_weight_fee
          FROM owner_shipping_config x
          WHERE x.owner_id = o.id AND x.country = 'CU' AND x.cu_transport = 'sea'
          ORDER BY id DESC LIMIT 1
        ) r) AS cu_sea,

        -- CU AIR
        (SELECT row_to_json(r) FROM (
          SELECT
            CASE WHEN x.mode = 'weight' THEN 'by_weight' ELSE 'fixed' END AS mode,
            jsonb_build_object(
              'habana_city',          x.cu_hab_city_flat,
              'habana_municipio',     x.cu_hab_rural_flat,
              'provincias_city',      x.cu_other_city_flat,
              'provincias_municipio', x.cu_other_rural_flat
            ) AS fixed,
            jsonb_build_object(
              'rate_per_lb', x.cu_rate_per_lb,
              'base', jsonb_build_object(
                'habana_city',          x.cu_hab_city_base,
                'habana_municipio',     x.cu_hab_rural_base,
                'provincias_city',      x.cu_other_city_base,
                'provincias_municipio', x.cu_other_rural_base
              )
            ) AS by_weight,
            x.cu_min_fee AS min_fee,
            x.cu_over_weight_threshold_lbs AS over_weight_threshold_lbs,
            x.cu_over_weight_fee AS over_weight_fee
          FROM owner_shipping_config x
          WHERE x.owner_id = o.id AND x.country = 'CU' AND x.cu_transport = 'air'
          ORDER BY id DESC LIMIT 1
        ) r) AS cu_air,

        -- Flag de restricción (si cualquiera de las ramas lo tiene en true)
        COALESCE(
          (SELECT x.cu_restrict_to_list::bool
             FROM owner_shipping_config x
            WHERE x.owner_id = o.id AND x.country = 'CU' AND x.cu_transport = 'sea'
            ORDER BY id DESC LIMIT 1),
          (SELECT x.cu_restrict_to_list::bool
             FROM owner_shipping_config x
            WHERE x.owner_id = o.id AND x.country = 'CU' AND x.cu_transport = 'air'
            ORDER BY id DESC LIMIT 1),
          false
        ) AS cu_restrict_to_list

      FROM owners o
      ORDER BY o.id DESC;
    `;

    const { rows } = await pool.query(sql);

    // Construir shipping_config JSON final
    const out = rows.map(r => ({
      id: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      shipping_config: {
        us: { fixed_usd: r.us_flat ?? null },
        cu: {
          ...(r.cu_sea ? { sea: r.cu_sea } : {}),
          ...(r.cu_air ? { air: r.cu_air } : {})
        },
        cu_restrict_to_list: !!r.cu_restrict_to_list
      }
    }));

    res.json(out);
  } catch (e) {
    console.error('GET /admin/owners error', e);
    res.status(500).json({ error: 'Error al listar owners' });
  }
});

// GET one (sin tocar)
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

    const { rows } = await client.query(
      `INSERT INTO owners (name, email, phone, shipping_config)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id, name, email, phone, shipping_config`,
      [String(name), String(email), phone || null, JSON.stringify(shipping_config || {})]
    );
    const owner = rows[0];

    // Inserta/actualiza tarifas en owner_shipping_config (US + CU sea/air)
    const shipRows = rowsFromShippingPayload(owner.id, shipping_config || {});
    for (const r of shipRows) {
      await client.query(
        `INSERT INTO owner_shipping_config (
           owner_id, country, cu_transport, mode, currency,
           us_flat,
           cu_hab_city_flat, cu_hab_rural_flat, cu_other_city_flat, cu_other_rural_flat,
           cu_rate_per_lb, cu_hab_city_base, cu_hab_rural_base, cu_other_city_base, cu_other_rural_base,
           cu_min_fee,
           cu_restrict_to_list,
           cu_over_weight_threshold_lbs, cu_over_weight_fee,
           active
         ) VALUES (
           $1,$2,$3,$4,$5,
           $6,
           $7,$8,$9,$10,
           $11,$12,$13,$14,$15,
           $16,
           $17,
           $18,$19,
           $20
         )
         ON CONFLICT (owner_id, country, COALESCE(cu_transport,'_')) DO UPDATE SET
           mode = EXCLUDED.mode,
           currency = EXCLUDED.currency,
           us_flat = EXCLUDED.us_flat,
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
           cu_restrict_to_list = EXCLUDED.cu_restrict_to_list,
           cu_over_weight_threshold_lbs = EXCLUDED.cu_over_weight_threshold_lbs,
           cu_over_weight_fee = EXCLUDED.cu_over_weight_fee,
           active = EXCLUDED.active`,
        [
          r.owner_id, r.country, r.cu_transport, r.mode, r.currency,
          r.us_flat,
          r.cu_hab_city_flat, r.cu_hab_rural_flat, r.cu_other_city_flat, r.cu_other_rural_flat,
          r.cu_rate_per_lb, r.cu_hab_city_base, r.cu_hab_rural_base, r.cu_other_city_base, r.cu_other_rural_base,
          r.cu_min_fee,
          r.cu_restrict_to_list,
          r.cu_over_weight_threshold_lbs, r.cu_over_weight_fee,
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

// UPDATE (perfil básico + opcional shipping_config)
ownersRouter.put('/:id', async (req, res) => {
  const { name, email, phone, shipping_config } = req.body || {};
  const id = Number(req.params.id);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

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

    if (shipping_config && typeof shipping_config === 'object') {
      const shipRows = rowsFromShippingPayload(id, shipping_config);
      for (const r of shipRows) {
        await client.query(
          `INSERT INTO owner_shipping_config (
             owner_id, country, cu_transport, mode, currency,
             us_flat,
             cu_hab_city_flat, cu_hab_rural_flat, cu_other_city_flat, cu_other_rural_flat,
             cu_rate_per_lb, cu_hab_city_base, cu_hab_rural_base, cu_other_city_base, cu_other_rural_base,
             cu_min_fee,
             cu_restrict_to_list,
             cu_over_weight_threshold_lbs, cu_over_weight_fee,
             active
           ) VALUES (
             $1,$2,$3,$4,$5,
             $6,
             $7,$8,$9,$10,
             $11,$12,$13,$14,$15,
             $16,
             $17,
             $18,$19,
             $20
           )
           ON CONFLICT (owner_id, country, COALESCE(cu_transport,'_')) DO UPDATE SET
             mode = EXCLUDED.mode,
             currency = EXCLUDED.currency,
             us_flat = EXCLUDED.us_flat,
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
             cu_restrict_to_list = EXCLUDED.cu_restrict_to_list,
             cu_over_weight_threshold_lbs = EXCLUDED.cu_over_weight_threshold_lbs,
             cu_over_weight_fee = EXCLUDED.cu_over_weight_fee,
             active = EXCLUDED.active`,
          [
            r.owner_id, r.country, r.cu_transport, r.mode, r.currency,
            r.us_flat,
            r.cu_hab_city_flat, r.cu_hab_rural_flat, r.cu_other_city_flat, r.cu_other_rural_flat,
            r.cu_rate_per_lb, r.cu_hab_city_base, r.cu_hab_rural_base, r.cu_other_city_base, r.cu_other_rural_base,
            r.cu_min_fee,
            r.cu_restrict_to_list,
            r.cu_over_weight_threshold_lbs, r.cu_over_weight_fee,
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

/**
 * PUT /admin/owners/:ownerId/shipping-config
 * Guarda:
 *  - US: { fixed_usd }
 *  - CU SEA: cu.sea {...}
 *  - CU AIR: cu.air {...}
 *  - cu_restrict_to_list
 */
ownersRouter.put('/:ownerId/shipping-config', async (req, res) => {
  const ownerId = Number(req.params.ownerId);
  const body = req.body || {};
  const us = body.us || {};
  const cu = body.cu || {};
  const restrict = !!body.cu_restrict_to_list;

  if (!ownerId) return res.status(400).json({ error: 'ownerId inválido' });

  const client = await pool.connect();

  async function upsertCfg(country, transport, payload) {
    const mode = (payload?.mode === 'by_weight') ? 'weight' : 'fixed';
    const fx = payload?.fixed || {};
    const bw = payload?.by_weight || {};
    const bases = bw?.base || {};

    const params = [
      ownerId, country, transport, mode, 'USD',
      us?.fixed_usd ?? null,
      // fixed
      fx.habana_city ?? null,
      fx.habana_municipio ?? null,
      fx.provincias_city ?? null,
      fx.provincias_municipio ?? null,
      // weight
      bw.rate_per_lb ?? null,
      bases.habana_city ?? null,
      bases.habana_municipio ?? null,
      bases.provincias_city ?? null,
      bases.provincias_municipio ?? null,
      // min & flags
      payload?.min_fee ?? null,
      restrict ? true : false,
      payload?.over_weight_threshold_lbs ?? 100,
      payload?.over_weight_fee ?? 0
    ];

    await client.query(
      `
      INSERT INTO owner_shipping_config (
        owner_id, country, cu_transport, mode, currency,
        us_flat,
        cu_hab_city_flat, cu_hab_rural_flat, cu_other_city_flat, cu_other_rural_flat,
        cu_rate_per_lb, cu_hab_city_base, cu_hab_rural_base, cu_other_city_base, cu_other_rural_base,
        cu_min_fee,
        cu_restrict_to_list,
        cu_over_weight_threshold_lbs, cu_over_weight_fee,
        active
      ) VALUES (
        $1,$2,$3,$4,$5,
        $6,
        $7,$8,$9,$10,
        $11,$12,$13,$14,$15,
        $16,
        $17,
        $18,$19,
        true
      )
      ON CONFLICT (owner_id, country, COALESCE(cu_transport,'_'))
      DO UPDATE SET
        mode = EXCLUDED.mode,
        currency = EXCLUDED.currency,
        us_flat = EXCLUDED.us_flat,
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
        cu_restrict_to_list = EXCLUDED.cu_restrict_to_list,
        cu_over_weight_threshold_lbs = EXCLUDED.cu_over_weight_threshold_lbs,
        cu_over_weight_fee  = EXCLUDED.cu_over_weight_fee,
        active = true
      `,
      params
    );
  }

  try {
    await client.query('BEGIN');

    // US
    if (typeof us.fixed_usd === 'number') {
      await upsertCfg('US', null, { mode: 'fixed' }); // us_fixed via params[5]
    }

    // CU SEA / AIR (si vienen)
    if (cu.sea) await upsertCfg('CU', 'sea', cu.sea);
    if (cu.air) await upsertCfg('CU', 'air', cu.air);

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('PUT /admin/owners/:ownerId/shipping-config error', e);
    res.status(500).json({ error: 'No se pudo guardar shipping-config' });
  } finally {
    client.release();
  }
});

module.exports = { ownersRouter, ownersPublicRouter };
