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
    ci.variant_id,
    ci.quantity,
    ci.unit_price,

    /* metadata enriquecida (right wins en ||) */
    COALESCE(ci.metadata, '{}'::jsonb)
      || jsonb_build_object(
          'duty_cents',
          CASE
            WHEN NULLIF(ci.metadata->>'duty_cents','') IS NOT NULL
                  AND (ci.metadata->>'duty_cents')::int > 0
              THEN (ci.metadata->>'duty_cents')::int
            WHEN p.duty_cents IS NOT NULL AND p.duty_cents > 0
              THEN p.duty_cents::int
            WHEN jsonb_typeof(p.metadata->'duty_cents') = 'number'
                  AND (p.metadata->>'duty_cents')::int > 0
              THEN (p.metadata->>'duty_cents')::int
            ELSE 0
          END,

          'title_en',
          COALESCE(
            NULLIF(ci.metadata->>'title_en',''),
            NULLIF(p.title_en,''),
            CASE WHEN jsonb_typeof(p.metadata->'title_en') = 'string'
                  THEN NULLIF(p.metadata->>'title_en','') END
          ),

          'description_en',
          COALESCE(
            NULLIF(ci.metadata->>'description_en',''),
            NULLIF(p.description_en,''),
            CASE WHEN jsonb_typeof(p.metadata->'description_en') = 'string'
                  THEN NULLIF(p.metadata->>'description_en','') END
          ),

          -- overrides efectivos para UI
          'effective_image_url',
          COALESCE(NULLIF(ci.metadata->>'effective_image_url',''), v.image_url, p.image_url),

          'effective_weight',
          COALESCE(
            NULLIF(ci.metadata->>'effective_weight','')::numeric,
            v.weight,
            p.weight,
            0
          )
        ) AS metadata,

    p.title                       AS title,
    COALESCE(v.image_url, p.image_url) AS thumbnail,   -- preferir imagen de variante
    COALESCE(
      NULLIF(ci.metadata->>'title_en',''),
      NULLIF(p.title_en,''),
      CASE WHEN jsonb_typeof(p.metadata->'title_en') = 'string'
          THEN NULLIF(p.metadata->>'title_en','') END
    ) AS title_en,
    COALESCE(
      NULLIF(ci.metadata->>'description_en',''),
      NULLIF(p.description_en,''),
      CASE WHEN jsonb_typeof(p.metadata->'description_en') = 'string'
          THEN NULLIF(p.metadata->>'description_en','') END
    ) AS description_en,

    COALESCE(v.weight, p.weight, 0)::float  AS weight,
    p.owner_id                    AS owner_id,
    o.name                        AS owner_name,

    -- stock disponible a nivel correcto
    COALESCE(v.stock_qty, p.stock_qty, 0)::int AS available_stock

  FROM cart_items ci
  LEFT JOIN products p ON p.id = ci.product_id
  LEFT JOIN product_variants v ON v.id = ci.variant_id
  LEFT JOIN owners   o ON o.id = p.owner_id
  WHERE ci.cart_id = $1
  ORDER BY ci.id ASC
;`,
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
  const customerId = req.user.id;
  const { product_id, variant_id, quantity } = req.body;

  if (!product_id || !Number.isInteger(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'product_id y quantity válidos son requeridos' });
  }

  try {
    // 1) Asegurar/crear carrito abierto
    let cart = await pool.query(
      'SELECT * FROM carts WHERE customer_id = $1 AND completed = false LIMIT 1',
      [customerId]
    );
    if (!cart.rows.length) {
      cart = await pool.query('INSERT INTO carts (customer_id) VALUES ($1) RETURNING *', [customerId]);
    }
    const cartId = cart.rows[0].id;

    // 2) Cargar producto base
    const prodRes = await pool.query(
      `SELECT id, title, title_en, description_en, price, duty_cents, metadata, COALESCE(stock_qty,0)::int AS stock_qty,
              weight, image_url
         FROM products WHERE id = $1`,
      [product_id]
    );
    if (!prodRes.rows.length) return res.status(404).json({ error: 'Producto no encontrado' });
    const prod = prodRes.rows[0];
    const m = prod.metadata || {};
    if (m.archived === true) return res.status(409).json({ error: 'Producto archivado, no disponible' });

    // 3) Si viene variant_id, cargar variante y validar product_id
    let variant = null;
    if (variant_id != null) {
      const vRes = await pool.query(
        `SELECT id, product_id, stock_qty, archived, price_cents, weight, image_url
           FROM product_variants
          WHERE id = $1
          LIMIT 1`,
        [variant_id]
      );
      if (!vRes.rows.length) return res.status(404).json({ error: 'Variante no encontrada' });
      variant = vRes.rows[0];
      if (Number(variant.product_id) !== Number(product_id)) {
        return res.status(400).json({ error: 'variant_id no corresponde al product_id' });
      }
      if (variant.archived === true) {
        return res.status(409).json({ error: 'Variante archivada, no disponible' });
      }
    }

    // 4) Stock disponible (si hay variante, valida variante; si no, producto)
    const stockAvailable = variant ? Number(variant.stock_qty) : Number(prod.stock_qty);
    // qty acumulada si ya existe
    const existing = await pool.query(
      'SELECT id, quantity FROM cart_items WHERE cart_id = $1 AND product_id = $2 AND COALESCE(variant_id,0) = COALESCE($3,0)',
      [cartId, product_id, variant ? variant.id : null]
    );
    const currentQty = existing.rows.length ? Number(existing.rows[0].quantity) : 0;
    const requestedTotal = currentQty + Number(quantity);

    if (stockAvailable <= 0) {
      return res.status(409).json({
        ok: false,
        reason: 'insufficient_stock',
        product_id,
        title: prod.title,
        requested: requestedTotal,
        available: 0,
        message: 'Sin stock'
      });
    }
    if (requestedTotal > stockAvailable) {
      const availableToAdd = Math.max(stockAvailable - currentQty, 0);
      return res.status(409).json({
        ok: false,
        reason: 'insufficient_stock',
        product_id,
        title: prod.title,
        requested: requestedTotal,
        available: availableToAdd,
        message: 'Cantidad solicitada supera el stock disponible'
      });
    }

    // 5) Pipeline de precio (hereda de producto; override base_cents por variante si trae price_cents)
    const taxable = m.taxable !== false;
    const tax_pct = Number.isFinite(m.tax_pct) ? Math.max(0, Math.min(30, Number(m.tax_pct))) : 0;
    const margin_pct = Number.isFinite(m.margin_pct) ? Math.max(0, Number(m.margin_pct)) : 0;

    const base_cents_product = Number.isInteger(m.price_cents) && m.price_cents >= 0
      ? m.price_cents
      : Math.round(Number(prod.price) * 100);

    const base_cents = (variant && Number.isInteger(variant.price_cents))
      ? Number(variant.price_cents)
      : base_cents_product;

    let duty_cents = 0;
    if (Number.isFinite(prod.duty_cents)) duty_cents = Math.max(0, Number(prod.duty_cents));
    else if (Number.isInteger(m.duty_cents)) duty_cents = Math.max(0, Number(m.duty_cents));
    else if (typeof m.duty_cents === 'string' && m.duty_cents.trim() !== '') {
      const parsed = parseInt(m.duty_cents, 10);
      duty_cents = Number.isInteger(parsed) ? Math.max(0, parsed) : 0;
    }

    const base_plus_duty_cents = base_cents + duty_cents;
    const price_with_margin_cents = Math.round(base_plus_duty_cents * (100 + margin_pct) / 100);
    const tax_cents = taxable ? Math.round(price_with_margin_cents * tax_pct / 100) : 0;
    const unit_price_usd = (price_with_margin_cents / 100).toFixed(2);

    // 6) UI texts heredados como antes
    const title_en =
      typeof prod.title_en === 'string' && prod.title_en.trim()
        ? prod.title_en.trim()
        : (typeof m.title_en === 'string' && m.title_en.trim() ? m.title_en.trim() : undefined);

    const description_en =
      typeof prod.description_en === 'string' && prod.description_en.trim()
        ? prod.description_en.trim()
        : (typeof m.description_en === 'string' && m.description_en.trim() ? m.description_en.trim() : undefined);

    const itemMetaBase = {
      price_source: (variant && Number.isInteger(variant.price_cents)) ? 'variant.price_cents' :
        (Number.isInteger(m.price_cents) ? 'product.metadata.price_cents' : 'product.price'),
      base_cents,
      duty_cents,
      margin_pct,
      taxable,
      tax_pct,
      price_with_margin_cents,
      tax_cents,
      computed_at: new Date().toISOString(),
      // para front: imagen/peso efectivos de la variante si aplica
      effective_image_url: variant?.image_url ?? prod.image_url ?? null,
      effective_weight: (variant?.weight != null ? Number(variant.weight) : Number(prod.weight) || 0)
    };
    const itemMeta = {
      ...itemMetaBase,
      ...(title_en ? { title_en } : {}),
      ...(description_en ? { description_en } : {}),
    };

    // 7) UPSERT del item (distingue por variant_id)
    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE cart_items
            SET quantity = quantity + $1,
                unit_price = $2,
                variant_id = $3,
                metadata = COALESCE(metadata,'{}'::jsonb) || $4::jsonb
          WHERE id = $5`,
        [quantity, unit_price_usd, (variant ? variant.id : null), JSON.stringify(itemMeta), existing.rows[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO cart_items (cart_id, product_id, variant_id, quantity, unit_price, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [cartId, product_id, (variant ? variant.id : null), quantity, unit_price_usd, JSON.stringify(itemMeta)]
      );
    }

    return res.json({
      ok: true,
      cart_id: cartId,
      product_id,
      variant_id: variant ? variant.id : null,
      quantity_added: quantity,
      unit_price: Number(unit_price_usd),
      tax_cents
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Error al agregar al carrito' });
  }
});


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
      SELECT
  ci.product_id,
  ci.variant_id,
  ci.quantity as requested,
  p.title,
  COALESCE(v.stock_qty, p.stock_qty) AS stock_qty,
  o.name as owner_name
FROM cart_items ci
JOIN products p ON p.id = ci.product_id
LEFT JOIN product_variants v ON v.id = ci.variant_id
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
