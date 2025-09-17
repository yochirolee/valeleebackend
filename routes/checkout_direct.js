// routes/checkout_direct.js
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;

// % fee para tarjeta
const CARD_FEE_PCT = Number(process.env.CARD_FEE_PCT ?? '3');
const FEE_RATE = Number.isFinite(CARD_FEE_PCT) ? CARD_FEE_PCT / 100 : 0;
const API_BASE_URL = process.env.API_BASE_URL;

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


/* =========================
 * Helpers
 * =======================*/

// Auth local (no dependemos de ../middleware/authenticateToken)
function ensureAuth(req, res, next) {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.split(' ')[1];
    if (!token) return res.sendStatus(401);
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.id, email: payload.email };
    next();
  } catch {
    return res.sendStatus(403);
  }
}

// Normaliza zona Habana/Provincias + city/municipio
function zoneKeyForCuba(province, area_type) {
  const prov = String(province || '').trim().toLowerCase();
  const isHabana = (prov === 'la habana');
  const isCity = String(area_type || '').toLowerCase() === 'city';
  if (isHabana) return isCity ? 'habana_city' : 'habana_municipio';
  return isCity ? 'provincias_city' : 'provincias_municipio';
}

// Redondeo numérico seguro
const to2 = (n) => Number((Number(n) || 0).toFixed(2));

/**
 * Carga items del carrito con datos necesarios para precios, peso y owner
 */
async function loadCartItems(cartId) {
  const sql = `
    SELECT
      ci.product_id,
      ci.quantity::int                           AS quantity,
      ci.unit_price::numeric                     AS unit_price,  -- USD por unidad (display con margen)
      ci.metadata                                AS item_meta,   -- guarda tax_cents, etc.
      COALESCE(p.weight, 0)::float               AS weight_lb,   -- peso por unidad
      COALESCE(p.stock_qty, 0)::int              AS stock_qty,
      p.title                                    AS title,
      p.owner_id                                 AS owner_id,
      o.name                                     AS owner_name
    FROM cart_items ci
    JOIN products p ON p.id = ci.product_id
    LEFT JOIN owners   o ON o.id = p.owner_id
    WHERE ci.cart_id = $1
    ORDER BY ci.id ASC;
  `;
  const { rows } = await pool.query(sql, [cartId]);
  return rows;
}

/**
 * Valida stock contra cantidad pedida
 */
function buildStockIssues(items) {
  const issues = [];
  for (const it of items) {
    const available = Number(it.stock_qty || 0);
    const requested = Number(it.quantity || 0);
    if (available < requested) {
      issues.push({
        product_id: it.product_id,
        title: it.title,
        owner_name: it.owner_name || null,
        requested,
        available,
      });
    }
  }
  return issues;
}

/**
 * Agrupa por owner los items para calcular envío por owner
 */
function groupByOwner(items) {
  const groups = new Map(); // key = owner_id (puede ser null)

  for (const it of items) {
    const key = it.owner_id == null ? 'null' : String(it.owner_id);
    if (!groups.has(key)) {
      groups.set(key, {
        owner_id: it.owner_id || null,
        owner_name: it.owner_name || (it.owner_id ? `Owner #${it.owner_id}` : 'General'),
        items: [],
        weight_lb: 0,
        subtotal: 0,
        tax: 0,
      });
    }
    const g = groups.get(key);
    g.items.push(it);
    g.weight_lb += (Number(it.weight_lb) || 0) * (Number(it.quantity) || 0);
    g.subtotal += (Number(it.unit_price) || 0) * (Number(it.quantity) || 0);
    const tax_cents = Number(it.item_meta?.tax_cents || 0);
    g.tax += (tax_cents / 100) * (Number(it.quantity) || 0);
  }

  // redondeos
  for (const [, g] of groups) {
    g.weight_lb = to2(g.weight_lb);
    g.subtotal = to2(g.subtotal);
    g.tax = to2(g.tax);
  }

  return Array.from(groups.values());
}

/* =========================
 *   POST /checkout-direct/start-direct
 * =======================*/

router.post('/start-direct', ensureAuth, async (req, res) => {
  const { cartId, shipping, locale } = req.body || {};

  // Validación mínima de shipping
  if (!shipping || !shipping.country) {
    return res.status(400).json({ ok: false, message: 'Falta dirección de envío' });
  }
  const metaFromClient = (req.body && req.body.metadata) ? req.body.metadata : {};
  const orderMeta = {
    ...metaFromClient,
    shipping, // canonizamos el shipping que se usará
    locale: (locale === 'en' || locale === 'es') ? locale : (process.env.DEFAULT_LOCALE || 'es'),
  };

  const country = String(shipping.country).toUpperCase();
  if (country === 'CU') {
    const required = ['first_name', 'last_name', 'phone', 'email', 'province', 'municipality', 'address', 'area_type'];
    const missing = required.filter(k => !String(shipping[k] || '').trim());
    if (missing.length) return res.status(400).json({ ok: false, message: `Faltan campos de envío CU: ${missing.join(', ')}` });
  } else if (country === 'US') {
    const required = ['first_name', 'last_name', 'phone', 'email', 'address_line1', 'city', 'state', 'zip'];
    const missing = required.filter(k => !String(shipping[k] || '').trim());
    if (missing.length) return res.status(400).json({ ok: false, message: `Faltan campos de envío US: ${missing.join(', ')}` });
  } else {
    return res.status(400).json({ ok: false, message: 'País de envío no soportado' });
  }

  const client = await pool.connect();
  try {
    // 1) Cargar items del carrito
    const items = await loadCartItems(cartId);
    if (!items.length) {
      return res.status(400).json({ ok: false, message: 'Carrito vacío' });
    }

    // 2) Validar stock
    const stockIssues = buildStockIssues(items);
    if (stockIssues.length) {
      return res.status(409).json({ ok: false, message: 'Hay productos sin disponibilidad.', unavailable: stockIssues });
    }

    // 3) Agrupar por owner y calcular subtotal/tax/weight
    const groups = groupByOwner(items);

    // 4) Cotizar envío usando el endpoint central (respeta transport = 'sea' | 'air')
    const quote = await quoteShippingThroughSelf({
      token: req.headers['authorization'],
      cartId,
      shipping, // ← incluye transport cuando country === 'CU'
    });

    if (!quote.ok || !quote.data) {
      return res.status(409).json({ ok: false, message: 'No se pudo cotizar el envío' });
    }
    if (quote.data.ok === false) {
      return res.status(400).json({
        ok: false,
        message: 'Uno o más proveedores no pueden entregar a la dirección seleccionada.',
        unavailable: Array.isArray(quote.data.unavailable) ? quote.data.unavailable : [],
      });
    }

    const shipping_total_cents = Number(quote.data.shipping_total_cents || 0);
    const breakdown = Array.isArray(quote.data.breakdown) ? quote.data.breakdown : [];

    // === per-owner: mapa owner_id -> monto USD
    const shippingByOwner = breakdown.reduce((acc, b) => {
      const key = String(b.owner_id ?? 'null');
      acc[key] = Number((Number(b.shipping_cents || 0) / 100).toFixed(2));
      return acc;
    }, {});

    // 5) Totales
    const subtotal = to2(groups.reduce((acc, g) => acc + g.subtotal, 0));
    const tax = to2(groups.reduce((acc, g) => acc + g.tax, 0));     
    const shippingTotal = Number((shipping_total_cents / 100).toFixed(2));
    const baseTotal = to2(subtotal + tax + shippingTotal);
    const cardFee = to2(baseTotal * FEE_RATE);
    const amountDirect = to2(baseTotal + cardFee);  // ← a cobrar con tarjeta

    // 6) Guardar sesión
    await client.query('BEGIN');

    // Normalizamos address para snapshot (mismas claves del front, pero “flat”)
    const shipping_address = (country === 'CU')
      ? {
        first_name: shipping.first_name,
        last_name: shipping.last_name,
        phone: shipping.phone,
        email: shipping.email,
        ci: shipping.ci || null,
        province: shipping.province,
        municipality: shipping.municipality,
        address: shipping.address,
        area_type: shipping.area_type,
        instructions: shipping.instructions || null,
        transport: shipping.transport || null,
      }
      : {
        first_name: shipping.first_name,
        last_name: shipping.last_name,
        phone: shipping.phone,
        email: shipping.email,
        address_line1: shipping.address_line1,
        address_line2: shipping.address_line2 || null,
        city: shipping.city,
        state: shipping.state,
        zip: shipping.zip,
        instructions: shipping.instructions || null,
      };


    const snapshot = {
      groups: groups.map(g => ({
        owner_id: g.owner_id,
        owner_name: g.owner_name,
        items: g.items.map(it => ({
          product_id: it.product_id,
          title: it.title,
          quantity: it.quantity,
          unit_price: Number(it.unit_price),
        })),
        weight_lb: g.weight_lb,
        subtotal: g.subtotal,
        tax: g.tax,
      })),
      shipping_by_owner: shippingByOwner,
      shipping_address,
      pricing: {
        subtotal,
        tax,
        shipping: shippingTotal,
        total: baseTotal,                    // total de la orden sin fee
        card_fee_pct: CARD_FEE_PCT,
        card_fee: cardFee,
        total_with_card_fee: amountDirect,   // estimado con fee
      },
      country,
      locale: (locale === 'en' || locale === 'es') ? locale : (process.env.DEFAULT_LOCALE || 'es'),
      order_meta: orderMeta,
    };

    const ins = await client.query(
      `INSERT INTO checkout_sessions (customer_id, cart_id, status, payment_method, snapshot, amount_total, metadata)
          VALUES ($1, $2, 'pending', 'bmspay_direct', $3::jsonb, $4, $5::jsonb)
          RETURNING id`,
      [
        req.user.id,
        cartId,
        JSON.stringify(snapshot),
        baseTotal,
        JSON.stringify({ order_meta: orderMeta }) // 👈 aquí viaja billing/terms/payer/etc
      ]
    );

    await client.query('COMMIT');

    return res.json({
      ok: true,
      sessionId: ins.rows[0].id,
      amount: amountDirect, // el modal cobra esto
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[start-direct] error', e);
    return res.status(500).json({ ok: false, message: e.message || 'Error iniciando pago directo' });
  } finally {
    client.release();
  }
});

module.exports = router;
