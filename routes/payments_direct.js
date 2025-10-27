// routes/payments_direct.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const { sale } = require('../services/bmspaySale');
const { sendCustomerOrderEmail, sendOwnerOrderEmail } = require('../helpers/emailOrders');
const { getThreeDSCreds } = require('../services/bmspay3ds');

const API_BASE_URL = process.env.API_BASE_URL;
const THREE_DS_ENABLED =
  (process.env.BMS_3DS_ENABLED ?? 'true').toLowerCase() !== 'false';

// === Anti-fraude mínimo (helpers) ===
const crypto = require('crypto');

function getClientIp(req) {
  const xf = (req.headers['x-forwarded-for'] || '').toString();
  if (xf) return xf.split(',')[0].trim();
  return (req.connection && req.connection.remoteAddress) || '';
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function pickBin(cardNumber) {
  const d = String(cardNumber || '').replace(/\D/g, '');
  return d.slice(0, 6);
}

function pickLast4(cardNumber) {
  const d = String(cardNumber || '').replace(/\D/g, '');
  return d.slice(-4);
}

// reglas de velocidad muy simples
const FAILS_PER_CARD_10M = 2;   // máx 2 fallos por tarjeta en 10 min
const CARDS_PER_IP_30M = 3;   // máx 3 tarjetas distintas fallidas por IP en 30 min
const AMOUNT_SOFT_LIMIT = Number(process.env.RISK_SOFT_LIMIT || 150); // USD

async function velocityOk(client, { cardHash, ip }) {
  const q1 = `SELECT COUNT(*)::int AS n
                FROM payment_risk_events
               WHERE ts > now() - interval '10 minutes'
                 AND card_hash = $1
                 AND outcome = 'fail'`;
  const q2 = `SELECT COUNT(DISTINCT card_hash)::int AS n
                FROM payment_risk_events
               WHERE ts > now() - interval '30 minutes'
                 AND ip = $1
                 AND outcome = 'fail'`;
  const [r1, r2] = await Promise.all([
    client.query(q1, [cardHash]),
    client.query(q2, [ip]),
  ]);
  if ((r1.rows[0]?.n || 0) >= FAILS_PER_CARD_10M) return false;
  if ((r2.rows[0]?.n || 0) >= CARDS_PER_IP_30M) return false;
  return true;
}

async function recordRiskEvent(client, ev) {
  // ev: { customer_id, ip, card_hash, bin, last4, amount, three_ds, decision, outcome, note }
  const q = `
    INSERT INTO payment_risk_events
      (ts, customer_id, ip, card_hash, bin, last4, amount, three_ds, decision, outcome, note)
    VALUES (now(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `;
  const args = [
    ev.customer_id ?? null,
    ev.ip ?? null,
    ev.card_hash ?? null,
    ev.bin ?? null,
    ev.last4 ?? null,
    Number(ev.amount ?? 0),
    ev.three_ds ?? null,
    ev.decision ?? null,
    ev.outcome ?? null,
    ev.note ?? null,
  ];
  try { await client.query(q, args); } catch { /* noop */ }
}

function decideBy3DS({ threeDSStatus, amountOk, veloOk }) {
  const s = String(threeDSStatus || '').toUpperCase();

  // Si globalmente está apagado, usa solo monto+velocidad
  if (!THREE_DS_ENABLED) return (amountOk && veloOk) ? 'allow' : 'deny';

  if (s === 'R' || s === 'N') return 'deny';
  if (s === 'Y' || s === 'A') return 'allow';
  if (amountOk && veloOk) return 'allow';
  return 'deny';
}


// === Helpers comunes ===
async function fetchSession(client, sessionId, customerId) {
  const { rows } = await client.query(
    `SELECT * FROM checkout_sessions WHERE id = $1 AND customer_id = $2 LIMIT 1`,
    [sessionId, customerId]
  );
  return rows.length ? rows[0] : null;
}

async function loadCartItems(client, cartId) {
  const itemsQ = `
    SELECT
      ci.id,
      ci.product_id,
      ci.variant_id,
      ci.quantity,
      ci.unit_price,
      ci.metadata           AS cart_item_metadata,
      p.title,
      p.owner_id,
      p.price               AS product_price,
      p.metadata            AS product_metadata,
      o.name                AS owner_name
    FROM cart_items ci
    LEFT JOIN products p          ON p.id = ci.product_id
    LEFT JOIN product_variants v  ON v.id = ci.variant_id      -- 👈 opcional si más adelante lo usas
    LEFT JOIN owners o            ON o.id = p.owner_id
    WHERE ci.cart_id = $1
    ORDER BY ci.id ASC
  `;
  const { rows } = await client.query(itemsQ, [cartId]);
  return rows;
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

function looksLikeGateway500(raw) {
  if (!raw) return false;
  if (typeof raw === 'string') {
    const s = raw.toLowerCase();
    return s.includes('<html') && s.includes('internal server error');
  }
  // si algún día sale() devuelve {status} puedes usar status >= 500
  return false;
}

async function resilientSale(saleFn, args, { retries = 2, baseDelayMs = 600 } = {}) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await saleFn(args);
      if (resp && resp.ok) return resp;                 // aprobado
      if (resp && looksLikeGateway500(resp.raw)) {      // fallo transitorio del gateway
        last = resp;
      } else {
        return resp;                                    // rechazo real → sin reintentos
      }
    } catch (e) {
      last = { ok: false, message: e?.message || 'network_error', raw: null };
    }
    if (attempt < retries) await delay(baseDelayMs * Math.pow(2, attempt)); // 600ms, 1200ms…
  }
  return last || { ok: false, message: 'gateway_unavailable', raw: null };
}


function unitCents(item) {
  const m = item.metadata || {};
  if (Number.isInteger(m.price_with_margin_cents) && m.price_with_margin_cents >= 0) {
    return m.price_with_margin_cents;
  }
  const usd = Number(item.unit_price || 0);
  return Math.round(usd * 100);
}

function taxCentsPerItem(item) {
  const m = item.metadata || {};
  return Number.isInteger(m.tax_cents) ? m.tax_cents : 0;
}

function baseCentsFromProduct(pMeta, pPrice) {
  const meta = pMeta || {};
  if (Number.isInteger(meta.price_cents) && meta.price_cents >= 0) {
    return meta.price_cents;
  }
  const price = Number(pPrice || 0);
  return Math.round(price * 100);
}

function marginPctFromProduct(pMeta) {
  const meta = pMeta || {};
  const raw = Number(meta.margin_pct);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 0;
}

async function quoteShippingThroughSelf({ token, cartId, shipping }) {
  const res = await fetch(`${API_BASE_URL}/shipping/quote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}` } : {}),
    },

    body: JSON.stringify({ cartId, shipping }),
  });
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

function buildCoverageError({ province, municipality, unavailable }) {
  const loc = [municipality, province].filter(Boolean).join(', ');
  const names = (unavailable || []).map(u => (u?.owner_name || '').trim()).filter(Boolean);
  if (names.length === 1) {
    return loc
      ? `Los productos del proveedor ${names[0]} no pueden entregarse en ${loc}.`
      : `Los productos del proveedor ${names[0]} no pueden entregarse en la localidad seleccionada.`;
  }
  if (names.length > 1) {
    const list = names.join(', ');
    return loc
      ? `Los productos de los proveedores ${list} no pueden entregarse en ${loc}.`
      : `Los productos de los proveedores ${list} no pueden entregarse en la localidad seleccionada.`;
  }
  return loc
    ? `Algunos productos del carrito no pueden entregarse en ${loc}.`
    : `Algunos productos del carrito no pueden entregarse en la localidad seleccionada.`;
}

// Igual que en el flujo por link, para poblar emails
async function loadOrderDetail(orderId) {
  const headQ = `
    SELECT
      o.id,
      o.created_at,
      o.status,
      o.metadata,
      o.owner_id,
      c.email        AS customer_email,
      c.first_name   AS customer_first_name,
      c.last_name    AS customer_last_name,
      ow.name        AS owner_name,
      ow.email       AS owner_email,
      ow.phone       AS owner_phone,
      ow.metadata    AS owner_metadata
    FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN owners    ow ON ow.id = o.owner_id
    WHERE o.id = $1
    LIMIT 1
  `;
  const { rows: hr } = await pool.query(headQ, [orderId]);
  if (!hr.length) return null;
  const order = hr[0];

  const itemsQ = `
    SELECT li.product_id,
           li.quantity,
           li.unit_price,
           p.title AS product_name,
           p.image_url,
           p.owner_id,
           ow.name AS owner_name,
           ow.email AS owner_email
      FROM line_items li
      LEFT JOIN products p ON p.id = li.product_id
      LEFT JOIN owners ow ON ow.id = p.owner_id
     WHERE li.order_id = $1
     ORDER BY li.id ASC
  `;
  const { rows: items } = await pool.query(itemsQ, [orderId]);
  return { order, items };
}

// === 3DS: entregar ApiKey/Token al frontend (PROTEGIDO)
router.get('/bmspay/3ds/creds', authenticateToken, async (_req, res) => {
  // si 3DS está apagado, no intentes pedir credenciales
  if (!THREE_DS_ENABLED) {
    return res.status(200).json({ ok: true, disabled: true });
  }
  try {
    const creds = await getThreeDSCreds();
    return res.json({ ok: true, apiKey: creds.apiKey, token: creds.token });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Error obteniendo 3DS creds';
    console.error('[3DS/creds] FAIL →', msg);
    return res.status(502).json({ ok: false, message: msg });
  }
});

router.post('/bmspay/sale', authenticateToken, async (req, res) => {
  const customerId = req.user.id;
  const authHeader = req.headers.authorization || null;

  const {
    sessionId,
    cardNumber,
    expMonth,
    expYear,
    cvn,
    nameOnCard,
    zipCode,
    secureData,
    secureTransactionId,
    threeDSStatus,
    eci,
  } = req.body || {};

  // Si 3DS está desactivado en el backend, ignoramos cualquier cosa que venga del front
  const effectiveThreeDSStatus = THREE_DS_ENABLED
    ? (String(threeDSStatus || 'U').toUpperCase())
    : 'U';

  const effectiveSecureData = THREE_DS_ENABLED ? (secureData || '') : '';
  const effectiveSecureTransactionId = THREE_DS_ENABLED ? (secureTransactionId || '') : '';
  const effectiveEci = THREE_DS_ENABLED ? (eci || null) : null;


  if (!sessionId || !cardNumber || !expMonth || !expYear || !cvn) {
    return res.status(400).json({ ok: false, message: 'Faltan datos de tarjeta o sessionId' });
  }

  const client = await pool.connect();
  try {
    // 1) Cargar sesión y short-circuit si ya está pagada
    const s = await fetchSession(client, sessionId, customerId);
    if (!s) return res.status(404).json({ ok: false, message: 'Sesión no encontrada' });
    if (s.status === 'paid' && Array.isArray(s.created_order_ids) && s.created_order_ids.length) {
      return res.json({ ok: true, paid: true, orders: s.created_order_ids });
    }
    // ↓ order_meta que guardamos en la sesión (viene de checkout/front)
    const orderMeta =
      (s.metadata && s.metadata.order_meta)
      || (s.snapshot && s.snapshot.order_meta)
      || {};

    const snapshot = s.snapshot || {};
    const shipping = snapshot.shipping_address || null;
    const country = snapshot.country || 'CU';
    if (!shipping) {
      return res.status(400).json({ ok: false, message: 'Sesión sin dirección de envío' });
    }

    // 2) Releer carrito y recomputar subtotales/tax por owner
    const items = await loadCartItems(client, s.cart_id);
    if (!items.length) return res.status(400).json({ ok: false, message: 'Carrito vacío' });


    const groupsByOwner = {};
    for (const it of items) {
      const key = String(it.owner_id || 0);
      if (!groupsByOwner[key]) {
        groupsByOwner[key] = {
          owner_id: it.owner_id || null,
          owner_name: it.owner_name || null,
          subtotal_cents: 0,
          tax_cents: 0,
          owner_base_subtotal_cents: 0, // ← NUEVO: suma de base_cents * qty (snapshot)
          items: []
        };
      }

      // precios de venta (con margen) ya los calculabas
      const cim = it.cart_item_metadata || {};
      const uc = unitCents({ unit_price: it.unit_price, metadata: cim }); // cents
      const tc = taxCentsPerItem({ metadata: cim });                      // cents
      const qty = Number(it.quantity);

      // SNAPSHOT de costos del producto (preferir carrito si lo trae)
      const base_cents_snapshot = Number.isInteger(cim.base_cents)
        ? Number(cim.base_cents)
        : baseCentsFromProduct(it.product_metadata, it.product_price);

      const margin_pct_snapshot = Number.isFinite(Number(cim.margin_pct))
        ? Number(cim.margin_pct)
        : marginPctFromProduct(it.product_metadata);

      // Usamos el snapshot del carrito si viene; si no, el uc que ya calculaste
      const unit_cents_snapshot = Number.isInteger(cim.unit_cents_snapshot)
        ? Number(cim.unit_cents_snapshot)
        : uc;

      // duty: si viene directo del carrito, úsalo; si no, lo derivamos:
      // duty = round(unit / (1 + margin_pct/100)) - base   (truncate a >= 0)
      const duty_cents_snapshot = Number.isInteger(cim.duty_cents)
        ? Number(cim.duty_cents)
        : (margin_pct_snapshot >= 0
          ? Math.max(
            Math.round(unit_cents_snapshot / (1 + (margin_pct_snapshot / 100))) - base_cents_snapshot,
            0
          )
          : 0);

      // acumular totales por owner
      groupsByOwner[key].subtotal_cents += uc * qty;
      groupsByOwner[key].tax_cents += tc * qty;
      groupsByOwner[key].owner_base_subtotal_cents += base_cents_snapshot * qty;

      // guardar snapshots por ítem (los usaremos al insertar line_items)
      groupsByOwner[key].items.push({
        variant_id: it.variant_id || null, 
        product_id: it.product_id,
        quantity: qty,
        unit_cents: uc,
        tax_cents: tc,
        title: it.title,
        base_cents_snapshot,
        margin_pct_snapshot,
        unit_cents_snapshot,
        duty_cents: duty_cents_snapshot
      });

    }

    const transport =
      (orderMeta?.shipping && orderMeta.shipping.transport) ||
      (orderMeta?.shipping_prefs && orderMeta.shipping_prefs.transport) || null;


    // 3) Cotizar envío server-side
    const shipPayload = (country === 'CU')
      ? { country: 'CU', province: shipping.province, municipality: shipping.municipality, area_type: shipping.area_type, ...(transport ? { transport } : {}), }
      : { country: 'US', state: shipping.state, city: shipping.city, zip: shipping.zip };

    const quote = await quoteShippingThroughSelf({ token: authHeader, cartId: s.cart_id, shipping: shipPayload });
    if (!quote.ok || !quote.data) {
      return res.status(409).json({ ok: false, message: 'No se pudo cotizar el envío' });
    }
    if (quote.data.ok === false) {
      const msg = buildCoverageError({
        province: shipping.province,
        municipality: shipping.municipality,
        unavailable: Array.isArray(quote.data.unavailable) ? quote.data.unavailable : [],
      });
      return res.status(409).json({ ok: false, message: msg, reason: 'shipping_unavailable', unavailable: quote.data.unavailable || [] });
    }

    const shipping_total_cents = Number(quote.data.shipping_total_cents || 0);
    const shipping_breakdown = Array.isArray(quote.data.breakdown) ? quote.data.breakdown : [];

    // 4) Total final
    const subtotal_cents = Object.values(groupsByOwner).reduce((a, g) => a + g.subtotal_cents, 0);
    const tax_cents = Object.values(groupsByOwner).reduce((a, g) => a + g.tax_cents, 0);
    const grand_total_cents = subtotal_cents + tax_cents + shipping_total_cents;

    // === AÑADIDO: aplicar % de tarjeta en el servidor ===
    const CARD_FEE_PCT = Number(process.env.CARD_FEE_PCT ?? '3');
    const FEE_RATE = Number.isFinite(CARD_FEE_PCT) ? CARD_FEE_PCT / 100 : 0;

    const card_fee_cents = Math.round(grand_total_cents * FEE_RATE);
    const amount_cents = grand_total_cents + card_fee_cents;

    // Este 'amount' es lo que se envía al gateway (lo que realmente se cobra)
    const amount = Number((amount_cents / 100).toFixed(2));

    // === [ANTI-FRAUDE] Decidir si permitimos cobrar ===
    const ip = getClientIp(req);
    const bin = pickBin(cardNumber);
    const last4 = pickLast4(cardNumber);
    // hash con sal opcional (puedes añadir process.env.RISK_SALT si quieres)
    const cardHash = sha256(`${bin}:${last4}`);

    const amountOk = amount <= AMOUNT_SOFT_LIMIT;
    const veloOk = await velocityOk(client, { cardHash, ip });

    const decision = decideBy3DS({
      threeDSStatus: effectiveThreeDSStatus,
      amountOk,
      veloOk
    });


    await recordRiskEvent(client, {
      customer_id: customerId,
      ip,
      card_hash: cardHash,
      bin,
      last4,
      amount,
      three_ds: (effectiveThreeDSStatus || null),
      decision,
      outcome: decision === 'deny' ? 'preauth_denied' : null,
      note: decision === 'deny'
        ? `deny: 3DS=${effectiveThreeDSStatus} amountOk=${amountOk} veloOk=${veloOk}`
        : `preauth pass: 3DS=${effectiveThreeDSStatus} amountOk=${amountOk} veloOk=${veloOk}`
    });

    if (decision === 'deny') {
      return res.status(402).json({
        ok: false,
        paid: false,
        message: 'No pudimos procesar este pago. Prueba con otra tarjeta.',
        reason: 'risk_denied'
      });
    }


    // 5) Validar stock (lock pesimista previo al cobro)
    await client.query('BEGIN');
    for (const g of Object.values(groupsByOwner)) {
      for (const it of g.items) {
        if (it.variant_id) {
          const chk = await client.query(`SELECT stock_qty FROM product_variants WHERE id = $1 FOR UPDATE`, [it.variant_id]);
          if (!chk.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ ok: false, message: `Variante ${it.variant_id} no encontrada` });
          }
          const stock = Number(chk.rows[0].stock_qty || 0);
          if (stock < Number(it.quantity)) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              ok: false,
              message: `Stock insuficiente en la variante (pediste ${it.quantity}, quedan ${stock})`,
              reason: 'insufficient_stock'
            });
          }
        } else {
          const chk = await client.query(`SELECT stock_qty FROM products WHERE id = $1 FOR UPDATE`, [it.product_id]);
          if (!chk.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ ok: false, message: `Producto ${it.product_id} no encontrado` });
          }
          const stock = Number(chk.rows[0].stock_qty || 0);
          if (stock < Number(it.quantity)) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              ok: false,
              message: `Stock insuficiente para "${it.title}" (pediste ${it.quantity}, quedan ${stock})`,
              reason: 'insufficient_stock'
            });
          }
        }
      }
    }
    
    await client.query('COMMIT');

    // 6) Cobro en BMS
    // Usa un UTN estable por sesión
    let userTransactionNumber = s?.payment?.direct_utn || null;
    if (!userTransactionNumber) {
      userTransactionNumber = `${sessionId}-direct`;
      await client.query(
        `UPDATE checkout_sessions
       SET payment = COALESCE(payment,'{}'::jsonb)
                     || jsonb_build_object('direct_utn', $2::text)
     WHERE id = $1`,
        [sessionId, userTransactionNumber]
      );
    }

    const saleResp = await resilientSale(sale, {
      amount,
      zipCode,
      cardNumber,
      expMonth,
      expYear,
      cvn,
      nameOnCard,
      userTransactionNumber,
      secureData: String(effectiveSecureData || ''),
      secureTransactionId: String(effectiveSecureTransactionId || ''),
    });

    if (!saleResp.ok) {
      // registrar fallo para contadores de velocidad
      try {
        await recordRiskEvent(client, {
          customer_id: customerId,
          ip,
          card_hash: cardHash,
          bin,
          last4,
          amount,
          three_ds: (effectiveThreeDSStatus || null),
          decision: 'allow',
          outcome: 'success',
          note: saleResp.message || null
        });
      } catch { }

      if (looksLikeGateway500(saleResp.raw)) {
        return res.status(502).json({
          ok: false,
          paid: false,
          message: 'El proveedor de pago presentó un error temporal. Intenta nuevamente.',
          provider: 'bmspay',
          raw: null,
        });
      }
      console.error('[bmspay] decline', { msg: saleResp.message, code: saleResp.raw?.ResponseCode });
      return res.status(402).json({
        ok: false,
        paid: false,
        message: saleResp.message || 'Pago no aprobado',
        provider: 'bmspay'
      });
    }


    // 7) Crear órdenes + descontar stock con idempotencia fuerte y estado processing
    // registrar éxito para contadores de velocidad
    try {
      await recordRiskEvent(client, {
        customer_id: customerId,
        ip,
        card_hash: cardHash,
        bin,
        last4,
        amount,
        three_ds: (threeDSStatus || null),
        decision: 'allow',
        outcome: 'success',
        note: saleResp.message || null
      });
    } catch { }

    // 7) Crear órdenes + descontar stock...
    await client.query('BEGIN');


    // Bloquear sesión e idempotencia
    const { rows: sessLockRows } = await client.query(
      `SELECT id, status, created_order_ids, payment FROM checkout_sessions WHERE id = $1 FOR UPDATE`,
      [sessionId]
    );
    if (!sessLockRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, message: 'Sesión no encontrada' });
    }
    const sLocked = sessLockRows[0];

    if (sLocked.status === 'paid' && Array.isArray(sLocked.created_order_ids) && sLocked.created_order_ids.length) {
      await client.query('ROLLBACK');
      return res.json({ ok: true, paid: true, orders: sLocked.created_order_ids });
    }

    await client.query(
      `UPDATE checkout_sessions
            SET payment = COALESCE(payment,'{}'::jsonb)
                          || jsonb_build_object(
                               'AuthorizationNumber', $2::text,
                               'ServiceReferenceNumber', $3::text,
                               'UserTransactionNumber', $4::text,
                               'verbiage', $5::text,
                               'SecureTransactionId', $6::text,
                               'ThreeDS', jsonb_build_object(
                                'status', $7::text,
                                'eci', $8::text
                              )
                             )
          WHERE id = $1`,
      [
        sessionId,
        saleResp.authNumber || null,
        saleResp.reference || null,
        saleResp.userTransactionNumber || userTransactionNumber || null,
        saleResp.message || null,
        effectiveSecureTransactionId || null,
        effectiveThreeDSStatus || null,  // 👈
        effectiveEci || null,            // 👈
      ]
    );


    // Shipping por owner
    const shippingByOwner = {};
    for (const b of shipping_breakdown) {
      const k = String(b.owner_id ?? b.ownerId ?? '');
      if (!k) continue;
      shippingByOwner[k] = Number(b.shipping_cents || 0) / 100;
    }

    const createdOrderIds = [];

    // nombre del cliente
    let customerName =
      [shipping.first_name, shipping.last_name].filter(Boolean).join(' ').trim() || null;
    if (!customerName) {
      const { rows: custR } = await client.query(
        `SELECT first_name, last_name FROM customers WHERE id = $1 LIMIT 1`,
        [customerId]
      );
      if (custR.length) {
        customerName =
          [custR[0].first_name, custR[0].last_name].filter(Boolean).join(' ').trim() || null;
      }
    }

    // Crear órdenes + line_items + descuento stock
    for (const g of Object.values(groupsByOwner)) {
      const ownerId = g.owner_id || null;
      const ownerSubtotal = Number((g.subtotal_cents / 100).toFixed(2));
      const ownerTax = Number((g.tax_cents / 100).toFixed(2));
      const ownerShip = Number((Number(shippingByOwner[String(ownerId)] || 0)).toFixed(2));
      const ownerTotal = Number((ownerSubtotal + ownerTax + ownerShip).toFixed(2));

      const owner_base_total_cents = Math.round((ownerSubtotal + ownerTax + ownerShip) * 100);
      const owner_card_fee_cents = Math.round(owner_base_total_cents * FEE_RATE);
      const owner_total_with_fee_cents = owner_base_total_cents + owner_card_fee_cents;

      const owner_base_subtotal_cents = g.owner_base_subtotal_cents;

      const ordQ = await client.query(
        `INSERT INTO orders (customer_id, owner_id, customer_name, status, payment_method, total, metadata)
        VALUES ($1, $2, $3, 'paid', 'bmspay_direct', $4, $5::jsonb)
        RETURNING id`,
        [
          customerId,
          ownerId,
          customerName,
          ownerTotal, // ← OJO: este sigue siendo total sin fee, como ya lo hacías
          JSON.stringify({
            checkout_session_id: s.id,
            shipping: { country, ...shipping },
            billing: orderMeta.billing || null,
            terms: orderMeta.terms || undefined,
            payer: orderMeta.payer || undefined,
            pricing: { // USD (humano)
              subtotal: ownerSubtotal,
              tax: ownerTax,
              shipping: ownerShip,
              total: Number((owner_base_total_cents / 100).toFixed(2)),
              card_fee_pct: CARD_FEE_PCT,
              card_fee: Number((owner_card_fee_cents / 100).toFixed(2)),
              total_with_card: Number((owner_total_with_fee_cents / 100).toFixed(2)),
              owner_base_subtotal: Number((owner_base_subtotal_cents / 100).toFixed(2)) // ← NUEVO
            },
            pricing_cents: { // CENTAVOS (verdad)
              subtotal_cents: Math.round(ownerSubtotal * 100),
              tax_cents: Math.round(ownerTax * 100),
              shipping_total_cents: Math.round(ownerShip * 100),
              card_fee_cents: owner_card_fee_cents,
              total_with_card_cents: owner_total_with_fee_cents,
              owner_base_subtotal_cents // ← NUEVO
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
              threeds: {
                status: effectiveThreeDSStatus || null,
                eci: effectiveEci || null,
                dsTransId: effectiveSecureTransactionId || null
              }
            },

          })
        ]
      );

      const orderId = ordQ.rows[0].id;
      createdOrderIds.push(orderId);

      for (const it of g.items) {
        const lineMeta = {
          base_cents: it.base_cents_snapshot,          // snapshot del costo base
          margin_pct: it.margin_pct_snapshot,          // snapshot del margen
          unit_cents_snapshot: it.unit_cents_snapshot, // precio vendido (snapshot)
          tax_cents_snapshot: it.tax_cents,            // opcional (ya lo tenías)
          duty_cents: it.duty_cents,                   // <-- NUEVO
          // opcionalmente deja también el precio con margen explícito:
          price_with_margin_cents: it.unit_cents_snapshot
        };

        await client.query(
          `INSERT INTO line_items (order_id, product_id, variant_id, quantity, unit_price, metadata)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            orderId,
            it.product_id,
            it.variant_id || null,                                   // 👈 ahora se guarda
            Number(it.quantity),
            Number((it.unit_cents / 100).toFixed(2)),
            JSON.stringify(lineMeta)
          ]
        );
        
        if (it.variant_id) {
          const upd = await client.query(
            `UPDATE product_variants
                SET stock_qty = stock_qty - $1
              WHERE id = $2 AND stock_qty >= $1`,
            [Number(it.quantity), it.variant_id]
          );
          if (upd.rowCount !== 1) {
            throw new Error(`Race stock for variant ${it.variant_id}`);
          }
        } else {
          const upd = await client.query(
            `UPDATE products
                SET stock_qty = stock_qty - $1,
                    metadata = (COALESCE(metadata,'{}'::jsonb) - 'archived')
                             || jsonb_build_object('archived', CASE WHEN (stock_qty - $1) <= 0 THEN true ELSE false END)
              WHERE id = $2 AND stock_qty >= $1`,
            [Number(it.quantity), it.product_id]
          );
          if (upd.rowCount !== 1) {
            throw new Error(`Race stock for product ${it.product_id}`);
          }
        }
        

      }

    }

    // Finalizar sesión → paid
    await client.query(
      `UPDATE checkout_sessions
          SET status = 'paid',
              processed_at = now(),
              payment = COALESCE(payment,'{}'::jsonb)
                        || jsonb_build_object('status', 1),
              snapshot = COALESCE(snapshot,'{}'::jsonb)
                         || jsonb_build_object(
                              'shipping_by_owner', $2::jsonb,
                              'pricing', jsonb_build_object(
                              'subtotal_cents', $3::int,
                              'tax_cents', $4::int,
                              'shipping_total_cents', $5::int,
                              'card_fee_cents', $6::int,
                              'total_with_card_cents', $7::int
                              )
                            ),
              created_order_ids = $8::int[]
        WHERE id = $1`,
      [
        sessionId,
        JSON.stringify(shippingByOwner),
        subtotal_cents,
        tax_cents,
        shipping_total_cents,
        card_fee_cents,
        amount_cents,
        createdOrderIds
      ]
    );

    if (s.cart_id) {
      await client.query(
        `UPDATE carts SET completed = true, metadata = COALESCE(metadata,'{}'::jsonb) WHERE id = $1`,
        [s.cart_id]
      );
      await client.query(`DELETE FROM cart_items WHERE cart_id = $1`, [s.cart_id]);
    }

    await client.query('COMMIT');

    // Emails post-COMMIT (cliente + owner)
    const ids = createdOrderIds.slice();
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    (async () => {
      for (const oid of ids) {
        try {
          const detail = await loadOrderDetail(oid);
          if (!detail) {
            console.warn(`[emails] Sin detalle para orden #${oid}`);
            continue;
          }
          const { order: ord, items } = detail;

          const customerEmail =
            (ord.customer_email && String(ord.customer_email).trim()) ||
            (ord.metadata?.billing?.email && String(ord.metadata.billing.email).trim()) ||
            (ord.metadata?.shipping?.email && String(ord.metadata.shipping.email).trim()) ||
            null;

          const ownerEmailRaw = (Array.isArray(items) && items.find(x => x.owner_email)?.owner_email) || null;
          const ownerEmail = ownerEmailRaw ? String(ownerEmailRaw).trim() : null;

          const subjectSuffix = `#${oid}`;

          const tasks = [];
          if (customerEmail) {
            tasks.push(
              sendCustomerOrderEmail(customerEmail, { ...ord, _subjectSuffix: subjectSuffix, _emailRole: 'customer' }, items)
                .then(() => console.log(`[emails] OK cliente ${customerEmail} → orden #${oid}`))
                .catch(e => console.error(`[emails] FAIL cliente ${customerEmail} → orden #${oid}`, e))
            );
          } else {
            console.warn(`[emails] Cliente sin email para orden #${oid}`);
          }
          tasks.push(
            sendOwnerOrderEmail(
              ownerEmail, // puede ser null/undefined; el helper cae a ADMIN_EMAILS
              { ...ord, _subjectSuffix: subjectSuffix, _emailRole: 'owner' },
              items
            )
              .then(() => {
                const who = ownerEmail || (process.env.ADMIN_EMAILS || 'admin');
                console.log(`[emails] OK owner-copy ${who} → orden #${oid}`);
              })
              .catch(e => console.error(`[emails] FAIL owner-copy → orden #${oid}`, e))
          );


          await Promise.allSettled(tasks);
          await delay(1800);
        } catch (e) {
          console.error(`[emails] Error procesando orden #${oid}:`, e);
        }
      }
    })().catch(() => { });

    return res.json({
      ok: true,
      paid: true,
      orders: createdOrderIds,
      auth: saleResp.authNumber || null,
      ref: saleResp.reference || null,
      utn: saleResp.userTransactionNumber || userTransactionNumber || null,
      message: saleResp.message || 'Aprobado',
      sessionId,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[payments-direct] sale error', e);
    return res.status(500).json({ ok: false, paid: false, message: e.message || 'Error procesando pago' });
  } finally {
    client.release();
  }
});

module.exports = router;
