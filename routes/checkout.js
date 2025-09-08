// routes/checkout.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { addPaymentLink, withReturnUrl } = require('../services/bmspay');
const { shippingForOwner } = require('../services/shipping');

// POST /checkout/:cartId  (crea checkout_session + link de pago)
router.post('/:cartId', async (req, res) => {
  const client = await pool.connect();
  try {
    const { cartId } = req.params;
    const { metadata = {}, payment_method = 'bmspay' } = req.body;
    const shipping = metadata?.shipping || {}; // {country, province/provincia, municipality, area_type, ...}
    const orderMeta = {
      ...metadata,                 // aquí vendrá billing/payer/terms si el front lo mandó
      shipping,                    // canonizamos shipping
      locale: (metadata?.locale === 'en' || metadata?.locale === 'es')
        ? metadata.locale
        : (process.env.DEFAULT_LOCALE || 'es'),
    };
    await client.query('BEGIN');

    // Carrito del usuario
    const cartQ = await client.query(
      'SELECT id, customer_id, completed, metadata FROM carts WHERE id = $1 AND customer_id = $2',
      [cartId, req.user.id]
    );
    const cart = cartQ.rows[0];
    if (!cart) { await client.query('ROLLBACK'); return res.status(404).send('Carrito no encontrado'); }
    if (cart.completed) {
      await client.query('ROLLBACK');
      return res.status(400).send('Carrito ya fue marcado como completado');
    }

    // Items + join products para owner y weight
    const itemsQ = await client.query(`
      SELECT ci.*, p.owner_id, p.weight, p.title, p.image_url
        FROM cart_items ci
        JOIN products p ON p.id = ci.product_id
       WHERE ci.cart_id = $1
       ORDER BY ci.id ASC`, [cart.id]);
    const items = itemsQ.rows;
    if (!items.length) { await client.query('ROLLBACK'); return res.status(400).send('Carrito vacío'); }

    // Totales base y tax (guardado en metadata.tax_cents por ítem)
    const subtotalUsd = items.reduce((s, it) => s + Number(it.unit_price) * Number(it.quantity), 0);
    const taxUsd = items.reduce((s, it) => {
      const cents = Number(it.metadata?.tax_cents || 0);
      return s + (cents * Number(it.quantity)) / 100;
    }, 0);

    // Agrupar por owner para calcular shipping y para snapshot
    const byOwner = new Map();
    for (const it of items) {
      const key = String(it.owner_id || '0');
      if (!byOwner.has(key)) byOwner.set(key, { owner_id: it.owner_id, items: [], weight_lbs: 0, subtotal: 0, tax: 0 });
      const g = byOwner.get(key);
      g.items.push({
        product_id: it.product_id,
        title: it.title,
        image_url: it.image_url,
        quantity: Number(it.quantity),
        unit_price: Number(it.unit_price)
      });
      g.weight_lbs += (Number(it.weight) || 0) * Number(it.quantity);
      g.subtotal  += Number(it.unit_price) * Number(it.quantity);
      const tax_cents = Number(it.metadata?.tax_cents || 0) * Number(it.quantity);
      g.tax += tax_cents / 100;
    }

    // Normalizar dirección de envío
    const country   = (shipping?.country || 'CU').toUpperCase();
    const province  = shipping?.province || shipping?.provincia || '';
    const area_type = shipping?.area_type || 'city';

    // Calcular shipping por owner usando owner_shipping_config
    const shippingByOwner = {};
    let shippingTotal = 0;
    for (const [k, g] of byOwner.entries()) {
      const fee = await shippingForOwner({
        owner_id: g.owner_id,
        country,
        province,
        area_type,
        total_weight_lbs: g.weight_lbs
      });
      shippingByOwner[k] = Number(fee.toFixed(2));
      shippingTotal += shippingByOwner[k];
    }

    const totalUsd = Number((subtotalUsd + taxUsd + shippingTotal).toFixed(2));

    // Crear checkout_session (snapshot con desglose)
    const sessionQ = await client.query(
      `INSERT INTO checkout_sessions (customer_id, cart_id, status, amount_total, snapshot, metadata)
       VALUES ($1, $2, 'pending', $3, $4::jsonb, $5::jsonb)
       RETURNING id`,
      [
        cart.customer_id,
        cart.id,
        totalUsd,
        JSON.stringify({
          country,
          shipping_address: shipping,
          groups: Array.from(byOwner.values()),
          shipping_by_owner: shippingByOwner,
          pricing: { subtotal: subtotalUsd, tax: taxUsd, shipping: shippingTotal, total: totalUsd },
          order_meta: orderMeta,
        }),
        JSON.stringify({ payment_method, order_meta: orderMeta })
      ]
    );
    const sessionId = sessionQ.rows[0].id;

    // Payment Link (invoiceNumber = sessionId)
    const FRONT_URL = process.env.CLIENT_BASE_URL || 'http://localhost:3000';
    const loc = (metadata && metadata.locale) ? `/${metadata.locale}` : '';
    const returnUrl = `${FRONT_URL}${loc}/checkout/success?sessionId=${sessionId}`;

    const pl = await addPaymentLink({
      amount: totalUsd.toFixed(2),
      description: `Checkout Session #${sessionId} • Sub ${subtotalUsd.toFixed(2)} • Tax ${taxUsd.toFixed(2)} • Ship ${shippingTotal.toFixed(2)}`,
      invoiceNumber: String(sessionId),
    });
    const payUrl = withReturnUrl(pl.link, returnUrl);

    // Guardar info del link en la sesión
    await client.query(
      `UPDATE checkout_sessions
          SET payment = $2::jsonb
        WHERE id = $1`,
      [
        sessionId,
        JSON.stringify({
          provider: 'bmspay',
          link_id: pl.id,
          link: payUrl,
          link_original: pl.link,
          invoice: pl.invoiceNumber,
          status: pl.status
        })
      ]
    );

    await client.query('COMMIT');
    return res.json({ sessionId, payUrl });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('checkout session error', e);
    return res.status(500).json({ message: 'Error en checkout' });
  } finally {
    client.release();
  }
});

module.exports = router;
