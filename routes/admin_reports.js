// routes/adminReports.js
const express = require('express')
const router = express.Router()
const { pool } = require('../db')
const authenticateToken = require('../middleware/authenticateToken')
const { requireAdmin } = require('../middleware/roles')

// GET /admin/reports/payouts?from=YYYY-MM-DD&to=YYYY-MM-DD&owner_id=NUM&delivered_only=1
router.get('/payouts', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // --------- Parámetros ----------
    const today = new Date().toISOString().slice(0, 10)
    const qFrom = String(req.query.from || today)
    const qTo = String(req.query.to || today)
    const ownerId = req.query.owner_id != null && req.query.owner_id !== ''
      ? Number(req.query.owner_id)
      : null
    const deliveredOnly = ['1', 'true', 'yes', 'on'].includes(String(req.query.delivered_only || '1').toLowerCase())

    // --------- SQL principal ----------
    // NOTAS:
    // - Cada orden es de UN owner (o.owner_id). Usamos eso.
    // - Shipping y card fee: leemos directo de orders.metadata.pricing_cents.*
    // - Margen por línea: preferimos snapshot (unit_cents_snapshot - base_cents). Fallback a margin_pct si falta.
    const rowsSQL = `
      WITH params AS (
  SELECT
    $1::date    AS dfrom,
    $2::date    AS dto,
    $3::int     AS owner_filter,
    $4::boolean AS delivered_only,
    $5::boolean AS include_paid,
    'America/New_York'::text AS tz
),
bounds AS (
  SELECT
    (dfrom::timestamp AT TIME ZONE tz)      AS ts_from,
    ((dto + 1)::timestamp AT TIME ZONE tz)  AS ts_to
  FROM params
),

orders_filt AS (
  SELECT o.*
  FROM orders o, params pa, bounds b
  WHERE (pa.owner_filter IS NULL OR o.owner_id = pa.owner_filter)
    AND (
      CASE
        WHEN pa.delivered_only
          THEN (o.delivered_at IS NOT NULL AND o.delivered_at >= b.ts_from AND o.delivered_at < b.ts_to)
        ELSE (o.created_at >= b.ts_from AND o.created_at < b.ts_to)
      END
    )
    AND (pa.include_paid IS TRUE OR COALESCE(o.owner_paid, false) = false)
    ),

      li_per_order AS (
        SELECT
          o.owner_id,
          li.order_id,
          SUM(li.quantity)::int AS items_count,
          SUM( COALESCE((li.metadata->>'base_cents')::int, 0) * li.quantity )::int AS base_cents,
          -- margen por línea (unit - base). Si falta unit, fallback a base*margin_pct/100.
          SUM(
            CASE
              WHEN COALESCE((li.metadata->>'unit_cents_snapshot')::int, 0) > 0
                THEN ( (COALESCE((li.metadata->>'unit_cents_snapshot')::int, 0)
                      - COALESCE((li.metadata->>'base_cents')::int, 0)) * li.quantity )
              ELSE ( ROUND( COALESCE((li.metadata->>'base_cents')::int, 0)
                           * COALESCE(NULLIF(li.metadata->>'margin_pct','')::numeric, 0) / 100.0 )::int * li.quantity )
            END
          )::int AS margin_cents,
          SUM( COALESCE((li.metadata->>'tax_cents_snapshot')::int, 0) * li.quantity )::int AS tax_cents
        FROM line_items li
        JOIN orders_filt o ON o.id = li.order_id
        GROUP BY o.owner_id, li.order_id
      ),

      ship_fee_per_order AS (
        SELECT
          o.owner_id,
          o.id AS order_id,
          COALESCE((o.metadata->'pricing_cents'->>'shipping_total_cents')::int, 0)     AS shipping_owner_cents,
          COALESCE((o.metadata->'pricing_cents'->>'card_fee_cents')::int, 0)           AS gateway_fee_cents
        FROM orders_filt o
      ),

      per_order AS (
        SELECT
          COALESCE(l.owner_id, s.owner_id) AS owner_id,
          COALESCE(l.order_id, s.order_id) AS order_id,
          COALESCE(l.items_count,0)        AS items_count,
          COALESCE(l.base_cents,0)         AS base_cents,
          COALESCE(l.margin_cents,0)       AS margin_cents,
          COALESCE(l.tax_cents,0)          AS tax_cents,
          COALESCE(s.shipping_owner_cents,0) AS shipping_owner_cents,
          COALESCE(s.gateway_fee_cents,0)    AS gateway_fee_cents
        FROM li_per_order l
        FULL OUTER JOIN ship_fee_per_order s
          ON s.order_id = l.order_id
      ),

      agg AS (
        SELECT
          p.owner_id,
          COUNT(DISTINCT p.order_id)                 AS orders_count,
          SUM(p.items_count)                         AS items_count,
          SUM(p.base_cents)                          AS base_cents,
          SUM(p.margin_cents)                        AS margin_cents,
          SUM(p.tax_cents)                           AS tax_cents,
          SUM(p.shipping_owner_cents)                AS shipping_owner_cents,
          SUM(p.gateway_fee_cents)                   AS gateway_fee_cents
        FROM per_order p
        GROUP BY p.owner_id
      )

      SELECT
        a.owner_id,
        ow.name AS owner_name,
        a.orders_count,
        a.items_count,
        a.base_cents,
        a.margin_cents,
        a.tax_cents,
        a.shipping_owner_cents,
        a.gateway_fee_cents,
        /* derivados coherentes con tu modelo de pagos */
        a.base_cents                                       AS owner_product_cents_without_tax,
        a.base_cents                                       AS owner_product_cents_with_tax, -- (si el owner NO recibe impuestos)
        (a.base_cents + a.shipping_owner_cents)            AS owner_total_cents_without_tax,
        (a.base_cents + a.shipping_owner_cents)            AS owner_total_cents_with_tax,
        a.margin_cents                                     AS platform_gross_margin_cents,
        (a.margin_cents)             AS platform_net_margin_cents
      FROM agg a
      JOIN owners ow ON ow.id = a.owner_id
      ORDER BY a.owner_id;
    `
    const includePaid = ['1', 'true', 'yes', 'on'].includes(String(req.query.include_paid || '0').toLowerCase());
    const params = [qFrom, qTo, ownerId, deliveredOnly, includePaid];
    const { rows } = await pool.query(rowsSQL, params)

    // amounts_usd por fila (con 2 decimales) para la UI
    const toUSD = (cents) => Math.round((Number(cents || 0) / 100) * 100) / 100
    const rowsWithUsd = rows.map(r => ({
      ...r,
      amounts_usd: {
        base: toUSD(r.base_cents),
        margin: toUSD(r.margin_cents),
        tax: toUSD(r.tax_cents),
        shipping_owner: toUSD(r.shipping_owner_cents),
        gateway_fee: toUSD(r.gateway_fee_cents),
        owner_product_without_tax: toUSD(r.owner_product_cents_without_tax),
        owner_product_with_tax: toUSD(r.owner_product_cents_with_tax),
        owner_total_without_tax: toUSD(r.owner_total_cents_without_tax),
        owner_total_with_tax: toUSD(r.owner_total_cents_with_tax),
        platform_gross_margin: toUSD(r.platform_gross_margin_cents),
        platform_net_margin: toUSD(r.platform_net_margin_cents),
      }
    }))

    // --------- Totales (sumas) ----------
    const totals = rows.reduce((acc, r) => {
      acc.items_count += Number(r.items_count || 0)
      acc.base_cents += Number(r.base_cents || 0)
      acc.margin_cents += Number(r.margin_cents || 0)
      acc.tax_cents += Number(r.tax_cents || 0)
      acc.shipping_owner_cents += Number(r.shipping_owner_cents || 0)
      acc.gateway_fee_cents += Number(r.gateway_fee_cents || 0)
      acc.owner_product_cents_without_tax += Number(r.owner_product_cents_without_tax || 0)
      acc.owner_product_cents_with_tax += Number(r.owner_product_cents_with_tax || 0)
      acc.owner_total_cents_without_tax += Number(r.owner_total_cents_without_tax || 0)
      acc.owner_total_cents_with_tax += Number(r.owner_total_cents_with_tax || 0)
      acc.platform_gross_margin_cents += Number(r.platform_gross_margin_cents || 0)
      acc.platform_net_margin_cents += Number(r.platform_net_margin_cents || 0)
      return acc
    }, {
      orders_count: 0, // lo llenamos con un COUNT distinct real
      items_count: 0,
      base_cents: 0,
      margin_cents: 0,
      tax_cents: 0,
      shipping_owner_cents: 0,
      gateway_fee_cents: 0,
      owner_product_cents_without_tax: 0,
      owner_product_cents_with_tax: 0,
      owner_total_cents_without_tax: 0,
      owner_total_cents_with_tax: 0,
      platform_gross_margin_cents: 0,
      platform_net_margin_cents: 0,
    })

    // Conteo de órdenes (distinct) del set filtrado (como hay un owner por orden, es fácil)
    const ordersCountSQL = `
     WITH params AS (
  SELECT $1::date AS dfrom, $2::date AS dto, $3::int AS owner_filter, $4::boolean AS delivered_only, $5::boolean AS include_paid
)
SELECT COUNT(*)::int AS orders_count
FROM orders o, params pa
WHERE (pa.owner_filter IS NULL OR o.owner_id = pa.owner_filter)
  AND (
    CASE
      WHEN pa.delivered_only
        THEN (o.delivered_at IS NOT NULL AND o.delivered_at::date BETWEEN pa.dfrom AND pa.dto)
      ELSE (o.created_at::date BETWEEN pa.dfrom AND pa.dto)
    END
  )
  AND (pa.include_paid IS TRUE OR COALESCE(o.owner_paid, false) = false);`
    const { rows: orderCntRows } = await pool.query(ordersCountSQL, params)
    totals.orders_count = orderCntRows[0]?.orders_count || 0

    // --------- Respuesta ----------
    return res.json({
      rows: rowsWithUsd,
      totals,
      filters: {
        from: qFrom,
        to: qTo,
        owner_id: ownerId,
        delivered_only: deliveredOnly,
      },
    })
  } catch (e) {
    console.error('GET /admin/reports/payouts error', e)
    return res.status(500).json({ error: 'Error generando reporte' })
  }
})

// POST /admin/payouts/close
router.post('/payouts/close', authenticateToken, requireAdmin, async (req, res) => {
  const { from, to, delivered_only = true, note } = req.body || {};
  const ownerId = Number(req.body?.owner_id);
  if (!from || !to) {
    return res.status(400).json({ error: 'from/to requeridos (YYYY-MM-DD)' });
  }
  if (!Number.isInteger(ownerId)) {
    return res.status(400).json({ error: 'owner_id requerido (número)' });
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // límites de ventana local [00:00, 00:00 siguiente)
    const tz = 'America/New_York'
    const boundsSql = `
      WITH p AS (
        SELECT $1::date AS dfrom, $2::date AS dto, $3::text AS tz
      )
      SELECT
        (dfrom::timestamp AT TIME ZONE tz)   AS ts_from,
        ((dto + 1)::timestamp AT TIME ZONE tz) AS ts_to
      FROM p
    `
    const { rows: b } = await client.query(boundsSql, [from, to, tz])
    const ts_from = b[0].ts_from
    const ts_to = b[0].ts_to

    // órdenes candidatas
    const ordersSql = `
      SELECT o.*
      FROM orders o
      WHERE o.owner_id = $3::int
        AND (
          CASE WHEN $4::boolean
               THEN (o.delivered_at IS NOT NULL AND o.delivered_at >= $1 AND o.delivered_at < $2)
               ELSE (o.created_at >= $1 AND o.created_at < $2)
          END
        )
        AND COALESCE(o.owner_paid, false) = false
        AND o.status IN ('paid','processing','delivered') -- permite marcar pagadas aunque no cambiaste el status
    `
    const { rows: orders } = await client.query(ordersSql, [ts_from, ts_to, ownerId, !!delivered_only]);

    if (!orders.length) {
      await client.query('ROLLBACK')
      return res.json({ ok: true, payout: null, orders: [], message: 'Sin órdenes pendientes en el rango' })
    }

    // agregados para el lote
    const aggSql = `
      WITH ids AS (
        SELECT UNNEST($1::int[]) AS id
      ),
      sel AS (
        SELECT o.*
        FROM orders o
        JOIN ids ON ids.id = o.id
      ),
      li AS (
        SELECT li.order_id,
               SUM(li.quantity)::int AS items_count,
               SUM(COALESCE((li.metadata->>'base_cents')::int,0) * li.quantity) AS base_cents,
               SUM(
                 CASE
                   WHEN COALESCE((li.metadata->>'unit_cents_snapshot')::int,0) > 0
                     THEN ((COALESCE((li.metadata->>'unit_cents_snapshot')::int,0)
                            - COALESCE((li.metadata->>'base_cents')::int,0)) * li.quantity)
                   ELSE (ROUND(COALESCE((li.metadata->>'base_cents')::int,0)
                               * COALESCE(NULLIF(li.metadata->>'margin_pct','')::numeric,0) / 100.0)::int * li.quantity)
                 END
               ) AS margin_cents
        FROM line_items li
        JOIN sel ON sel.id = li.order_id
        GROUP BY li.order_id
      )
      SELECT
        COUNT(sel.id)::int AS orders_count,
        COALESCE(SUM(li.items_count),0)::int AS items_count,
        COALESCE(SUM(li.base_cents),0)::bigint AS base_cents,
        COALESCE(SUM((sel.metadata->'pricing_cents'->>'shipping_total_cents')::int),0)::bigint AS shipping_owner_cents,
        COALESCE(SUM(li.margin_cents),0)::bigint AS margin_cents,
        COALESCE(SUM((sel.metadata->'pricing_cents'->>'card_fee_cents')::int),0)::bigint AS gateway_fee_cents
      FROM sel
      LEFT JOIN li ON li.order_id = sel.id
    `
    const ids = orders.map(o => o.id)
    const { rows: a } = await client.query(aggSql, [ids])
    const agg = a[0]
    const amount_to_owner_cents = Number(agg.base_cents) + Number(agg.shipping_owner_cents)

    // crea lote
    const ins = await client.query(
      `INSERT INTO owner_payouts
        (owner_id, from_date, to_date, tz, delivered_only,
         orders_count, items_count, base_cents, shipping_owner_cents,
         amount_to_owner_cents, margin_cents, gateway_fee_cents,
         created_by, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        ownerId, from, to, tz, !!delivered_only,
        agg.orders_count, agg.items_count, agg.base_cents, agg.shipping_owner_cents,
        amount_to_owner_cents, agg.margin_cents, agg.gateway_fee_cents,
        (req.user && req.user.email) || null, note || null
      ]
    )
    const payoutId = ins.rows[0].id

    // marca órdenes
    await client.query(
      `UPDATE orders
         SET owner_paid = true,
             owner_paid_at = now(),
             owner_payout_id = $2
       WHERE id = ANY($1::int[])`,
      [ids, payoutId]
    )

    await client.query('COMMIT')
    res.json({
      ok: true,
      payout: {
        id: payoutId,
        from, to, tz,
        delivered_only: !!delivered_only,
        owner_id: ownerId,
        orders_count: agg.orders_count,
        items_count: agg.items_count,
        base_cents: Number(agg.base_cents),
        shipping_owner_cents: Number(agg.shipping_owner_cents),
        amount_to_owner_cents,
        margin_cents: Number(agg.margin_cents),
        gateway_fee_cents: Number(agg.gateway_fee_cents)
      },
      orders: ids
    })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('POST /admin/payouts/close', e)
    res.status(500).json({ error: 'payout_close_failed' })
  } finally {
    client.release()
  }
})

// PATCH /admin/orders/:id/mark-owner-paid
router.patch('/orders/:id/mark-owner-paid', authenticateToken, requireAdmin, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' })

  try {
    const q = await pool.query(
      `UPDATE orders
         SET owner_paid = true,
             owner_paid_at = COALESCE(owner_paid_at, now())
       WHERE id = $1
       RETURNING id, owner_paid, owner_paid_at, owner_payout_id`,
      [id]
    )
    if (!q.rows.length) return res.status(404).json({ error: 'order_not_found' })
    res.json({ ok: true, order: q.rows[0] })
  } catch (e) {
    console.error('PATCH /admin/orders/:id/mark-owner-paid', e)
    res.status(500).json({ error: 'mark_owner_paid_failed' })
  }
})

module.exports = router
