// routes/payments.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { getPaymentStatus } = require('../services/bmspay');
const { sendCustomerOrderEmail, sendOwnerOrderEmail } = require('../helpers/emailOrders');

// util: carga una orden con ítems + owner
async function loadOrderDetail(orderId) {
  // usamos pool directo (nuevo client) para no depender del que ya cerraste con COMMIT
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
      LEFT JOIN owners ow ON ow.id = p.owner_id   -- adapta si usas otra columna
     WHERE li.order_id = $1
     ORDER BY li.id ASC
  `;
  const { rows: items } = await pool.query(itemsQ, [orderId]);

  return { order, items };
}

// GET /payments/bmspay/confirm/:sessionId
router.get('/bmspay/confirm/:sessionId', async (req, res) => {
  const sessionId = String(req.params.sessionId);
  const client = await pool.connect();

  try {
    // Cargar sesión
    const { rows } = await client.query(
      `SELECT * FROM checkout_sessions WHERE id = $1`,
      [sessionId]
    );
    if (!rows.length) {
      return res.status(404).json({ ok: false, paid: false, message: 'Sesión no encontrada' });
    }
    const s = rows[0];
    const payMeta = s.payment || {};
    const linkId = payMeta.link_id || null;
    const originalLink = payMeta.link_original || payMeta.link || null;

    // Idempotencia
    if (s.status === 'paid' && Array.isArray(s.created_order_ids) && s.created_order_ids.length) {
      return res.json({ ok: true, paid: true, orders: s.created_order_ids });
    }

    // Confirmar con el proveedor (por invoiceNumber = sessionId)
    const result = await getPaymentStatus(sessionId, {
      link: originalLink || undefined,
      invoiceNumber: sessionId
    });

    if (!result.ok) {
      return res.json({ ok: false, paid: false, message: result.error?.message || 'No se pudo confirmar' });
    }
    if (!result.paid) {
      return res.json({ ok: true, paid: false, active: result.active, status: result?.paymentLink?.Status ?? null });
    }

    // Validaciones mínimas
    const pl = result.paymentLink || {};
    const invoiceMatches = String(pl.InvoiceNumber || '') === String(sessionId);
    const idMatches = linkId ? (String(pl.Id || '').toLowerCase() === String(linkId).toLowerCase()) : true;
    if (!invoiceMatches || !idMatches) {
      return res.json({ ok: true, paid: false, message: 'Confirmación no coincide' });
    }

    // --- Crear órdenes por owner (atómico) ---
    await client.query('BEGIN');

    const snapshot = s.snapshot || {};
    const orderMeta =
      (s.metadata && s.metadata.order_meta)
      || (snapshot && snapshot.order_meta)
      || {};
    const groups = Array.isArray(snapshot.groups) ? snapshot.groups : [];
    const shippingByOwner = snapshot.shipping_by_owner || {};
    const address = snapshot.shipping_address || {};
    const pricing = snapshot.pricing || {};
    const country = snapshot.country || 'CU';

    // Nombre del cliente para guardar en orders.customer_name
    let customerName =
      [address.first_name, address.last_name].filter(Boolean).join(' ').trim() || null;

    if (!customerName) {
      const cust = await client.query(
        'SELECT first_name, last_name FROM customers WHERE id = $1 LIMIT 1',
        [s.customer_id]
      );
      if (cust.rows.length) {
        customerName =
          [cust.rows[0].first_name, cust.rows[0].last_name].filter(Boolean).join(' ').trim() || null;
      }
    }


    const createdOrderIds = [];

    for (const g of groups) {
      const ownerId = g.owner_id || null;
      const ownerSubtotal = Number(g.subtotal || 0);
      const ownerTax = Number(g.tax || 0);
      const ownerShipping = Number(shippingByOwner[String(ownerId)] || 0);
      const ownerTotal = Number((ownerSubtotal + ownerTax + ownerShipping).toFixed(2));

      // Validar stock (bloqueo fila)
      for (const it of g.items) {
        const check = await client.query('SELECT stock_qty FROM products WHERE id = $1 FOR UPDATE', [it.product_id]);
        if (!check.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, message: 'Producto no encontrado' }); }
        const stock = Number(check.rows[0].stock_qty || 0);
        if (stock < Number(it.quantity)) {
          await client.query('ROLLBACK');
          return res.status(409).json({ ok: false, message: `Stock insuficiente para producto ${it.product_id}` });
        }
      }

      // Crear orden del owner      
      const ordQ = await client.query(
        `INSERT INTO orders (customer_id, owner_id, customer_name, status, payment_method, total, metadata)
   VALUES ($1, $2, $3, 'paid', 'bmspay', $4, $5::jsonb)
   RETURNING id`,
        [
          s.customer_id,
          ownerId,
          customerName,
          ownerTotal,
          JSON.stringify({
            session_id: s.id,
            shipping: { country, ...address },
            billing: orderMeta.billing || null,
            terms: orderMeta.terms || undefined,
            payer: orderMeta.payer || undefined,
            pricing: {
              subtotal: ownerSubtotal,
              tax: ownerTax,
              shipping: ownerShipping,
              total: ownerTotal
            },
            payment: {
              provider: 'bmspay',
              link: (s.payment && (s.payment.link || s.payment.link_original)) || null,
              link_id: s.payment?.link_id || null,
              invoice: String(s.id),           // usamos sessionId como invoice
              status: 1
            },
            bmspay_transaction: result.paymentLink || null
          })
        ]
      );

      const orderId = ordQ.rows[0].id;
      createdOrderIds.push(orderId);

      // line_items + descontar stock
      for (const it of g.items) {
        await client.query(
          `INSERT INTO line_items (order_id, product_id, quantity, unit_price, metadata)
           VALUES ($1, $2, $3, $4, '{}'::jsonb)`,
          [orderId, it.product_id, Number(it.quantity), Number(it.unit_price)]
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

    // Marcar sesión pagada y cerrar carrito
    await client.query(
      `UPDATE checkout_sessions
          SET status = 'paid',
              processed_at = now(),
              payment = COALESCE(payment,'{}'::jsonb) || jsonb_build_object('status', 1),
              created_order_ids = $2::int[]
        WHERE id = $1`,
      [sessionId, createdOrderIds]
    );

    if (s.cart_id) {
      await client.query(`UPDATE carts SET completed = true, metadata = COALESCE(metadata,'{}'::jsonb) WHERE id = $1`, [s.cart_id]);
      await client.query(`DELETE FROM cart_items WHERE cart_id = $1`, [s.cart_id]);
    }

    await client.query('COMMIT');

    // === Enviar emails en background (después del COMMIT) ===
    const ids = createdOrderIds.slice();

    // pequeña función helper para dormir
    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    for (const oid of ids) {
      try {
        const detail = await loadOrderDetail(oid);
        if (!detail) {
          console.warn(`[emails] Sin detalle para orden #${oid}`);
          continue;
        }

        const { order: ord, items } = detail;

        // Emails destino (trim/normalize)
        const customerEmail =
          (ord.customer_email && String(ord.customer_email).trim()) ||
          (ord.metadata?.billing?.email && String(ord.metadata.billing.email).trim()) ||
          (ord.metadata?.shipping?.email && String(ord.metadata.shipping.email).trim()) ||
          null;

        // tomamos el primer owner_email de los items de esa orden
        const ownerEmailRaw = (Array.isArray(items) && items.find(x => x.owner_email)?.owner_email) || null;
        const ownerEmail = ownerEmailRaw ? String(ownerEmailRaw).trim() : null;

        const subjectSuffix = `#${oid}`; // ayuda a evitar “dedup” por asunto igual


        console.log(`[emails] Orden #${oid}: cust=${customerEmail || '—'} owner=${ownerEmail || '—'}`);

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

        // Enviar SIEMPRE. Si ownerEmail es null, el helper lo envía a ADMIN_EMAILS (TO) y,
        // si existe ownerEmail, manda BCC a ADMIN_EMAILS evitando duplicados.
        tasks.push(
          sendOwnerOrderEmail(ownerEmail, { ...ord, _subjectSuffix: subjectSuffix, _emailRole: 'owner' }, items)
            .then(() => console.log(`[emails] OK owner-copy ${ownerEmail || '(admins)'} → orden #${oid}`))
            .catch(e => console.error(`[emails] FAIL owner-copy → orden #${oid}`, e))
        );

        await Promise.allSettled(tasks);
        await delay(1800); // pequeño respiro
      } catch (e) {
        console.error(`[emails] Error procesando orden #${oid}:`, e);
      }
    }

    // Respuesta
    return res.json({ ok: true, paid: true, orders: ids });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('payments confirm error', e);
    return res.json({ ok: false, paid: false, message: e.message || 'Error confirmando pago' });
  } finally {
    client.release();
  }
});

module.exports = router;
