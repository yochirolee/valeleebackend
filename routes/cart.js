const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const authenticateToken = require('../middleware/authenticateToken');

/* Crear carrito */
router.post('/cart', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user.id;
    const existing = await pool.query(
      'SELECT * FROM carts WHERE customer_id = $1 AND completed = false LIMIT 1',
      [customerId]
    );
    if (existing.rows.length) return res.status(200).json(existing.rows[0]);

    const result = await pool.query(
      'INSERT INTO carts (customer_id) VALUES ($1) RETURNING *',
      [customerId]
    );
    res.status(201).json(result.rows[0]);
  } catch {
    res.status(500).send('Error al crear el carrito');
  }
});


/* Agregar item a un carrito específico */
router.get('/cart/:id/items', authenticateToken, async (req, res) => {
  try {
    const cartId = Number(req.params.id);
    const customerId = req.user.id;

    const own = await pool.query(
      'SELECT 1 FROM carts WHERE id = $1 AND customer_id = $2',
      [cartId, customerId]
    );
    if (!own.rows.length) return res.sendStatus(404);

    const result = await pool.query(
      `SELECT * FROM cart_items WHERE cart_id = $1 ORDER BY id ASC`,
      [cartId]
    );
    res.json(result.rows);
  } catch {
    res.status(500).send('Error al obtener los items del carrito');
  }
});


/* Listar items de un carrito */
router.get('/cart/:id/items', async (req, res) => {
  try {
    const cartId = req.params.id;
    const result = await pool.query(
      `SELECT * FROM cart_items WHERE cart_id = $1`,
      [cartId]
    );
    res.json(result.rows);
  } catch {
    res.status(500).send('Error al obtener los items del carrito');
  }
});

/* Eliminar ítem específico del carrito */
router.delete('/cart/:cartId/items/:itemId', authenticateToken, async (req, res) => {
  try {
    const { cartId, itemId } = req.params;
    const customerId = req.user.id;

    const own = await pool.query(
      'SELECT 1 FROM carts WHERE id = $1 AND customer_id = $2',
      [cartId, customerId]
    );
    if (!own.rows.length) return res.sendStatus(404);

    const del = await pool.query(
      `DELETE FROM cart_items WHERE id = $1 AND cart_id = $2`,
      [itemId, cartId]
    );
    if (del.rowCount === 0) return res.sendStatus(404);

    res.sendStatus(204);
  } catch {
    res.status(500).send('Error al eliminar el item del carrito');
  }
});


/* Obtener carrito activo + items del usuario autenticado */
router.get('/cart', authenticateToken, async (req, res) => {
  const customerId = req.user.id;
  try {
    const cartRes = await pool.query(
      'SELECT * FROM carts WHERE customer_id = $1 AND completed = false LIMIT 1',
      [customerId]
    );
    if (!cartRes.rows.length) return res.json({ cart: null, items: [] });
    const cart = cartRes.rows[0];
    const itemsRes = await pool.query(
      `SELECT
        ci.id,
        ci.product_id,
        ci.quantity,
        ci.unit_price,
        ci.metadata,
        p.title                       AS title,
        p.image_url                   AS thumbnail,
        COALESCE(p.weight, 0)::float  AS weight,
        p.owner_id                    AS owner_id,
        o.name                        AS owner_name,
        COALESCE(p.stock_qty, 0)::int AS available_stock
      FROM cart_items ci
      LEFT JOIN products p ON p.id = ci.product_id
      LEFT JOIN owners   o ON o.id = p.owner_id
      WHERE ci.cart_id = $1
      ORDER BY ci.id ASC;`,
      [cart.id]
    );
    res.json({ cart, items: itemsRes.rows });
  } catch (error) {
    console.error(error);
    res.status(500).send('Error al obtener el carrito');
  }
});

/* Agregar/actualizar ítem en carrito (autenticado; server calcula precio) */
router.post('/cart/add', authenticateToken, async (req, res) => {
  const customerId = req.user.id
  const { product_id, quantity } = req.body

  if (!product_id || !Number.isInteger(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'product_id y quantity válidos son requeridos' })
  }

  try {
    let cart = await pool.query(
      'SELECT * FROM carts WHERE customer_id = $1 AND completed = false LIMIT 1',
      [customerId]
    )
    if (!cart.rows.length) {
      cart = await pool.query('INSERT INTO carts (customer_id) VALUES ($1) RETURNING *', [customerId])
    }
    const cartId = cart.rows[0].id

    const prodRes = await pool.query(
      'SELECT id, title, price, metadata, COALESCE(stock_qty,0)::int AS stock_qty FROM products WHERE id = $1',
      [product_id]
    )
    if (!prodRes.rows.length) return res.status(404).json({ error: 'Producto no encontrado' })
    const prod = prodRes.rows[0]
    const m = prod.metadata || {}

    if (m.archived === true) {
      return res.status(409).json({ error: 'Producto archivado, no disponible' })
    }

    const existing = await pool.query(
      'SELECT id, quantity FROM cart_items WHERE cart_id = $1 AND product_id = $2',
      [cartId, product_id]
    )
    const currentQty = existing.rows.length ? Number(existing.rows[0].quantity) : 0
    const requestedTotal = currentQty + Number(quantity)

    const stock = Number(prod.stock_qty) || 0
    if (stock <= 0) {
      return res.status(409).json({
        ok: false,
        reason: 'insufficient_stock',
        product_id,
        title: prod.title,
        requested: requestedTotal,
        available: 0,
        message: 'Sin stock'
      })
    }
    if (requestedTotal > stock) {
      const availableToAdd = Math.max(stock - currentQty, 0)
      return res.status(409).json({
        ok: false,
        reason: 'insufficient_stock',
        product_id,
        title: prod.title,
        requested: requestedTotal,
        available: availableToAdd,
        message: 'Cantidad solicitada supera el stock disponible'
      })
    }

    const taxable = m.taxable !== false
    const tax_pct = Number.isFinite(m.tax_pct) ? Math.max(0, Math.min(30, Number(m.tax_pct))) : 0
    const margin_pct = Number.isFinite(m.margin_pct) ? Math.max(0, Number(m.margin_pct)) : 0

    const base_cents = Number.isInteger(m.price_cents) && m.price_cents >= 0
      ? m.price_cents
      : Math.round(Number(prod.price) * 100)

    const price_with_margin_cents = Math.round(base_cents * (100 + margin_pct) / 100)
    const tax_cents = taxable ? Math.round(price_with_margin_cents * tax_pct / 100) : 0

    const unit_price_usd = (price_with_margin_cents / 100).toFixed(2)

    const itemMeta = {
      price_source: (Number.isInteger(m.price_cents) ? 'price_cents' : 'price'),
      base_cents,
      margin_pct,
      taxable,
      tax_pct,
      price_with_margin_cents,
      tax_cents,
      computed_at: new Date().toISOString(),
    }

    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE cart_items
           SET quantity = quantity + $1,
               unit_price = $2,
               metadata = COALESCE(metadata,'{}'::jsonb) || $3::jsonb
         WHERE cart_id = $4 AND product_id = $5`,
        [quantity, unit_price_usd, JSON.stringify(itemMeta), cartId, product_id]
      )
    } else {
      await pool.query(
        `INSERT INTO cart_items (cart_id, product_id, quantity, unit_price, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [cartId, product_id, quantity, unit_price_usd, JSON.stringify(itemMeta)]
      )
    }

    return res.json({
      ok: true,
      cart_id: cartId,
      product_id,
      quantity_added: quantity,
      unit_price: Number(unit_price_usd),
      tax_cents
    })
  } catch (error) {
    console.error(error)
    return res.status(500).json({ error: 'Error al agregar al carrito' })
  }
})

/* Quitar/disminuir item (idempotente) */
router.delete('/cart/remove/:itemId', authenticateToken, async (req, res) => {
  const itemId = Number(req.params.itemId)
  const customerId = req.user.id

  try {
    const cart = await pool.query(
      'SELECT id FROM carts WHERE customer_id = $1 AND completed = false LIMIT 1',
      [customerId]
    )

    if (cart.rows.length === 0) {
      return res.sendStatus(204)
    }

    const cartId = cart.rows[0].id

    const itemRes = await pool.query(
      'SELECT quantity FROM cart_items WHERE id = $1 AND cart_id = $2',
      [itemId, cartId]
    )

    if (itemRes.rows.length === 0) {
      return res.sendStatus(204)
    }

    const quantity = itemRes.rows[0].quantity
    if (quantity > 1) {
      await pool.query('UPDATE cart_items SET quantity = quantity - 1 WHERE id = $1', [itemId])
    } else {
      await pool.query('DELETE FROM cart_items WHERE id = $1', [itemId])
    }

    return res.sendStatus(204)
  } catch (error) {
    console.error(error)
    return res.status(500).send('Error al eliminar del carrito')
  }
})

/* Validar carrito por stock */
router.post('/cart/validate', authenticateToken, async (req, res) => {
  const customerId = req.user.id;
  const cartId = Number(req.body.cartId);

  try {
    const own = await pool.query(
      'SELECT 1 FROM carts WHERE id = $1 AND customer_id = $2 AND completed = false',
      [cartId, customerId]
    );
    if (!own.rows.length) {
      return res.status(404).json({ error: 'Carrito no encontrado' });
    }

    const items = await pool.query(`
      SELECT ci.product_id, ci.quantity as requested,
             p.title, p.stock_qty, o.name as owner_name
      FROM cart_items ci
      JOIN products p ON p.id = ci.product_id
      LEFT JOIN owners o ON o.id = p.owner_id
      WHERE ci.cart_id = $1
    `, [cartId]);

    const unavailable = [];
    for (const it of items.rows) {
      const available = Number(it.stock_qty);
      if (available < it.requested) {
        unavailable.push({
          product_id: it.product_id,
          title: it.title,
          owner_name: it.owner_name,
          requested: it.requested,
          available,
        });
      }
    }

    if (unavailable.length > 0) {
      return res.json({ ok: false, message: 'Hay productos sin disponibilidad.', unavailable });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('POST /cart/validate error', e);
    return res.status(500).json({ error: 'Error validando carrito' });
  }
});


module.exports = router
