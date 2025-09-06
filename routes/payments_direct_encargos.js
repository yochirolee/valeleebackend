const express = require('express')
const router = express.Router()
const { pool } = require('../db')
const authenticateToken = require('../middleware/authenticateToken')
const { sale } = require('../services/bmspaySale')
const { sendCustomerOrderEmail, sendOwnerOrderEmail } = require('../helpers/emailOrders')

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:4000'

// ====== Config: owner por defecto para “encargos” ======
const ENCARGOS_OWNER_NAME = (process.env.ENCARGOS_OWNER_NAME || 'valelee').trim()
const ENCARGOS_OWNER_EMAIL = (process.env.ENCARGOS_OWNER_EMAIL || '').trim() || null

// ====== Helpers comunes ======
const delay = (ms) => new Promise(r => setTimeout(r, ms))

function looksLikeGateway500(raw) {
  if (!raw) return false
  if (typeof raw === 'string') {
    const s = raw.toLowerCase()
    return s.includes('<html') && s.includes('internal server error')
  }
  return false
}

async function resilientSale(saleFn, args, { retries = 2, baseDelayMs = 600 } = {}) {
  let last = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await saleFn(args)
      if (resp && resp.ok) return resp
      if (resp && looksLikeGateway500(resp.raw)) {
        last = resp
      } else {
        return resp
      }
    } catch (e) {
      last = { ok: false, message: e?.message || 'network_error', raw: null }
    }
    if (attempt < retries) await delay(baseDelayMs * Math.pow(2, attempt))
  }
  return last || { ok: false, message: 'gateway_unavailable', raw: null }
}

const toCents = (n) => Math.max(0, Math.round(Number(n || 0) * 100))
const centsToUsd = (c) => Number(((Number(c || 0)) / 100).toFixed(2))

async function fetchSession(client, sessionId, customerId) {
  const { rows } = await client.query(
    `SELECT * FROM checkout_sessions WHERE id = $1 AND customer_id = $2 LIMIT 1`,
    [sessionId, customerId]
  )
  return rows.length ? rows[0] : null
}

async function resolveEncargosOwner(client) {
  const { rows } = await client.query(
    `
    SELECT id, name, email
      FROM owners
     WHERE lower(name) = lower($1::text)
        OR ($2::text IS NOT NULL AND lower(email) = lower($2::text))
     ORDER BY id ASC
     LIMIT 1
    `,
    [ENCARGOS_OWNER_NAME, ENCARGOS_OWNER_EMAIL]
  )
  return rows[0] || null
}

function readShippingFromSession(s) {
  // preferencia: metadata.shipping → snapshot.shipping (compatibilidad)
  return (s?.metadata?.shipping) || (s?.snapshot?.shipping) || null
}

async function quoteEncargosThroughSelf({ token, shipping }) {
  const res = await fetch(`${API_BASE_URL}/encargos/quote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {}),
    },
    body: JSON.stringify({ shipping }),
  })
  const txt = await res.text()
  let data = null
  try { data = txt ? JSON.parse(txt) : null } catch { }
  return { ok: res.ok, status: res.status, data }
}

function subtotalCentsFromSnapshot(snapshot) {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : []
  return items.reduce((acc, it) => acc + toCents(it?.price_estimate), 0)
}

function buildCustomerName(shipping) {
  return [shipping?.first_name, shipping?.last_name].filter(Boolean).join(' ').trim() || null
}

function emailItemsFromSnapshot(snapshot) {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : []
  // Estructura mínima que suelen usar los templates de email
  return items.map(it => ({
    product_name: it?.title || 'Encargo',
    image_url: it?.image_url || null,
    quantity: 1,
    unit_price: Number(it?.price_estimate || 0),
  }))
}

// Por si quieres cargar el order luego con más detalle (no imprescindible)
async function loadOrderDetail(orderId) {
  const headQ = `
    SELECT o.id, o.created_at, o.status, o.total, o.metadata,
           c.email AS customer_email, c.first_name, c.last_name
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.id = $1
     LIMIT 1
  `
  const { rows: hr } = await pool.query(headQ, [orderId])
  if (!hr.length) return null
  const order = hr[0]
  return { order, items: [] }
}

// ====== SALE DIRECT PARA ENCARGOS ======
/**
 * POST /payments-direct/bmspay/sale-encargos
 * Body: { sessionId, cardNumber, expMonth, expYear, cvn, nameOnCard?, zipCode? }
 */
router.post('/bmspay/sale-encargos', authenticateToken, async (req, res) => {
  const customerId = req.user.id
  const authHeader = req.headers.authorization || null

  const {
    sessionId,
    cardNumber,
    expMonth,
    expYear,
    cvn,
    nameOnCard,
    zipCode,
  } = req.body || {}

  if (!sessionId || !cardNumber || !expMonth || !expYear || !cvn) {
    return res.status(400).json({ ok: false, message: 'Faltan datos de tarjeta o sessionId' })
  }

  const client = await pool.connect()
  try {
    // 1) Cargar sesión
    const s = await fetchSession(client, sessionId, customerId)
    if (!s) return res.status(404).json({ ok: false, message: 'Sesión no encontrada' })

    // idempotencia: si ya está pagada
    if (s.status === 'paid' && Array.isArray(s.created_order_ids) && s.created_order_ids.length) {
      return res.json({ ok: true, paid: true, orders: s.created_order_ids })
    }

    // Verificación de tipo de flujo
    const kind = s?.snapshot?.kind || s?.metadata?.flow || 'unknown'
    if (kind !== 'encargos' && s?.metadata?.flow !== 'encargos') {
      return res.status(409).json({ ok: false, message: 'La sesión no corresponde a encargos' })
    }

    // 2) Shipping desde la sesión
    const shipping = readShippingFromSession(s)
    if (!shipping || !shipping.country) {
      return res.status(400).json({ ok: false, message: 'Sesión sin dirección de envío' })
    }

    // 3) Recalcular totales server-side
    const snapshot = s.snapshot || {}
    const subtotal_cents = subtotalCentsFromSnapshot(snapshot)

    // Cotizar envío encargos (server-side)
    const q = await quoteEncargosThroughSelf({ token: authHeader, shipping })
    if (!q.ok || !q.data) {
      return res.status(409).json({ ok: false, message: 'No se pudo cotizar el envío' })
    }
    if (q.data.ok === false) {
      return res.status(409).json({ ok: false, message: 'Envío no disponible para la dirección seleccionada', unavailable: q.data.unavailable || [] })
    }

    const shipping_total_cents = Number(q.data.shipping_total_cents || 0)
    const shipping_breakdown = Array.isArray(q.data.breakdown) ? q.data.breakdown : []
    const tax_cents = 0 // si aplica impuestos, cámbialo

    const grand_total_cents = subtotal_cents + tax_cents + shipping_total_cents

    // Fee por tarjeta si la sesión fue creada como "direct"
    const card_fee_pct = Number(s?.metadata?.card_fee_pct || 0)
    const card_fee_cents = Math.round(grand_total_cents * (card_fee_pct / 100))
    const total_with_card_cents = grand_total_cents + card_fee_cents

    const amountToCharge = centsToUsd(total_with_card_cents)

    // 👇 pricing en USD (igual al carrito) + pricing_cents (compat)
    const pricing_usd = {
      subtotal: centsToUsd(subtotal_cents),
      tax: centsToUsd(tax_cents),
      shipping: centsToUsd(shipping_total_cents),
      card_fee: centsToUsd(card_fee_cents),
      total: centsToUsd(total_with_card_cents),
    }

    // Fallbacks por si vinieron en snapshot y/o bajo order_meta (compat con checkout normal)
    const billing =
      s?.metadata?.billing
      ?? s?.metadata?.order_meta?.billing
      ?? s?.snapshot?.billing
      ?? s?.snapshot?.order_meta?.billing
      ?? null

    const payer =
      s?.metadata?.payer
      ?? s?.metadata?.order_meta?.payer
      ?? s?.snapshot?.payer
      ?? s?.snapshot?.order_meta?.payer
      ?? null

    const terms =
      s?.metadata?.terms
      ?? s?.metadata?.order_meta?.terms
      ?? s?.snapshot?.terms
      ?? s?.snapshot?.order_meta?.terms
      ?? null


    // 4) Cobro a BMSPay
    const userTransactionNumber = `${sessionId}-${Date.now().toString(36)}`
    const saleResp = await resilientSale(sale, {
      amount: amountToCharge,
      zipCode,
      cardNumber,
      expMonth,
      expYear,
      cvn,
      nameOnCard,
      userTransactionNumber,
    })

    if (!saleResp.ok) {
      if (looksLikeGateway500(saleResp.raw)) {
        return res.status(502).json({
          ok: false,
          paid: false,
          message: 'El proveedor de pago presentó un error temporal. Intenta nuevamente.',
          provider: 'bmspay',
          raw: null,
        })
      }
      return res.status(402).json({
        ok: false,
        paid: false,
        message: saleResp.message || 'Pago no aprobado',
        provider: 'bmspay',
        raw: saleResp.raw || null,
      })
    }

    // 5) Crear ORDEN de ENCARGOS (una sola) + idempotencia fuerte
    await client.query('BEGIN')

    // lock de la sesión
    const { rows: sessLockRows } = await client.query(
      `SELECT id, status, created_order_ids, payment, metadata, snapshot FROM checkout_sessions WHERE id = $1 FOR UPDATE`,
      [sessionId]
    )
    if (!sessLockRows.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ ok: false, message: 'Sesión no encontrada' })
    }
    const sLocked = sessLockRows[0]
    if (sLocked.status === 'paid' && Array.isArray(sLocked.created_order_ids) && sLocked.created_order_ids.length) {
      await client.query('ROLLBACK')
      return res.json({ ok: true, paid: true, orders: sLocked.created_order_ids })
    }

    // guarda traza del pago en la sesión
    await client.query(
      `UPDATE checkout_sessions
          SET payment = COALESCE(payment,'{}'::jsonb)
                        || jsonb_build_object(
                             'AuthorizationNumber', $2::text,
                             'ServiceReferenceNumber', $3::text,
                             'UserTransactionNumber', $4::text,
                             'verbiage', $5::text
                           )
        WHERE id = $1`,
      [
        sessionId,
        saleResp.authNumber || null,
        saleResp.reference || null,
        saleResp.userTransactionNumber || userTransactionNumber || null,
        saleResp.message || null
      ]
    )

    // Owner “valelee”
    const encargosOwner = await resolveEncargosOwner(client)
    const encargosOwnerId = encargosOwner?.id || null

    // Orden
    const items = Array.isArray(snapshot?.items) ? snapshot.items : []
    const sources = Array.from(new Set(items.map(it => it?.source || 'unknown')))
    const customerName = buildCustomerName(shipping)

    const orderTotalUsd = centsToUsd(grand_total_cents)
    const ordQ = await client.query(
      `INSERT INTO orders (customer_id, owner_id, customer_name, status, payment_method, total, metadata)
       VALUES ($1, $2, $3, 'paid', 'bmspay_direct', $4, $5::jsonb)
       RETURNING id`,
      [
        customerId,
        encargosOwnerId, // owner default
        customerName,
        orderTotalUsd,
        JSON.stringify({
          checkout_session_id: s.id,
          flow: 'encargos',
          external: true,
          sources,
          shipping,
          billing,   // ← ahora con fallbacks
          payer,
          terms,

          // Igual que carrito: pricing USD + compat en centavos
          pricing: pricing_usd,
          pricing_cents: {
            subtotal_cents,
            tax_cents,
            shipping_total_cents,
            card_fee_cents,
            total_with_card_cents,
            charged_usd: amountToCharge,
          },

          payment: {
            provider: 'bmspay',
            mode: 'direct',
            status: 1,
            AuthorizationNumber: saleResp.authNumber || null,
            ServiceReferenceNumber: saleResp.reference || null,
            UserTransactionNumber: saleResp.userTransactionNumber || userTransactionNumber || null,
            verbiage: saleResp.message || null,
            CardType: saleResp.raw?.CardType || null,
            LastFour: saleResp.raw?.LastFour || null,
          },
        })
      ]
    )
    const orderId = ordQ.rows[0].id

    // Line items (sin product_id; guardamos metadata con el externo)
    for (const it of items) {
      const unitUsd = Number((Number(it?.price_estimate || 0)).toFixed(2))
      const md = {
        external: true,
        source: it?.source || 'unknown',
        external_id: it?.external_id || null,
        asin: it?.asin || null,
        source_url: it?.source_url || null,
        title: it?.title || null,
        image_url: it?.image_url || null,
        currency: it?.currency || 'USD',
      }
      await client.query(
        `INSERT INTO line_items (order_id, product_id, quantity, unit_price, metadata)
         VALUES ($1, NULL, 1, $2, $3::jsonb)`,
        [orderId, unitUsd, JSON.stringify(md)]
      )
    }

    // Finalizar sesión → paid + created_order_ids
    await client.query(
      `UPDATE checkout_sessions
         SET status = 'paid',
             processed_at = now(),
             payment = COALESCE(payment,'{}'::jsonb) || jsonb_build_object('status', 1),
             snapshot = COALESCE(snapshot,'{}'::jsonb)
                        || jsonb_build_object(
                             'shipping_breakdown', $2::jsonb,
                             -- centavos (compat)
                             'pricing_cents', jsonb_build_object(
                               'subtotal_cents', $3::int,
                               'tax_cents', $4::int,
                               'shipping_total_cents', $5::int,
                               'card_fee_cents', $6::int,
                               'total_with_card_cents', $7::int
                             ),
                             -- USD (igual que carrito)
                             'pricing', jsonb_build_object(
                               'subtotal', $9::numeric,
                               'tax',      $10::numeric,
                               'shipping', $11::numeric,
                               'card_fee', $12::numeric,
                               'total',    $13::numeric
                             )
                           ),
             created_order_ids = ARRAY[$8]::int[]
       WHERE id = $1`,
      [
        sessionId,
        JSON.stringify(shipping_breakdown),
        subtotal_cents,
        tax_cents,
        shipping_total_cents,
        card_fee_cents,
        total_with_card_cents,
        orderId,
        // USD
        centsToUsd(subtotal_cents),
        centsToUsd(tax_cents),
        centsToUsd(shipping_total_cents),
        centsToUsd(card_fee_cents),
        centsToUsd(total_with_card_cents),
      ]
    )

    // Limpiar pending_encargos del cliente (ya quedaron como order/line_items)
    await client.query(`DELETE FROM pending_encargos WHERE customer_id = $1`, [customerId])

    await client.query('COMMIT')

    // 6) Emails post-commit: cliente + owner
    const subjectSuffix = `#${orderId}`
    const emailItems = emailItemsFromSnapshot(snapshot)
    const ownerEmail = (encargosOwner?.email || '').trim() || (ENCARGOS_OWNER_EMAIL || '')

      ; (async () => {
        try {
          // Relee orden para el payload de email (opcional)
          const detail = await loadOrderDetail(orderId)
          const ord = detail?.order || { id: orderId, metadata: { shipping, billing } }

          // Email cliente (billing/shipping como fallback)
          const customerEmail =
            (ord.customer_email && String(ord.customer_email).trim()) ||
            (ord.metadata?.billing?.email && String(ord.metadata.billing.email).trim()) ||
            (ord.metadata?.shipping?.email && String(ord.metadata.shipping.email).trim()) ||
            null

          const tasks = []

          if (customerEmail) {
            tasks.push(
              sendCustomerOrderEmail(
                customerEmail,
                { ...ord, _subjectSuffix: subjectSuffix, _emailRole: 'customer' },
                emailItems
              ).then(() => console.log(`[emails] OK cliente ${customerEmail} → orden #${orderId}`))
                .catch(e => console.error(`[emails] FAIL cliente ${customerEmail} → orden #${orderId}`, e))
            )
          } else {
            console.warn(`[emails] Cliente sin email para orden #${orderId}`)
          }

          if (ownerEmail) {
            tasks.push(
              sendOwnerOrderEmail(
                ownerEmail,
                { ...ord, _subjectSuffix: subjectSuffix, _emailRole: 'owner' },
                emailItems
              ).then(() => console.log(`[emails] OK owner ${ownerEmail} → orden #${orderId}`))
                .catch(e => console.error(`[emails] FAIL owner ${ownerEmail} → orden #${orderId}`, e))
            )
          } else {
            console.warn(`[emails] Owner "valelee" sin email para orden #${orderId}`)
          }

          await Promise.allSettled(tasks)
          await delay(1200)
        } catch (e) {
          console.error(`[emails] Error procesando orden #${orderId}:`, e)
        }
      })().catch(() => { })

    return res.json({
      ok: true,
      paid: true,
      orders: [orderId],
      auth: saleResp.authNumber || null,
      ref: saleResp.reference || null,
      utn: saleResp.userTransactionNumber || userTransactionNumber || null,
      message: saleResp.message || 'Aprobado',
      sessionId,
    })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('[payments-direct-encargos] sale error', e)
    return res.status(500).json({ ok: false, paid: false, message: e.message || 'Error procesando pago' })
  } finally {
    client.release()
  }
})

module.exports = router
