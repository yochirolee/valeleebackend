const express = require('express')
const router = express.Router()
const { pool } = require('../db')
const authenticateToken = require('../middleware/authenticateToken')

/**
 * CONFIG
 * - Tarifa base: puedes reemplazar la lógica por la que ya tengas (owner_shipping_config).
 * - CARD_FEE_PCT: % de recargo por pago con tarjeta (para start-direct).
 */
const CARD_FEE_PCT = Number(process.env.CARD_FEE_PCT || process.env.NEXT_PUBLIC_CARD_FEE_PCT || 3)
const FEE_RATE = Number.isFinite(CARD_FEE_PCT) ? CARD_FEE_PCT / 100 : 0

// --- Helpers ---
const toCents = (n) => Math.max(0, Math.round(Number(n || 0) * 100))
const num = (v) => (v == null ? 0 : Number(v))
const safeJson = (v, fallback = {}) => {
  try { return JSON.parse(JSON.stringify(v ?? fallback)) } catch { return fallback }
}

/**
 * Calcula envío para encargos (versión simple).
 * - CU: si area_type = 'hab_city' flat 9.99; 'hab_rural' 12.99; 'other_city' 14.99; 'other_rural' 16.99
 * - US: flat 7.99
 * Puedes enchufarlo a owner_shipping_config si lo prefieres.
 */
function computeShippingCentsForEncargos(shipping) {
  if (!shipping || !shipping.country) return 0

  if (shipping.country === 'CU') {
    const t = String(shipping.area_type || '').toLowerCase()
    if (t === 'hab_city') return toCents(9.99)
    if (t === 'hab_rural') return toCents(12.99)
    if (t === 'other_city') return toCents(14.99)
    if (t === 'other_rural') return toCents(16.99)
    // fallback si no mandan area_type:
    return toCents(14.99)
  }

  if (shipping.country === 'US') {
    return toCents(7.99)
  }

  // otros países (por ahora)
  return toCents(19.99)
}

/**
 * Lee los pending_encargos del usuario autenticado.
 */
async function getUserEncargos(client, customerId) {
  const { rows } = await client.query(
    `SELECT id, source, external_id, asin, source_url, title, image_url, price_estimate, currency, created_at
       FROM pending_encargos
      WHERE customer_id = $1
      ORDER BY created_at ASC`,
    [customerId]
  )
  return rows
}

/**
 * Calcula totales de una sesión de encargos.
 */
function buildTotalsSnapshot(encargosRows, shippingCents) {
  const items = (encargosRows || []).map(r => ({
    id: r.id,
    source: r.source || 'unknown',
    external_id: r.external_id || null,
    asin: r.asin || null,
    source_url: r.source_url || null,
    title: r.title || null,
    image_url: r.image_url || null,
    price_estimate: r.price_estimate == null ? null : Number(r.price_estimate),
    currency: r.currency || 'USD',
    quantity: 1,
  }))

  const subtotalCents = items.reduce((acc, it) => acc + toCents(it.price_estimate), 0)
  const taxCents = 0 // Si tu negocio requiere impuesto, cámbialo aquí o muévelo a nivel owner/producto.
  const shipping_cents = Number(shippingCents || 0)
  const grand_total_cents = subtotalCents + taxCents + shipping_cents

  return {
    kind: 'encargos',
    items,
    subtotal_cents: subtotalCents,
    tax_cents: taxCents,
    shipping_cents,
    grand_total_cents,
    currency: 'USD',
  }
}

/**
 * Crea registro en checkout_sessions.
 */
async function createCheckoutSession(client, {
  customerId,
  amount_total_cents,
  snapshot,
  payment_method = 'bmspay',
  metadata = {},
}) {
  const { rows } = await client.query(
    `INSERT INTO checkout_sessions
       (customer_id, cart_id, status, amount_total, currency, snapshot, metadata, payment_method)
     VALUES ($1, NULL, 'pending', $2, 'USD', $3::jsonb, $4::jsonb, $5)
     RETURNING id`,
    [customerId, (amount_total_cents / 100), JSON.stringify(snapshot), JSON.stringify(metadata), payment_method]
  )
  return rows[0]?.id
}

// ==============================
//  POST /encargos/quote
// ==============================
router.post('/quote', authenticateToken, async (req, res) => {
  const client = await pool.connect()
  try {
    const customerId = req.user?.id
    if (!customerId) return res.status(401).json({ ok: false, message: 'unauthorized' })

    const { shipping } = req.body || {}
    if (!shipping || !shipping.country) {
      return res.status(400).json({ ok: false, message: 'shipping_required' })
    }

    const encargos = await getUserEncargos(client, customerId)
    if (!encargos.length) {
      return res.status(400).json({ ok: false, message: 'no_pending_encargos' })
    }

    // Aquí podrías validar “disponibilidad por ubicación” si tu negocio lo necesita.
    // Por ejemplo, bloquear si CU y municipality no soportado. Devuelve unavailable = [{owner_id, owner_name}]
    // Para demo, asumimos todo disponible.

    const shipping_total_cents = computeShippingCentsForEncargos(shipping)
    const breakdown = [
      { owner_id: null, owner_name: 'Encargos', mode: 'flat', weight_lb: 0, shipping_cents: shipping_total_cents }
    ]

    return res.json({ ok: true, shipping_total_cents, breakdown })
  } catch (e) {
    console.error('[encargos/quote] error:', e)
    return res.status(500).json({ ok: false, message: 'quote_failed' })
  } finally {
    client.release()
  }
})

// ==============================
//  POST /encargos/checkout
//  - Crea checkout_session y devuelve sessionId y/o payUrl
//  - El cobro por link (si aplica) lo arma tu integrador BMSPay.
// ==============================
router.post('/checkout', authenticateToken, async (req, res) => {
  const client = await pool.connect()
  try {
    const customerId = req.user?.id
    if (!customerId) return res.status(401).json({ ok: false, message: 'unauthorized' })

    const { shipping, locale, metadata = {} } = req.body || {}
    if (!shipping || !shipping.country) {
      return res.status(400).json({ ok: false, message: 'shipping_required' })
    }

    const encargos = await getUserEncargos(client, customerId)
    if (!encargos.length) {
      return res.status(400).json({ ok: false, message: 'no_pending_encargos' })
    }

    // Calcular totales
    const shipping_cents = computeShippingCentsForEncargos(shipping)
    const snapshot = buildTotalsSnapshot(encargos, shipping_cents)

    // Guarda metadata útil
    const sessionMeta = {
      ...safeJson(metadata),
      flow: 'encargos',
      shipping,
      locale: locale || 'es',
      sources: Array.from(new Set(encargos.map(e => e.source || 'unknown'))),
    }

    const sessionId = await createCheckoutSession(client, {
      customerId,
      amount_total_cents: snapshot.grand_total_cents,
      snapshot,
      payment_method: 'bmspay',
      metadata: sessionMeta,
    })

    // Si usas pago por link, genera aquí la URL de pago (opcional):
    // const payUrl = `https://tu-pasarela/pagar?session=${sessionId}`
    const payUrl = null

    return res.json({ ok: true, sessionId, payUrl })
  } catch (e) {
    console.error('[encargos/checkout] error:', e)
    return res.status(500).json({ ok: false, message: 'checkout_failed' })
  } finally {
    client.release()
  }
})

// ==============================
//  POST /encargos/start-direct
//  - Prepara sesión directa BMSPay con monto total + fee de tarjeta.
//  - Front llamará luego a /payments-direct/bmspay/sale con sessionId + amount.
// ==============================
router.post('/start-direct', authenticateToken, async (req, res) => {
  const client = await pool.connect()
  try {
    const customerId = req.user?.id
    if (!customerId) return res.status(401).json({ ok: false, message: 'unauthorized' })

    const { shipping, locale } = req.body || {}
    if (!shipping || !shipping.country) {
      return res.status(400).json({ ok: false, message: 'shipping_required' })
    }

    const encargos = await getUserEncargos(client, customerId)
    if (!encargos.length) {
      return res.status(400).json({ ok: false, message: 'no_pending_encargos' })
    }

    const shipping_cents = computeShippingCentsForEncargos(shipping)
    const snapshot = buildTotalsSnapshot(encargos, shipping_cents)

    // Fee por tarjeta
    const card_fee_cents = Math.round(snapshot.grand_total_cents * FEE_RATE)
    const total_with_card_cents = snapshot.grand_total_cents + card_fee_cents

    const sessionMeta = {
      flow: 'encargos',
      direct: true,
      shipping,
      locale: locale || 'es',
      card_fee_pct: CARD_FEE_PCT,
      totals: {
        ...snapshot,
        card_fee_cents,
        total_with_card_cents,
      }
    }

    const sessionId = await createCheckoutSession(client, {
      customerId,
      amount_total_cents: total_with_card_cents,
      snapshot,
      payment_method: 'bmspay',
      metadata: sessionMeta,
    })

    // El front usará { sessionId, amount } para /payments-direct/bmspay/sale
    return res.json({ ok: true, sessionId, amount: total_with_card_cents })
  } catch (e) {
    console.error('[encargos/start-direct] error:', e)
    return res.status(500).json({ ok: false, message: 'start_direct_failed' })
  } finally {
    client.release()
  }
})

module.exports = router
