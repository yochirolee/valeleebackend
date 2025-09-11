const express = require('express')
const router = express.Router()
const { pool } = require('../db')
const { fileTypeFromBuffer } = require('file-type')
const authenticateToken = require('../middleware/authenticateToken')
const { requireAdmin, isAdminUser, getUserRoleAndOwnerId, requirePartnerOrAdmin } = require('../middleware/roles')

const multer = require('multer')
const rateLimit = require('express-rate-limit')
const { uploadBufferToCloudinary } = require('../helpers/cloudinaryUpload')

const CARD_FEE_PCT_BACK = Number(process.env.CARD_FEE_PCT ?? '3');
const CARD_FEE_RATE = Number.isFinite(CARD_FEE_PCT_BACK) ? CARD_FEE_PCT_BACK / 100 : 0;

// Admin: listado general
router.get('/orders', authenticateToken, requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, c.email, c.first_name, c.last_name
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       ORDER BY o.created_at DESC`
    )
    res.json(result.rows)
  } catch {
    res.status(500).send('Error al obtener órdenes')
  }
})

// Obtener orden (dueño o admin)
router.get('/orders/:id', authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const { rows } = await pool.query(
      `SELECT 
         o.*,
         ow.id   AS owner_id_join,
         ow.name AS owner_name,
         ow.phone AS owner_phone,
         ow.email AS owner_email
       FROM orders o
       LEFT JOIN owners ow ON ow.id = o.owner_id
       WHERE o.id = $1
       LIMIT 1`,
      [id]
    )
    if (!rows.length) return res.status(404).send('Orden no encontrada')
    const row = rows[0]

    const isOwner = Number(row.customer_id) === Number(req.user.id)
    const isAdmin = await isAdminUser(req.user.id)
    if (!isOwner && !isAdmin) return res.sendStatus(403)

    const order = {
      ...row,
      owner: row.owner_id_join ? {
        id: row.owner_id_join,
        name: row.owner_name || null,
        phone: row.owner_phone || null,
        whatsapp: row.owner_phone || null,
        email: row.owner_email || null,
      } : null
    }

    return res.json(order)
  } catch (e) {
    console.error(e)
    return res.status(500).send('Error al obtener orden')
  }
})

// Crear orden (admin)
router.post('/orders', authenticateToken, requireAdmin, async (req, res) => {
  const { customer_id, customer_name, total, status, payment_method, metadata } = req.body
  try {
    const result = await pool.query(
      'INSERT INTO orders (customer_id, customer_name, total, status, payment_method, metadata) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [customer_id, customer_name, total, status, payment_method, metadata || {}]
    )
    res.status(201).json(result.rows[0])
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al crear la orden')
  }
})

// Actualizar orden (admin)
router.put('/orders/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { customer_name, total, status, metadata } = req.body
  try {
    const next = status ? String(status) : null
    const nowISO = new Date().toISOString()
    const timeKey = next === 'delivered' ? 'delivered_at' : next === 'shipped' ? 'shipped_at' : null

    const result = await pool.query(
      `
      UPDATE orders
         SET customer_name = COALESCE($1, customer_name),
             total         = COALESCE($2, total),
             status        = COALESCE($3, status),
             -- si pasa a delivered, pobla la columna delivered_at; si pasa a shipped no tocar delivered_at
             delivered_at  = CASE 
                               WHEN $3 = 'delivered' THEN COALESCE(delivered_at, $5::timestamptz)
                               ELSE delivered_at
                             END,
             metadata      = (
               COALESCE(metadata,'{}'::jsonb)
               || COALESCE($4::jsonb,'{}'::jsonb)
               || CASE 
                    WHEN $3 IN ('shipped','delivered') THEN
                      jsonb_build_object(
                        'status_times',
                        COALESCE(metadata->'status_times','{}'::jsonb)
                          || jsonb_build_object($6::text, $5::text)
                      )
                    ELSE '{}'::jsonb
                  END
               || CASE 
                    WHEN $3 = 'delivered' THEN
                      jsonb_build_object(
                        'delivery',
                        COALESCE(metadata->'delivery','{}'::jsonb)
                          || jsonb_build_object('delivered', true, 'delivered_at', $5::text)
                      )
                    ELSE '{}'::jsonb
                  END
             )
       WHERE id = $7
       RETURNING *`,
      [
        customer_name ?? null,
        total ?? null,
        next,
        metadata ? JSON.stringify(metadata) : null,
        nowISO,            // $5
        timeKey,           // $6
        req.params.id      // $7
      ]
    )
    if (!result.rows.length) return res.status(404).send('Orden no encontrada')
    res.json(result.rows[0])
  } catch (e) {
    console.error(e)
    res.status(500).send('Error al actualizar orden')
  }
})


// Eliminar orden (admin)
router.delete('/orders/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM orders WHERE id = $1 RETURNING id', [req.params.id])
    if (!result.rows.length) return res.status(404).send('Orden no encontrada')
    res.json({ message: 'Orden eliminada' })
  } catch {
    res.status(500).send('Error al eliminar orden')
  }
})

const sessionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 90,
  standardHeaders: true,
  legacyHeaders: false,
})
function isSafeId(s) {
  // Acepta UUID/ULID/cuid/shortid/número/Base64URL-like sin espacios
  return /^[A-Za-z0-9._:-]{3,200}$/.test(s)
}

router.get('/checkout-sessions/:id', sessionLimiter, async (req, res) => {
  const raw = String(req.params.id ?? '')
  const id = decodeURIComponent(raw).trim()

  // Longitud dura para evitar payloads gigantes
  if (id.length < 3 || id.length > 200) {
    // 404 para no revelar reglas de validación
    return res.status(404).json({ ok: false, message: 'Sesión no encontrada' })
  }
  if (!isSafeId(id)) {
    return res.status(404).json({ ok: false, message: 'Sesión no encontrada' })
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, status, created_order_ids, snapshot, metadata, payment, processed_at
         FROM checkout_sessions
        WHERE id = $1
        LIMIT 1`,
      [id]
    )
    if (!rows.length) {
      return res.status(404).json({ ok: false, message: 'Sesión no encontrada' })
    }

    const s = rows[0] || {}
    const kind = s?.snapshot?.kind
    const flow = s?.metadata?.flow

    const payment = s?.payment || {}
    const safePayment = {
      provider: typeof payment.provider === 'string' ? payment.provider : undefined,
      mode: typeof payment.mode === 'string' ? payment.mode : undefined,
      link_id: payment.link_id ?? undefined, // nunca expongas payment.link
    }

    const status = String(s.status || '').toLowerCase()
    if (status === 'paid') safePayment.link_id = undefined

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')

    return res.json({
      ok: true,
      session: {
        id: s.id,
        status,
        created_order_ids: Array.isArray(s.created_order_ids) ? s.created_order_ids : [],
        snapshot: typeof kind === 'string' ? { kind } : undefined,
        metadata: typeof flow === 'string' ? { flow } : undefined,
        payment: safePayment,
        processed_at: s.processed_at ?? null,
      },
    })
  } catch (e) {
    console.error('GET /checkout-sessions/:id', e?.message || e)
    return res.status(500).json({ ok: false, message: 'Error leyendo sesión' })
  }
})



// Detalle (dueño o admin) con items
router.get('/orders/:id/detail', authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows: head } = await pool.query(
      `SELECT 
          o.*,
          c.email, c.first_name, c.last_name,
          ow.id   AS owner_id_join,
          ow.name AS owner_name,
          ow.phone AS owner_phone,
          ow.email AS owner_email
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN owners   ow ON ow.id = o.owner_id
        WHERE o.id = $1
        LIMIT 1`,
      [id]
    );
    if (!head.length) return res.status(404).send('Orden no encontrada');

    const order = head[0];
    const isOwner = Number(order.customer_id) === Number(req.user.id);
    const isAdmin = await isAdminUser(req.user.id);
    if (!isOwner && !isAdmin) return res.sendStatus(403);

    // ⬇️ Cambio: COALESCE a metadata para cubrir items de Encargos (sin product_id)
    const { rows: items } = await pool.query(
      `SELECT
         li.product_id,
         COALESCE(p.title,       li.metadata->>'title')      AS product_name,
         COALESCE(p.image_url,   li.metadata->>'image_url')  AS image_url,
         li.metadata->>'source_url'                          AS source_url,
         li.quantity,
         li.unit_price
       FROM line_items li
       LEFT JOIN products p ON p.id = li.product_id
      WHERE li.order_id = $1
      ORDER BY li.id ASC`,
      [id]
    );

    return res.json({
      order: {
        id: order.id,
        created_at: order.created_at,
        status: order.status,
        payment_method: order.payment_method,
        metadata: order.metadata || {},
        owner: order.owner_id_join ? {
          id: order.owner_id_join,
          name: order.owner_name || null,
          phone: order.owner_phone || null,
          whatsapp: order.owner_phone || null,
          email: order.owner_email || null,
        } : null,
      },
      items: items.map(it => ({
        product_id: it.product_id,
        product_name: it.product_name || undefined,
        image_url: it.image_url || null,
        source_url: it.source_url || null, // opcional para UI
        quantity: Number(it.quantity),
        unit_price: Number(it.unit_price),
      })),
    });
  } catch (e) {
    console.error('GET /orders/:id/detail error', e);
    return res.status(500).send('Error al obtener detalle de orden');
  }
});

// ADMIN ORDERS: listado con cálculos 
router.get('/admin/orders', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const {
      page = '1',
      limit = '20',
      sort_by = 'created_at',
      sort_dir = 'desc',
      q = '',
      status,
      payment_method,
      from,
      to
    } = req.query;

    const p = Math.max(1, Number(page) || 1);
    const l = Math.min(100, Math.max(1, Number(limit) || 20));
    const off = (p - 1) * l;

    const allowedSort = {
      created_at: 'created_at',
      id: 'id',
      status: 'status',
      total: 'total_col',      // columna real en agg
      total_calc: 'subtotal_calc',
    };
    const sortCol = allowedSort[String(sort_by)] || 'created_at';
    const dir = String(sort_dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const where = [];
    const vals = [];

    if (status) { vals.push(String(status)); where.push(`o.status = $${vals.length}`); }
    if (payment_method) { vals.push(String(payment_method)); where.push(`o.payment_method = $${vals.length}`); }
    const isDateOnly = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

    if (from) {
      const s = String(from);
      if (isDateOnly(s)) { vals.push(s); where.push(`o.created_at >= $${vals.length}::date`); }
      else {
        const d = new Date(s);
        if (!isNaN(d.getTime())) { vals.push(d); where.push(`o.created_at >= $${vals.length}`); }
      }
    }

    if (to) {
      const s = String(to);
      if (isDateOnly(s)) {
        vals.push(s);
        where.push(`o.created_at < ($${vals.length}::date + INTERVAL '1 day')`);
      } else {
        const d = new Date(s);
        if (!isNaN(d.getTime())) { vals.push(d); where.push(`o.created_at <= $${vals.length}`); }
      }
    }

    if (q) {
      const like = `%${q}%`;
      const isNum = Number.isFinite(Number(q));
      if (isNum) {
        vals.push(like, like, Number(q));
        const i1 = vals.length - 2, i2 = vals.length - 1, i3 = vals.length;
        where.push(`(c.email ILIKE $${i1} OR (COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) ILIKE $${i2} OR o.id = $${i3})`);
      } else {
        vals.push(like, like);
        const i1 = vals.length - 1, i2 = vals.length;
        where.push(`(c.email ILIKE $${i1} OR (COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) ILIKE $${i2})`);
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const sql = `
      WITH agg AS (
        SELECT
          o.id,
          o.created_at,
          o.status,
          o.payment_method,
          o.total::numeric AS total_col,
          o.metadata,
          o.customer_id,
          o.owner_paid,          
          c.email,
          c.first_name,
          c.last_name,
          COALESCE(SUM(li.quantity * li.unit_price), 0)::numeric AS subtotal_calc,
          COUNT(li.id)::int AS items_count,
          NULLIF((o.metadata->'pricing'->>'subtotal')::numeric, NULL) AS snap_subtotal,
          NULLIF((o.metadata->'pricing'->>'tax')::numeric, NULL)       AS snap_tax,
          NULLIF((o.metadata->'pricing'->>'shipping')::numeric, NULL)  AS snap_shipping,
          NULLIF((o.metadata->'pricing'->>'total')::numeric, NULL)     AS snap_total
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN line_items li ON li.order_id = o.id
        ${whereSql}
        GROUP BY o.id, c.email, c.first_name, c.last_name
      )
      SELECT *,
             COUNT(*) OVER() AS total_rows
      FROM agg
      ORDER BY ${sortCol} ${dir}
      LIMIT ${l} OFFSET ${off};
    `;

    const { rows } = await pool.query(sql, vals);
    const total = rows[0]?.total_rows ? Number(rows[0].total_rows) : 0;

    // ====== CAMBIO: normalizar por metadata para no duplicar fee ======
    const items = rows.map((r) => normalizeListRow(r));

    res.json({
      items,
      page: p,
      pages: Math.max(1, Math.ceil(total / l)),
      total,
      limit: l,
      fee_pct: CARD_FEE_PCT_BACK,
    });
  } catch (e) {
    console.error('GET /admin/orders error:', e);
    res.status(500).send('Error al listar órdenes (admin)');
  }
});

// ---- Helpers locales para /admin/orders ----
function round2(x) { return Math.round(Number(x) * 100) / 100; }
function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }
function num(x, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }

function parseMd(mdRaw) {
  if (!mdRaw) return null;
  if (typeof mdRaw === 'string') {
    try { return JSON.parse(mdRaw); } catch { return null; }
  }
  if (typeof mdRaw === 'object') return mdRaw;
  return null;
}

function normalizeListRow(r) {
  const md = parseMd(r.metadata);
  const pc = md?.pricing_cents;   // fuente de verdad si existe (centavos)
  const snap = md?.pricing;        // snapshot en USD

  const pctEnv = Number.isFinite(CARD_FEE_PCT_BACK) ? CARD_FEE_PCT_BACK : 3;
  const feeRate = pctEnv / 100;

  let subtotal = 0, tax = 0, shipping = 0, base_total = 0, card_fee = 0, total_with_fee = 0;

  if (pc) {
    // === Caso 1: centavos (mejor fuente) ===
    subtotal = num(pc.subtotal_cents, 0) / 100;
    tax = num(pc.tax_cents, 0) / 100;
    shipping = num(pc.shipping_total_cents, 0) / 100;

    base_total = round2(subtotal + tax + shipping);

    if (pc.total_with_card_cents != null) {
      total_with_fee = round2(num(pc.total_with_card_cents) / 100);
      card_fee = round2(total_with_fee - base_total);
    } else {
      card_fee = round2(num(pc.card_fee_cents, 0) / 100);
      total_with_fee = round2(base_total + card_fee);
    }
  } else if (typeof snap?.total === 'number') {
    // === Caso 2: snapshot trae total (subtotal+tax+shipping) ===
    subtotal = round2(num(snap.subtotal));
    tax = round2(num(snap.tax));
    shipping = round2(num(snap.shipping));
    base_total = round2(num(snap.total));

    // Si no tienes card_fee en snapshot, calcúlalo con ENV
    card_fee = Number.isFinite(Number(snap.card_fee))
      ? round2(Number(snap.card_fee))
      : round2(base_total * feeRate);

    total_with_fee = round2(base_total + card_fee);
  } else {
    // === Caso 3: fallback (reconstruir) ===
    subtotal = round2(num(r.snap_subtotal ?? r.subtotal_calc));
    tax = round2(num(r.snap_tax));
    // Si tienes snap_shipping úsalo; si no, 0
    shipping = round2(num(r.snap_shipping, 0));

    // Si existe snap_total úsalo como base_total, si no suma componentes
    base_total = Number.isFinite(Number(r.snap_total))
      ? round2(num(r.snap_total))
      : round2(subtotal + tax + shipping);

    card_fee = round2(base_total * feeRate);
    total_with_fee = round2(base_total + card_fee);
  }

  return {
    id: r.id,
    created_at: r.created_at,
    status: r.status,
    payment_method: r.payment_method,
    customer_id: r.customer_id,
    email: r.email,
    first_name: r.first_name,
    last_name: r.last_name,
    owner_paid: r.owner_paid === true,
    items_count: Number(r.items_count || 0),
    subtotal,
    tax,
    base_total,
    card_fee,
    total_with_fee,
  };
}

// --- Helpers locales de autorización (en este MISMO archivo) ---
async function assertOrderOwnerOrAdmin(orderId, userId) {
  const isAdmin = await isAdminUser(userId)
  if (isAdmin) return { ok: true, isAdmin: true }

  const { rows } = await pool.query(
    'SELECT customer_id FROM orders WHERE id=$1 LIMIT 1',
    [orderId]
  )
  if (!rows.length) return { ok: false, notFound: true }
  const isOwner = Number(rows[0].customer_id) === Number(userId)
  return { ok: isOwner, isAdmin: false }
}

// Útil cuando solo tienes el id del line item
async function assertLineItemOwnerOrAdmin(lineItemId, userId) {
  const isAdmin = await isAdminUser(userId)
  if (isAdmin) return { ok: true, isAdmin: true }

  const { rows } = await pool.query(
    `SELECT o.customer_id
       FROM line_items li
       JOIN orders o ON o.id = li.order_id
      WHERE li.id = $1
      LIMIT 1`,
    [lineItemId]
  )
  if (!rows.length) return { ok: false, notFound: true }
  const isOwner = Number(rows[0].customer_id) === Number(userId)
  return { ok: isOwner, isAdmin: false }
}

// Detalle admin
router.get('/admin/orders/:id/detail', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const headQ = `
      SELECT 
        o.id, o.created_at, o.status, o.payment_method, o.total, o.metadata,
        o.customer_id, c.email, c.first_name, c.last_name, c.phone, c.address
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.id = $1
      LIMIT 1
    `;
    const { rows: headRows } = await pool.query(headQ, [id]);
    if (!headRows.length) return res.status(404).send('Orden no encontrada');

    const o = headRows[0];

    const { rows: itemRows } = await pool.query(`
            SELECT
              li.product_id,
              COALESCE(p.title,      li.metadata->>'title')     AS product_name,
              COALESCE(p.image_url,  li.metadata->>'image_url') AS image_url,
              li.metadata->>'source_url'                        AS source_url,
              li.metadata->>'external_id'                       AS external_id,
              li.quantity,
              li.unit_price
            FROM line_items li
            LEFT JOIN products p ON p.id = li.product_id
            WHERE li.order_id = $1
            ORDER BY li.id ASC
          `, [id]);

    const subtotalCalc = itemRows.reduce((acc, it) => acc + Number(it.quantity) * Number(it.unit_price), 0)
    const snapSubtotal = Number(o.metadata?.pricing?.subtotal ?? o.metadata?.payment?.subtotal)
    const snapTax = Number(o.metadata?.pricing?.tax ?? o.metadata?.payment?.tax)
    const snapTotal = Number(o.metadata?.pricing?.total)

    const subtotal = Number.isFinite(snapSubtotal) ? snapSubtotal : subtotalCalc
    const tax = Number.isFinite(snapTax) ? snapTax : 0

    // ====== CAMBIO: cálculo robusto usando metadata.pricing_cents / pricing ======
    const md = o.metadata || {};
    const pc = md?.pricing_cents;

    let base_total;
    let card_fee;
    let total_with_fee;

    if (pc) {
      const sub = Number((pc.subtotal_cents ?? 0) / 100);
      const tx = Number((pc.tax_cents ?? 0) / 100);
      const shp = Number((pc.shipping_total_cents ?? 0) / 100);
      const fee = Number((pc.card_fee_cents ?? 0) / 100);
      const twc = pc.total_with_card_cents != null ? Number(pc.total_with_card_cents) / 100 : null;

      base_total = Math.round((sub + tx + shp) * 100) / 100;
      card_fee = Math.round(fee * 100) / 100;
      total_with_fee = twc != null
        ? Math.round(twc * 100) / 100
        : Math.round((base_total + card_fee) * 100) / 100;
    } else {
      const snap = md?.pricing;
      if (typeof snap?.total === 'number' && typeof snap?.card_fee === 'number') {
        // En snapshot, total ya incluye fee
        const twc = Number(snap.total);
        const fee = Number(snap.card_fee);
        base_total = Math.round((twc - fee) * 100) / 100;
        card_fee = Math.round(fee * 100) / 100;
        total_with_fee = Math.round(twc * 100) / 100;
      } else {
        // Último recurso: subtotal + tax (+ shipping si lo tuvieras) y fee %
        base_total = Math.round((subtotal + tax) * 100) / 100;
        card_fee = Math.round(base_total * (CARD_FEE_RATE ?? 0.03) * 100) / 100;
        total_with_fee = Math.round((base_total + card_fee) * 100) / 100;
      }
    }

    res.json({
      order: {
        id: o.id,
        created_at: o.created_at,
        status: o.status,
        payment_method: o.payment_method,
        customer: {
          id: o.customer_id,
          email: o.email || null,
          name: [o.first_name, o.last_name].filter(Boolean).join(' ') || null,
          phone: o.phone || null,
          address: o.address || null,
        },
        // 'total' aquí es el total SIN fee (coherente con el frontend "correcto")
        pricing: { subtotal, tax, total: base_total },
        card_fee_pct: CARD_FEE_PCT_BACK,
        card_fee,
        total_with_fee,
        metadata: o.metadata || {},
      },
      items: itemRows.map(it => ({
        product_id: it.product_id,                        // puede ser null en encargos
        product_name: it.product_name || 'Encargo',
        image_url: it.image_url || null,
        source_url: it.source_url || null,
        external_id: it.external_id || null,
        quantity: Number(it.quantity),
        unit_price: Number(it.unit_price),
      })),
    });
  } catch (e) {
    console.error('GET /admin/orders/:id/detail', e);
    res.status(500).send('Error al obtener detalle de orden');
  }
});

// Cambiar estado admin (escribe timestamps)
router.patch('/admin/orders/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status requerido' });

  try {
    const next = String(status);

    // Cuando marcamos shipped o delivered, guardamos timestamps
    if (next === 'shipped' || next === 'delivered') {
      const nowISO = new Date().toISOString();
      const timeKey = next === 'shipped' ? 'shipped_at' : 'delivered_at';

      // ... arriba queda igual (nowISO, timeKey, etc.)

      const upd = await pool.query(
        `UPDATE orders
      SET status = $1,
          -- si pasa a delivered, pobla la columna con el MISMO instante:
          delivered_at = CASE WHEN $1 = 'delivered'
                              THEN COALESCE(delivered_at, $3::timestamptz)
                              ELSE delivered_at END,
          metadata = COALESCE(metadata,'{}'::jsonb)
                     || jsonb_build_object(
                          'status_times',
                          COALESCE(metadata->'status_times','{}'::jsonb)
                            || jsonb_build_object($2::text, $3::text)
                        )
                     || CASE WHEN $1 = 'delivered' THEN
                          jsonb_build_object(
                            'delivery',
                            COALESCE(metadata->'delivery','{}'::jsonb)
                              || jsonb_build_object('delivered', true, 'delivered_at', $3::text)
                          )
                        ELSE '{}'::jsonb END
    WHERE id = $4
RETURNING id, created_at, status, payment_method, total, metadata`,
        [next, timeKey, nowISO, id]
      )


      if (!upd.rows.length) return res.status(404).send('Orden no encontrada');

      const agg = await pool.query(
        `SELECT COUNT(*)::int AS items_count,
                COALESCE(SUM(quantity*unit_price),0) AS total_calc
           FROM line_items
          WHERE order_id = $1`,
        [id]
      );

      return res.json({ ...upd.rows[0], ...agg.rows[0] });
    }

    // Otros estados: update simple
    const upd = await pool.query(
      `UPDATE orders SET status = $1 WHERE id = $2
       RETURNING id, created_at, status, payment_method, total, metadata`,
      [next, id]
    );
    if (!upd.rows.length) return res.status(404).send('Orden no encontrada');

    const agg = await pool.query(
      `SELECT COUNT(*)::int AS items_count,
              COALESCE(SUM(quantity*unit_price),0) AS total_calc
         FROM line_items
        WHERE order_id = $1`,
      [id]
    );

    return res.json({ ...upd.rows[0], ...agg.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).send('Error al actualizar estado');
  }
});


// Partner/Delivery panel

const MAX_UPLOAD_MB = Number(process.env.DELIVERY_MAX_MB || 6)
const ALLOWED_MIME = /^(image\/(jpe?g|png|webp|heic|heif))$/i

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.test(file?.mimetype || '')) {
      const e = new Error('invalid_type'); e.code = 'LIMIT_FILE_TYPE'
      return cb(e)
    }
    cb(null, true)
  },
})

const partnerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
})

// Helper para capturar errores de multer y responder bonito
function handleUpload(field) {
  return (req, res, next) => {
    upload.single(field)(req, res, async (err) => {
      if (err) {
        if (err?.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ ok: false, message: `La imagen excede ${MAX_UPLOAD_MB} MB` })
        }
        if (err?.code === 'LIMIT_FILE_TYPE' || err?.message === 'invalid_type') {
          return res.status(400).json({ ok: false, message: 'Formato no permitido. Usa JPG, PNG, WEBP o HEIC.' })
        }
        console.error('[multer] Error:', err)
        return res.status(400).json({ ok: false, message: 'Error subiendo archivo' })
      }

      // ✅ Validación de “magic number” (firma real)
      if (req.file && req.file.buffer) {
        try {
          const ft = await fileTypeFromBuffer(req.file.buffer)
          if (!ft || !/^(image\/(jpeg|png|webp|heic|heif))$/i.test(ft.mime)) {
            return res.status(400).json({ ok: false, message: 'Archivo inválido (firma no coincide)' })
          }
        } catch (e) {
          return res.status(400).json({ ok: false, message: 'No se pudo validar el archivo' })
        }
      }

      return next()
    })
  }
}

router.get('/partner/orders', authenticateToken, requirePartnerOrAdmin, async (req, res) => {
  try {
    const { role, owner_id } = await getUserRoleAndOwnerId(req.user.id)
    const userId = req.user.id

    const { status = 'paid', scope = 'mine', page = '1', limit = '20' } = req.query
    const p = Math.max(1, Number(page) || 1)
    const l = Math.min(100, Math.max(1, Number(limit) || 20))
    const off = (p - 1) * l

    const vals = []
    const where = []

    const allowedStatus = new Set(['paid', 'shipped', 'delivered'])
    const st = allowedStatus.has(String(status)) ? String(status) : 'paid'
    vals.push(st); where.push(`o.status = $${vals.length}`)

    if (role === 'owner') {
      if (!owner_id) return res.status(403).json({ error: 'Owner no asignado' })
      vals.push(owner_id); where.push(`o.owner_id = $${vals.length}`)
    } else if (role === 'delivery') {
      if (scope === 'available') {
        where.push(`(o.metadata->>'delivery_assignee_id') IS NULL`)
      } else {
        vals.push(String(userId))
        where.push(`(o.metadata->>'delivery_assignee_id') = $${vals.length}`)
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const sql = `
      WITH agg AS (
        SELECT o.id, o.created_at, o.status, o.payment_method, o.total, o.metadata,
               o.customer_id, o.owner_id,
               c.email AS customer_email, c.first_name, c.last_name,
               COUNT(*) OVER() AS total_rows
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        ${whereSql}
        ORDER BY o.created_at DESC
        LIMIT ${l} OFFSET ${off}
      )
      SELECT * FROM agg;
    `
    const { rows } = await pool.query(sql, vals)
    const total = rows[0]?.total_rows ? Number(rows[0].total_rows) : 0

    const isDelivery = role === 'delivery'
    const isOwnerOrAdmin = role === 'owner' || role === 'admin'

    // Whitelist + filtrado por rol
    res.json({
      items: rows.map(({ total_rows, ...r }) => {
        const md = r.metadata || {}

        const safeMetadata = {
          delivery_assignee_id: md.delivery_assignee_id || undefined,
          delivery_assignee_name: md.delivery_assignee_name || undefined,
          // opcional: estados operativos mínimos
          status_times: md.status_times || undefined,
          delivery: md.delivery
            ? {
              delivered: md.delivery.delivered === true ? true : undefined,
              delivered_at: md.delivery.delivered_at || undefined,
            }
            : undefined,
        }

        return {
          id: r.id,
          created_at: r.created_at,
          status: r.status,
          total: typeof r.total === 'number' ? r.total : null, // la UI muestra "Total: ..."
          first_name: r.first_name || null,
          last_name: r.last_name || null,

          // ⚠️ Email solo para owner/admin. Para delivery => NO enviar.
          customer_email: isOwnerOrAdmin ? r.customer_email || r.email || null : undefined,

          // otros que ya usa tu UI para lógicas
          payment_method: r.payment_method,
          owner_id: r.owner_id,
          customer_id: r.customer_id,

          // metadata saneada
          metadata: safeMetadata,
        }
      }),
      page: p,
      pages: Math.max(1, Math.ceil(total / l)),
      total,
      limit: l,
    })
  } catch (e) {
    console.error('GET /partner/orders', e)
    res.status(500).json({ error: 'Error al listar órdenes' })
  }
})

router.patch('/partner/orders/:id/assign', authenticateToken, requirePartnerOrAdmin, async (req, res) => {
  const id = Number(req.params.id)
  const { action } = req.body || {}
  const userId = req.user.id

  const { role } = await getUserRoleAndOwnerId(userId)
  if (role !== 'delivery' && role !== 'admin') {
    return res.status(403).json({ error: 'Solo delivery o admin' })
  }

  const { rows } = await pool.query(`SELECT id, status, metadata FROM orders WHERE id = $1 LIMIT 1`, [id])
  if (!rows.length) return res.status(404).json({ error: 'Orden no encontrada' })
  const ord = rows[0]
  const md = ord.metadata || {}

  if (action === 'take') {
    if (md.delivery_assignee_id && Number(md.delivery_assignee_id) !== Number(userId)) {
      return res.status(409).json({ error: 'Orden ya asignada a otro repartidor' })
    }
    const me = await pool.query(`SELECT email, first_name, last_name FROM customers WHERE id = $1`, [userId])
    const name = [me.rows[0]?.first_name, me.rows[0]?.last_name].filter(Boolean).join(' ') || null
    const email = me.rows[0]?.email || null

    const upd = await pool.query(
      `UPDATE orders
          SET metadata = COALESCE(metadata,'{}'::jsonb)
                        || jsonb_build_object(
                             'delivery_assignee_id', $1::text,
                             'delivery_assignee_name', $2::text,
                             'delivery_assignee_email', $3::text
                           )
        WHERE id = $4
        RETURNING id, metadata`,
      [String(userId), name, email, id]
    )
    return res.json({ ok: true, id: upd.rows[0].id, metadata: upd.rows[0].metadata })
  }

  if (action === 'release') {
    if (!md.delivery_assignee_id) return res.json({ ok: true, id, metadata: md })
    if (role === 'delivery' && String(md.delivery_assignee_id) !== String(userId)) {
      return res.status(403).json({ error: 'No puedes liberar una orden que no es tuya' })
    }
    const upd = await pool.query(
      `UPDATE orders
          SET metadata = (COALESCE(metadata,'{}'::jsonb)
                           - 'delivery_assignee_id' - 'delivery_assignee_name' - 'delivery_assignee_email')
        WHERE id = $1
        RETURNING id, metadata`,
      [id]
    )
    return res.json({ ok: true, id: upd.rows[0].id, metadata: upd.rows[0].metadata })
  }

  return res.status(400).json({ error: 'Acción inválida' })
})

router.patch('/partner/orders/:id/status', authenticateToken, requirePartnerOrAdmin, async (req, res) => {
  const id = Number(req.params.id)
  const nextStatus = String(req.body?.status || '')
  const userId = req.user.id

  const { role, owner_id } = await getUserRoleAndOwnerId(userId)
  const allowed = new Set(['shipped', 'delivered'])
  if (!allowed.has(nextStatus)) return res.status(400).json({ error: 'Estado inválido' })

  const { rows } = await pool.query(`SELECT id, owner_id, status, metadata FROM orders WHERE id=$1 LIMIT 1`, [id])
  if (!rows.length) return res.status(404).json({ error: 'Orden no encontrada' })
  const ord = rows[0]
  const md = ord.metadata || {}
  const current = String(ord.status)

  if (role === 'owner') {
    if (!owner_id || Number(ord.owner_id) !== Number(owner_id)) return res.status(403).json({ error: 'No autorizado' })
    if (nextStatus === 'shipped' && current !== 'paid') return res.status(409).json({ error: 'Solo puedes marcar shipped si está paid' })
  } else if (role === 'delivery') {
    if (String(md.delivery_assignee_id || '') !== String(userId)) {
      return res.status(403).json({ error: 'Orden no asignada a ti' })
    }
    if (nextStatus === 'shipped' && current !== 'paid') return res.status(409).json({ error: 'Para marcar shipped debe estar en paid' })
    if (nextStatus === 'delivered' && current !== 'shipped') return res.status(409).json({ error: 'Para marcar delivered debe estar en shipped' })
  }

  const nowISO = new Date().toISOString()
  const timeKey = nextStatus === 'shipped' ? 'shipped_at' : 'delivered_at'

  const upd = await pool.query(
    `UPDATE orders
        SET status = $1,
            delivered_at = CASE WHEN $1 = 'delivered'
                                THEN COALESCE(delivered_at, $3::timestamptz)
                                ELSE delivered_at END,
            metadata = COALESCE(metadata,'{}'::jsonb)
                       || jsonb_build_object(
                            'status_times',
                            COALESCE(metadata->'status_times','{}'::jsonb)
                              || jsonb_build_object($2::text, $3::text)
                          )
                       || CASE WHEN $1 = 'delivered' THEN
                            jsonb_build_object(
                              'delivery',
                              COALESCE(metadata->'delivery','{}'::jsonb)
                                || jsonb_build_object('delivered', true, 'delivered_at', $3::text)
                            )
                          ELSE '{}'::jsonb END
      WHERE id = $4
      RETURNING id, status, metadata, created_at`,
    [nextStatus, timeKey, nowISO, id]
  )


  return res.json({ ok: true, ...upd.rows[0] })
})

// POST /partner/orders/:id/mark-delivered
// multipart/form-data: photo?, notes?, client_tx_id?
router.post('/partner/orders/:id/mark-delivered',
  authenticateToken,
  requirePartnerOrAdmin,
  partnerLimiter,
  handleUpload('photo'),

  async (req, res) => {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ ok: false, message: 'orderId inválido' })

    const client_tx_id = req.body?.client_tx_id || String(Date.now())
    const notes = req.body?.notes || null

    const userId = req.user.id
    const { role, owner_id } = await getUserRoleAndOwnerId(userId)

    // Lee orden y aplica EXACTAMENTE las mismas reglas que en /status:
    const { rows } = await pool.query(
      `SELECT id, owner_id, status, metadata FROM orders WHERE id=$1 LIMIT 1`,
      [id]
    )
    if (!rows.length) return res.status(404).json({ ok: false, message: 'Orden no encontrada' })

    const ord = rows[0]
    const md = ord.metadata || {}
    const current = String(ord.status)

    // Reglas (calcadas de tu /status):
    if (role === 'owner') {
      if (!owner_id || Number(ord.owner_id) !== Number(owner_id)) {
        return res.status(403).json({ ok: false, message: 'No autorizado' })
      }
      if (current !== 'shipped') {
        return res.status(409).json({ ok: false, message: 'Para marcar delivered debe estar en shipped' })
      }
    } else if (role === 'delivery') {
      if (String(md.delivery_assignee_id || '') !== String(userId)) {
        return res.status(403).json({ ok: false, message: 'Orden no asignada a ti' })
      }
      if (current !== 'shipped') {
        return res.status(409).json({ ok: false, message: 'Para marcar delivered debe estar en shipped' })
      }
    } else if (role !== 'admin') {
      return res.status(403).json({ ok: false, message: 'No autorizado' })
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Idempotencia de evento
      await client.query(
        `INSERT INTO delivery_events(order_id, client_tx_id, notes, photo_url)
         VALUES ($1,$2,$3,NULL)
         ON CONFLICT (order_id, client_tx_id) DO NOTHING`,
        [id, client_tx_id, notes]
      )

      // Subida a Cloudinary (si hay foto)
      let photoUrl = null
      let photoPublicId = null
      if (req.file) {
        const publicId = `order_${id}_${client_tx_id}`
        const up = await uploadBufferToCloudinary(req.file.buffer, {
          public_id: publicId,
          folder: process.env.CLOUDINARY_FOLDER || 'deliveries',
        })
        photoUrl = up.secure_url
        photoPublicId = up.public_id

        // actualiza el evento con la url
        await client.query(
          `UPDATE delivery_events SET photo_url = $3 WHERE order_id=$1 AND client_tx_id=$2`,
          [id, client_tx_id, photoUrl]
        )
      }

      // Parche de metadata (mantén tu estructura)
      const nowISO = new Date().toISOString()
      const newMeta = {
        ...(md || {}),
        status_times: {
          ...(md?.status_times || {}),
          delivered_at: nowISO,
        },
        delivery: {
          ...(md?.delivery || {}),
          delivered: true,
          delivered_at: nowISO,
          delivered_by: role === 'delivery' ? 'partner' : 'owner/admin',
          notes: notes || null,
          photo_url: photoUrl || null,
          photo_public_id: photoPublicId || null,
        },
      }

      // Update orden
      const upd = await client.query(
        `UPDATE orders
            SET status = 'delivered',
                delivered_at = COALESCE(delivered_at, $3::timestamptz),
                metadata = $2::jsonb
          WHERE id = $1
          RETURNING id, status, metadata`,
        [id, JSON.stringify(newMeta), nowISO]
      )

      await client.query('COMMIT')
      return res.json({
        ok: true,
        ...upd.rows[0],
        photo_url: photoUrl,
        photo_public_id: photoPublicId,
      })
    } catch (e) {
      await client.query('ROLLBACK')
      console.error('[partner mark-delivered] error:', e?.code, e?.message || e)
      return res.status(500).json({ ok: false, message: 'No se pudo marcar delivered' })
    } finally {
      client.release()
    }
  }
)

// Historial de órdenes por cliente (autenticado: sólo el propio usuario o admin)
router.get('/customers/:customerId/orders', authenticateToken, async (req, res) => {
  const customerId = Number(req.params.customerId);
  if (!Number.isFinite(customerId)) {
    return res.status(400).json({ error: 'customerId inválido' });
  }

  try {
    // Seguridad: solo la misma usuaria o admin
    const isAdmin = await isAdminUser(req.user.id);
    if (Number(req.user.id) !== customerId && !isAdmin) {
      return res.sendStatus(403);
    }

    const ordersResult = await pool.query(
      `
      SELECT
        o.id AS order_id,
        o.created_at,
        o.status,
        o.payment_method,
        o.metadata,

        li.product_id,
        li.quantity,
        li.unit_price,

        -- para encargos (sin product_id), leemos del metadata del line_item
        COALESCE(p.title,     li.metadata->>'title')      AS product_name,
        COALESCE(p.image_url, li.metadata->>'image_url')  AS image_url,
        li.metadata->>'source_url'                         AS source_url
      FROM orders o
      JOIN line_items li         ON o.id = li.order_id
      LEFT JOIN products  p      ON p.id = li.product_id    -- ⬅️ LEFT JOIN para incluir encargos
      WHERE o.customer_id = $1
      ORDER BY o.created_at DESC, li.id ASC
      `,
      [customerId]
    );

    const rows = ordersResult.rows;
    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.order_id]) {
        grouped[row.order_id] = {
          order_id: row.order_id,
          created_at: row.created_at,
          status: row.status,
          payment_method: row.payment_method,
          metadata: row.metadata,
          items: [],
        };
      }
      grouped[row.order_id].items.push({
        product_id: row.product_id,                   // puede ser null en encargos
        product_name: row.product_name || undefined,  // viene de COALESCE(...)
        quantity: Number(row.quantity),
        unit_price: Number(row.unit_price),
        image_url: row.image_url || null,
        source_url: row.source_url || null,           // opcional para enlazar al origen
      });
    }

    res.json(Object.values(grouped));
  } catch (error) {
    console.error('GET /customers/:customerId/orders error', error);
    res.status(500).send('Error al obtener el historial de órdenes');
  }
});


/* LINE ITEMS (tal cual estaban) */
router.get('/line-items', authenticateToken, async (req, res) => {
  const isAdmin = await isAdminUser(req.user.id)
  if (!isAdmin) return res.sendStatus(403)
  try {
    const result = await pool.query('SELECT * FROM line_items')
    res.json(result.rows)
  } catch {
    res.status(500).send('Error al obtener los line items')
  }
})


router.get('/line-items/:id', authenticateToken, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).send('id inválido')
  try {
    const { rows } = await pool.query('SELECT * FROM line_items WHERE id=$1', [id])
    if (!rows.length) return res.status(404).send('No encontrado')

    const authz = await assertLineItemOwnerOrAdmin(id, req.user.id)
    if (!authz.ok) return res.sendStatus(authz.notFound ? 404 : 403)

    res.json(rows[0])
  } catch {
    res.status(500).send('Error al obtener el line item')
  }
})


router.post('/line-items', authenticateToken, async (req, res) => {
  const { order_id, product_id, quantity, unit_price, metadata } = req.body || {}
  const orderId = Number(order_id)
  if (!Number.isFinite(orderId)) return res.status(400).send('order_id inválido')

  const authz = await assertOrderOwnerOrAdmin(orderId, req.user.id)
  if (!authz.ok) return res.sendStatus(authz.notFound ? 404 : 403)

  try {
    const result = await pool.query(
      `INSERT INTO line_items (order_id, product_id, quantity, unit_price, metadata)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [orderId, product_id ?? null, Number(quantity) || 0, Number(unit_price) || 0, metadata || {}]
    )
    res.status(201).json(result.rows[0])
  } catch {
    res.status(500).send('Error al crear el line item')
  }
})


router.delete('/line-items/:id', authenticateToken, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).send('id inválido')

  try {
    const { rows } = await pool.query('SELECT order_id FROM line_items WHERE id=$1', [id])
    if (!rows.length) return res.sendStatus(204)

    const orderId = Number(rows[0].order_id)
    const authz = await assertOrderOwnerOrAdmin(orderId, req.user.id)
    if (!authz.ok) return res.sendStatus(authz.notFound ? 404 : 403)

    await pool.query('DELETE FROM line_items WHERE id=$1', [id])
    res.sendStatus(204)
  } catch {
    res.status(500).send('Error al eliminar el line item')
  }
})


module.exports = router
