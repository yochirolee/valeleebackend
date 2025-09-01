// routes/payments_direct.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const authenticateToken = require('../middleware/authenticateToken');
const { sale } = require('../services/bmspaySale');
const { sendCustomerOrderEmail, sendOwnerOrderEmail } = require('../helpers/emailOrders');

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:4000';

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
      ci.quantity,
      ci.unit_price,
      ci.metadata,
      p.title,
      p.owner_id,
      o.name AS owner_name
    FROM cart_items ci
    LEFT JOIN products p ON p.id = ci.product_id
    LEFT JOIN owners o ON o.id = p.owner_id
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

async function quoteShippingThroughSelf({ token, cartId, shipping }) {
  const res = await fetch(`${API_BASE_URL}/shipping/quote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {}),
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
    SELECT o.id, o.created_at, o.status, o.metadata,
           c.email AS customer_email, c.first_name, c.last_name
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
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
  } = req.body || {};

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
          items: []
        };
      }
      const uc = unitCents(it);
      const tc = taxCentsPerItem(it);
      const qty = Number(it.quantity);
      groupsByOwner[key].subtotal_cents += uc * qty;
      groupsByOwner[key].tax_cents += tc * qty;
      groupsByOwner[key].items.push({ product_id: it.product_id, quantity: qty, unit_cents: uc, tax_cents: tc, title: it.title });
    }

    // 3) Cotizar envío server-side
    const shipPayload = (country === 'CU')
      ? { country: 'CU', province: shipping.province, municipality: shipping.municipality, area_type: shipping.area_type }
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
    const amount = Number((grand_total_cents / 100).toFixed(2));

    // 5) Validar stock (lock pesimista previo al cobro)
    await client.query('BEGIN');
    for (const g of Object.values(groupsByOwner)) {
      for (const it of g.items) {
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
    await client.query('COMMIT');

    // 6) Cobro en BMS
    const userTransactionNumber = `${sessionId}-${Date.now().toString(36)}`;
    const saleResp = await resilientSale(sale, {
      amount,
      zipCode,
      cardNumber,
      expMonth,
      expYear,
      cvn,
      nameOnCard,
      userTransactionNumber,
    });
    if (!saleResp.ok) {
      if (looksLikeGateway500(saleResp.raw)) {
        return res.status(502).json({
          ok: false,
          paid: false,
          message: 'El proveedor de pago presentó un error temporal. Intenta nuevamente.',
          provider: 'bmspay',
          raw: null,
        });
      }
      return res.status(402).json({
        ok: false,
        paid: false,
        message: saleResp.message || 'Pago no aprobado',
        provider: 'bmspay',
        raw: saleResp.raw || null,
      });
    }

    // 7) Crear órdenes + descontar stock con idempotencia fuerte y estado processing
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

      const ordQ = await client.query(
        `INSERT INTO orders (customer_id, owner_id, customer_name, status, payment_method, total, metadata)
         VALUES ($1, $2, $3, 'paid', 'bmspay_direct', $4, $5::jsonb)
         RETURNING id`,
        [
          customerId,
          ownerId,
          customerName,
          ownerTotal,
          JSON.stringify({
            checkout_session_id: s.id,
            shipping,
            billing: orderMeta.billing || null,
            terms: orderMeta.terms || undefined,
            payer: orderMeta.payer || undefined,
            pricing: { subtotal: ownerSubtotal, tax: ownerTax, shipping: ownerShip, total: ownerTotal },
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
      );
      const orderId = ordQ.rows[0].id;
      createdOrderIds.push(orderId);

      for (const it of g.items) {
        await client.query(
          `INSERT INTO line_items (order_id, product_id, quantity, unit_price, metadata)
           VALUES ($1, $2, $3, $4, '{}'::jsonb)`,
          [orderId, it.product_id, Number(it.quantity), Number((it.unit_cents / 100).toFixed(2))]
        );
        await client.query(
          `UPDATE products
              SET stock_qty = stock_qty - $1,
                  metadata = (COALESCE(metadata,'{}'::jsonb) - 'archived')
                           || jsonb_build_object('archived', CASE WHEN (stock_qty - $1) <= 0 THEN true ELSE false END)
            WHERE id = $2`,
          [Number(it.quantity), it.product_id]
        );
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
                                 'shipping_total_cents', $5::int
                              )
                            ),
              created_order_ids = $6::int[]
        WHERE id = $1`,
      [
        sessionId,
        JSON.stringify(shippingByOwner),
        subtotal_cents,
        tax_cents,
        shipping_total_cents,
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
          if (ownerEmail) {
            tasks.push(
              sendOwnerOrderEmail(ownerEmail, { ...ord, _subjectSuffix: subjectSuffix, _emailRole: 'owner' }, items)
                .then(() => console.log(`[emails] OK owner ${ownerEmail} → orden #${oid}`))
                .catch(e => console.error(`[emails] FAIL owner ${ownerEmail} → orden #${oid}`, e))
            );
          } else {
            console.warn(`[emails] Owner sin email para orden #${oid}`);
          }

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
