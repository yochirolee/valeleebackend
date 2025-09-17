// routes/shipping.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const authenticateToken = require('../middleware/authenticateToken');

function zoneKeyForCuba(province, area_type) {
  const isHabana = String(province || '').trim().toLowerCase() === 'la habana';
  const isCity = (area_type === 'city');
  if (isHabana) return isCity ? 'habana_city' : 'habana_municipio';
  return isCity ? 'provincias_city' : 'provincias_municipio';
}
function toCents(usd) { const n = Number(usd); return Number.isFinite(n) ? Math.round(n * 100) : 0; }

router.post('/quote', authenticateToken, async (req, res) => {
  const { cartId, shipping } = req.body || {};
  if (!cartId || !shipping || !shipping.country) {
    return res.status(400).json({ ok: false, message: 'cartId y shipping.country son requeridos' });
  }
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ ok: false, message: 'Unauthorized' });

  const client = await pool.connect();
  try {
    const cartQ = await client.query(
      `SELECT id, customer_id FROM carts WHERE id = $1 AND customer_id = $2`,
      [cartId, userId]
    );
    if (!cartQ.rows.length) return res.status(404).json({ ok: false, message: 'Carrito no encontrado' });

    const country = String(shipping.country || '').toUpperCase();
    const prov = String(shipping.province || shipping.provincia || '').trim();
    const mun  = String(shipping.municipality || shipping.municipio || '').trim();
    const areaType = shipping.area_type; // 'city' | 'municipio'
    const transport = (country === 'CU' ? String(shipping.transport || 'sea') : null); // 'sea'|'air'
    const zoneKey = country === 'CU' ? zoneKeyForCuba(prov, areaType) : null;

    const itemsQ = await client.query(
      `
      SELECT
        p.owner_id,
        o.name AS owner_name,
        osc.mode,
        osc.us_flat,
        osc.cu_rate_per_lb,
        osc.cu_hab_city_flat,   osc.cu_hab_rural_flat,
        osc.cu_other_city_flat, osc.cu_other_rural_flat,
        osc.cu_hab_city_base,   osc.cu_hab_rural_base,
        osc.cu_other_city_base, osc.cu_other_rural_base,
        osc.cu_min_fee,
        COALESCE(osc.cu_restrict_to_list, false) AS cu_restrict_to_list,
        COALESCE(osc.cu_over_weight_threshold_lbs, 100) AS over_thr_lbs,
        COALESCE(osc.cu_over_weight_fee, 0) AS over_fee_usd,

        SUM(COALESCE(p.weight,0) * ci.quantity) AS total_weight,

        CASE
          WHEN $2 = 'CU' AND COALESCE(osc.cu_restrict_to_list, false) = true THEN
            EXISTS (
              SELECT 1 FROM owner_cu_areas oa
               WHERE oa.owner_id = p.owner_id
                 AND lower(oa.province) = lower($3)
                 AND (oa.municipality IS NULL OR lower(oa.municipality) = lower($4))
            )
          ELSE true
        END AS allowed_area
      FROM cart_items ci
      JOIN products p ON p.id = ci.product_id
      LEFT JOIN owners o ON o.id = p.owner_id
      LEFT JOIN owner_shipping_config osc
        ON osc.owner_id = p.owner_id
       AND osc.active   = true
       AND osc.country  = $2
       AND ($2 <> 'CU' OR osc.cu_transport = $5)
      WHERE ci.cart_id = $1
      GROUP BY
        p.owner_id, o.name,
        osc.mode, osc.us_flat, osc.cu_rate_per_lb,
        osc.cu_hab_city_flat, osc.cu_hab_rural_flat, osc.cu_other_city_flat, osc.cu_other_rural_flat,
        osc.cu_hab_city_base, osc.cu_hab_rural_base, osc.cu_other_city_base, osc.cu_other_rural_base,
        osc.cu_min_fee, osc.cu_restrict_to_list, osc.cu_over_weight_threshold_lbs, osc.cu_over_weight_fee
      ORDER BY p.owner_id ASC
      `,
      [cartId, country, prov, mun, transport]
    );

    const breakdown = [];
    const unavailable = [];
    let totalCents = 0;

    for (const row of itemsQ.rows) {
      const ownerId   = row.owner_id || null;
      const ownerName = row.owner_name || 'Sin owner';
      const weight    = Number(row.total_weight || 0);

      if (country === 'CU' && row.cu_restrict_to_list && !row.allowed_area) {
        unavailable.push({ owner_id: ownerId, owner_name: ownerName });
        continue;
      }

      let cents = 0;
      let mode  = 'none';

      if (country === 'US') {
        cents = toCents(Number(row.us_flat || 0));
        mode  = 'fixed';
      } else {
        const cfgMode = String(row.mode || 'fixed').toLowerCase();
        if (cfgMode === 'weight') {
          mode = 'by_weight';
          const rate = Number(row.cu_rate_per_lb || 0);
          const base =
            zoneKey === 'habana_city'          ? Number(row.cu_hab_city_base || 0) :
            zoneKey === 'habana_municipio'     ? Number(row.cu_hab_rural_base || 0) :
            zoneKey === 'provincias_city'      ? Number(row.cu_other_city_base || 0) :
            zoneKey === 'provincias_municipio' ? Number(row.cu_other_rural_base || 0) : 0;
          const usd = Math.max(base + rate * (Number(weight) || 0), Number(row.cu_min_fee || 0));
          cents = toCents(usd);
        } else {
          mode = 'fixed';
          const usd =
            zoneKey === 'habana_city'          ? Number(row.cu_hab_city_flat || 0) :
            zoneKey === 'habana_municipio'     ? Number(row.cu_hab_rural_flat || 0) :
            zoneKey === 'provincias_city'      ? Number(row.cu_other_city_flat || 0) :
            zoneKey === 'provincias_municipio' ? Number(row.cu_other_rural_flat || 0) : 0;
          cents = toCents(usd);
        }

        const thr = Number(row.over_thr_lbs || 0);
        const fee = Number(row.over_fee_usd || 0);
        if (thr > 0 && fee > 0 && Number(weight) > thr) {
          cents += toCents(fee);
        }
      }

      breakdown.push({
        owner_id: ownerId,
        owner_name: ownerName,
        mode,
        transport: transport,
        weight_lb: Number.isFinite(weight) ? Number(weight.toFixed(2)) : 0,
        shipping_cents: cents,
      });
      totalCents += cents;
    }

    if (unavailable.length) {
      return res.status(409).json({
        ok: false,
        message: 'Hay productos que no se pueden entregar a esa dirección.',
        unavailable,
        shipping_total_cents: totalCents,
        breakdown
      });
    }

    return res.json({
      ok: true,
      country,
      transport,
      zone: zoneKey,
      shipping_total_cents: totalCents,
      breakdown,
    });
  } catch (e) {
    console.error('POST /shipping/quote error', e);
    return res.status(500).json({ ok: false, message: 'Error calculando envío' });
  } finally {
    client.release();
  }
});

module.exports = router;
