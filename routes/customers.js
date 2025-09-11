const express = require('express')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const router = express.Router()
const { pool } = require('../db')
const authenticateToken = require('../middleware/authenticateToken')
const { requireAdmin } = require('../middleware/roles')
const { sendPasswordResetEmail } = require('../helpers/resend')

// Crear cliente (simple)
router.post('/customers', async (req, res) => {
  return res.status(410).json({ error: 'Endpoint obsoleto. Usa POST /register.' });
})

//  Listado (sólo admin)
router.get('/customers', authenticateToken, requireAdmin, async (_req, res) => {
  try {
    const result = await pool.query(`
           SELECT id, email, first_name, last_name, phone, address, metadata, created_at
           FROM customers
           ORDER BY created_at DESC
         `)
    res.json(result.rows)
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al obtener los clientes')
  }
})

// Me (autenticado)
router.get('/customers/me', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, first_name, last_name, phone, address, metadata FROM customers WHERE id = $1',
      [req.user.id]
    )
    if (!rows.length) return res.status(404).send('Cliente no encontrado')
    res.json(rows[0])
  } catch (e) {
    console.error(e)
    res.status(500).send('Error al obtener el cliente')
  }
})

router.get('/customers/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params
  try {
    const result = await pool.query(`
           SELECT id, email, first_name, last_name, phone, address, metadata, created_at
           FROM customers
           WHERE id = $1
        `, [id])
    if (!result.rows.length) return res.status(404).send('Cliente no encontrado')
    res.json(result.rows[0])
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al obtener el cliente')
  }
})

// Actualizar perfil propio
router.put('/customers/me', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { first_name, last_name, phone, address, billing_zip, metadata } = req.body || {};

  const sets = [];
  const vals = [];
  let i = 1;

  if (typeof first_name !== 'undefined') { sets.push(`first_name = $${i++}`); vals.push(first_name); }
  if (typeof last_name !== 'undefined') { sets.push(`last_name  = $${i++}`); vals.push(last_name); }
  if (typeof phone !== 'undefined') { sets.push(`phone      = $${i++}`); vals.push(phone); }
  if (typeof address !== 'undefined') { sets.push(`address    = $${i++}`); vals.push(address); }

  const mdPatch = {};
  if (typeof billing_zip === 'string' && billing_zip.trim() !== '') mdPatch.billing_zip = billing_zip.trim();

  // 🚫 bloquear claves peligrosas del cliente
  const FORBIDDEN = new Set(['role', 'owner_id', 'reset_token', 'reset_expires']);
  if (metadata && typeof metadata === 'object') {
    for (const [k, v] of Object.entries(metadata)) {
      if (!FORBIDDEN.has(k)) mdPatch[k] = v;
    }
  }

  if (Object.keys(mdPatch).length > 0) {
    sets.push(`metadata = COALESCE(metadata,'{}'::jsonb) || $${i++}::jsonb`);
    vals.push(JSON.stringify(mdPatch));
  }

  if (sets.length === 0) {
    return res.status(400).json({ ok: false, message: 'No hay campos para actualizar.' });
  }

  vals.push(userId);

  try {
    const q = `
      UPDATE customers
         SET ${sets.join(', ')}
       WHERE id = $${i}
   RETURNING id, email, first_name, last_name, phone, address, metadata`;
    const { rows } = await pool.query(q, vals);
    if (!rows.length) return res.status(404).json({ ok: false, message: 'Cliente no encontrado' });
    return res.json({ ok: true, customer: rows[0] });
  } catch (e) {
    console.error('PUT /customers/me', e);
    return res.status(500).json({ ok: false, message: 'Error actualizando el perfil' });
  }
});

// Compat/legacy update por id (no usar para password reset)
router.put('/customers/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (id === 'me') return res.status(400).json({ ok: false, message: 'Usa PUT /customers/me' });
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ ok: false, message: 'ID inválido' });

  let { name, email, address, payment_method, metadata, first_name, last_name, phone } = req.body || {};

  if (name && (!first_name && !last_name)) {
    const parts = String(name).trim().split(/\s+/);
    first_name = parts.shift() || '';
    last_name = parts.join(' ') || '';
  }

  const mdPatch = {};
  if (payment_method) mdPatch.payment_method = String(payment_method);
  // 🚫 no permitir editar role/owner_id por este endpoint
  if (metadata && typeof metadata === 'object') {
    const FORBIDDEN = new Set(['role', 'owner_id']);
    for (const [k, v] of Object.entries(metadata)) {
      if (!FORBIDDEN.has(k)) mdPatch[k] = v;
    }
  }

  const sets = [];
  const vals = [];
  let i = 1;

  if (typeof email !== 'undefined') { sets.push(`email = $${i++}`); vals.push(String(email).trim().toLowerCase()); }
  if (typeof first_name !== 'undefined') { sets.push(`first_name = $${i++}`); vals.push(first_name); }
  if (typeof last_name !== 'undefined') { sets.push(`last_name  = $${i++}`); vals.push(last_name); }
  if (typeof phone !== 'undefined') { sets.push(`phone      = $${i++}`); vals.push(phone); }
  if (typeof address !== 'undefined') { sets.push(`address    = $${i++}`); vals.push(address); }
  if (Object.keys(mdPatch).length > 0) {
    sets.push(`metadata = COALESCE(metadata,'{}'::jsonb) || $${i++}::jsonb`);
    vals.push(JSON.stringify(mdPatch));
  }

  if (sets.length === 0) return res.status(400).json({ ok: false, message: 'Nada para actualizar.' });

  vals.push(Number(id));

  try {
    const q = `
      UPDATE customers
         SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${i}
   RETURNING id, email, first_name, last_name, phone, address, metadata`;
    const { rows } = await pool.query(q, vals);
    if (!rows.length) return res.status(404).json({ ok: false, message: 'Cliente no encontrado' });
    return res.json({ ok: true, customer: rows[0] });
  } catch (error) {
    console.error('PUT /customers/:id', error);
    return res.status(500).json({ ok: false, message: 'Error al actualizar el cliente' });
  }
});


/* ===== ADMIN CUSTOMERS ===== */

// List
router.get('/admin/customers', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { q = '', role = '', page = '1', limit = '20' } = req.query
    const p = Math.max(1, Number(page) || 1)
    const l = Math.min(100, Math.max(1, Number(limit) || 20))
    const off = (p - 1) * l

    const where = []
    const vals = []

    if (q) {
      const like = `%${q}%`
      vals.push(like, like, like)
      const i1 = vals.length - 2, i2 = vals.length - 1, i3 = vals.length
      where.push(`(lower(email) ILIKE lower($${i1}) OR lower(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) ILIKE lower($${i2}) OR COALESCE(phone,'') ILIKE $${i3})`)
    }

    if (role) {
      vals.push(role)
      where.push(`(metadata->>'role') = $${vals.length}`)
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const sql = `
      SELECT
        id, email, first_name, last_name, phone, address, metadata,
        (metadata->>'role') AS role,
        created_at,
        COUNT(*) OVER() AS total_rows
      FROM customers
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT ${l} OFFSET ${off};
    `
    const { rows } = await pool.query(sql, vals)
    const total = rows[0]?.total_rows ? Number(rows[0].total_rows) : 0
    res.json({
      items: rows.map(({ total_rows, ...r }) => r),
      page: p,
      pages: Math.max(1, Math.ceil(total / l)),
      total,
      limit: l
    })
  } catch (e) {
    console.error('GET /admin/customers', e)
    res.status(500).json({ error: 'Error al listar clientes' })
  }
})

// PATCH rol simple
router.patch('/admin/customers/:id/role', authenticateToken, requireAdmin, async (req, res) => {
  const id = Number(req.params.id)
  const { role } = req.body || {}

  const allowed = new Set(['admin', 'owner', 'delivery', null, ''])
  const roleNorm = role === '' ? null : role
  if (!allowed.has(roleNorm)) return res.status(400).json({ error: 'Rol inválido' })

  if (roleNorm !== 'admin' && Number(req.user.id) === id) {
    return res.status(400).json({ error: 'No puedes quitarte tu propio rol admin' })
  }

  try {
    const q = roleNorm == null
      ? `UPDATE customers SET metadata = (COALESCE(metadata,'{}'::jsonb) - 'role') WHERE id = $1 RETURNING id, email, metadata`
      : `UPDATE customers SET metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('role',$2::text) WHERE id = $1 RETURNING id, email, metadata`
    const params = roleNorm == null ? [id] : [id, String(roleNorm)]
    const { rows } = await pool.query(q, params)
    if (!rows.length) return res.status(404).json({ error: 'Cliente no encontrado' })
    res.json({ ok: true, id, role: rows[0].metadata?.role ?? null })
  } catch (e) {
    console.error('PATCH /admin/customers/:id/role', e)
    res.status(500).json({ error: 'No se pudo actualizar el rol' })
  }
})

// PATCH rol + owner_id
router.patch('/admin/customers/:id/role-owner', authenticateToken, requireAdmin, async (req, res) => {
  const id = Number(req.params.id)
  let { role, owner_id } = req.body || {}

  if (role === '') role = null
  if (role === 'mensajero') role = 'delivery'
  if (owner_id === '' || owner_id === undefined) owner_id = null
  if (owner_id != null && !Number.isInteger(Number(owner_id))) {
    return res.status(400).json({ error: 'owner_id inválido' })
  }

  try {
    const prev = await pool.query(
      `SELECT id, email, first_name, last_name, metadata FROM customers WHERE id = $1 LIMIT 1`,
      [id]
    )
    if (!prev.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' })
    const prevMd = prev.rows[0].metadata || {}
    const prevRole = prevMd.role || null

    if (owner_id != null) {
      const chk = await pool.query('SELECT 1 FROM owners WHERE id = $1', [owner_id])
      if (!chk.rows.length) return res.status(404).json({ error: 'Owner no encontrado' })
    }

    if (role == null) {
      await pool.query('BEGIN')
      const upd = await pool.query(
        `UPDATE customers
            SET metadata = (COALESCE(metadata,'{}'::jsonb) - 'role' - 'owner_id')
          WHERE id = $1
        RETURNING id, email, first_name, last_name, metadata`,
        [id]
      )
      if (String(prevRole) === 'delivery' || String(prevRole) === 'owner') {
        await pool.query(
          `UPDATE orders
              SET metadata = (COALESCE(metadata,'{}'::jsonb)
                               - 'delivery_assignee_id'
                               - 'delivery_assignee_name'
                               - 'delivery_assignee_email')
            WHERE (metadata->>'delivery_assignee_id') = $1
              AND status <> 'delivered'`,
          [String(id)]
        )
      }
      await pool.query('COMMIT')
      return res.json(upd.rows[0])
    }

    if (!['admin', 'owner', 'delivery'].includes(String(role))) {
      return res.status(400).json({ error: 'Rol inválido' })
    }

    const patch = { role, owner_id: owner_id ?? null }
    const upd = await pool.query(
      `UPDATE customers
          SET metadata = COALESCE(metadata,'{}'::jsonb) || $1::jsonb
        WHERE id = $2
      RETURNING id, email, first_name, last_name, metadata`,
      [JSON.stringify(patch), id]
    )

    return res.json(upd.rows[0])
  } catch (e) {
    try { await pool.query('ROLLBACK') } catch { }
    console.error('PATCH /admin/customers/:id/role-owner', e)
    return res.status(500).json({ error: 'No se pudo actualizar role/owner_id' })
  }
})

router.delete('/customers/:id', authenticateToken, requireAdmin, async (req, res) => {
  const id = Number(req.params.id)
  if (Number(req.user.id) === id) return res.status(400).json({ error: 'No puedes borrarte a ti misma' })

  try {
    const used = await pool.query('SELECT 1 FROM orders WHERE customer_id = $1 LIMIT 1', [id])
    if (used.rows.length) return res.status(409).json({ error: 'Tiene órdenes asociadas. No se puede eliminar.' })

    await pool.query('DELETE FROM carts WHERE customer_id = $1', [id])
    const del = await pool.query('DELETE FROM customers WHERE id = $1 RETURNING id', [id])
    if (!del.rows.length) return res.status(404).json({ error: 'Cliente no encontrado' })
    res.json({ ok: true })
  } catch (e) {
    console.error('DELETE /admin/customers/:id', e)
    res.status(500).json({ error: 'Error al eliminar cliente' })
  }
})

// DELETE admin borrar
router.delete('/admin/customers/:id', authenticateToken, requireAdmin, async (req, res) => {
  return res.status(410).json({ error: 'Endpoint obsoleto. Usa DELETE /admin/customers/:id' });
})

/* ===== AUTH ===== */

// Register (opcional: auto-login)
router.post('/register', async (req, res) => {
  const { email, password, address = null, phone = null, first_name = null, last_name = null } = req.body
  if (!email || !password) return res.status(400).json({ error: 'Faltan campos requeridos' })

  try {
    const emailNorm = String(email).trim().toLowerCase()
    const hashedPassword = await bcrypt.hash(password, 10)

    const { rows } = await pool.query(
      `INSERT INTO customers (email, password, first_name, last_name, phone, address)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, first_name, last_name, phone, address, metadata`,
      [emailNorm, hashedPassword, first_name, last_name, phone, address]
    )
    const customer = rows[0]
    // auto-login opcional
    const md = customer.metadata || {}
    const ownerIdNum = Number(md.owner_id)
    const payload = {
      id: customer.id,
      email: customer.email,
      role: md.role ?? null,
      ...(Number.isFinite(ownerIdNum) ? { owner_id: ownerIdNum } : {})
    }
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '30d' })

    return res.status(201).json({ customer, token })
  } catch (error) {
    if (error && error.code === '23505') {
      return res.status(409).json({ error: 'El email ya está registrado' })
    }
    console.error(error)
    return res.status(500).json({ error: 'Error al registrar el usuario' })
  }
})


router.post('/login', async (req, res) => {
  const { email, password } = req.body
  try {
    const emailNorm = String(email || '').trim().toLowerCase()

    // Trae metadata para role/owner_id
    const userRes = await pool.query(
      `SELECT id, email, password, metadata
         FROM customers
        WHERE lower(email) = $1
        LIMIT 1`,
      [emailNorm]
    )
    if (!userRes.rows.length) {
      return res.status(400).json({ message: 'Usuario no encontrado' })
    }

    const user = userRes.rows[0]
    const match = await bcrypt.compare(password, user.password)
    if (!match) return res.status(401).json({ message: 'Contraseña incorrecta' })

    const md = user.metadata || {}
    const ownerIdNum = Number(md.owner_id)
    const payload = {
      id: user.id,
      email: user.email,
      role: md.role ?? null,
      // solo incluye owner_id si es num válido
      ...(Number.isFinite(ownerIdNum) ? { owner_id: ownerIdNum } : {})
    }

    // IMPORTANTE: sin fallback 'secret'
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '30d' })
    return res.json({ token })
  } catch (error) {
    console.error(error)
    return res.status(500).send('Error al iniciar sesión')
  }
})


// Forgot / Reset password
router.post('/auth/forgot-password', async (req, res) => {
  const { email, locale } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email requerido' });

  try {
    const emailNorm = String(email).trim().toLowerCase();
    const { rows } = await pool.query('SELECT id, metadata FROM customers WHERE lower(email) = $1', [emailNorm]);

    if (!rows.length) {
      console.log('[forgot] Email no encontrado, devolvemos OK para no filtrar existencia');
      return res.json({ ok: true });
    }

    const userId = rows[0].id;
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await pool.query(
      `UPDATE customers
         SET metadata = COALESCE(metadata,'{}'::jsonb) ||
                        jsonb_build_object('reset_token', $1::text, 'reset_expires', $2::text)
       WHERE id = $3`,
      [token, expiresAt, userId]
    )

    const base = process.env.CLIENT_BASE_URL || 'http://localhost:3000';
    const loc = (locale === 'en' || locale === 'es') ? locale : (process.env.DEFAULT_LOCALE || 'es');
    const link = `${base}/${loc}/reset?token=${token}`;

    console.log('[forgot] Enviando email a', emailNorm, 'link:', link);
    await sendPasswordResetEmail(emailNorm, link, loc);

    return res.json({ ok: true });
  } catch (e) {
    console.error('[forgot] Error:', e);
    return res.status(500).json({ error: 'No se pudo procesar la solicitud' });
  }
});

router.post('/auth/reset-password', async (req, res) => {
  const { token, new_password } = req.body || {};
  if (!token || !new_password) return res.status(400).json({ error: 'token y new_password requeridos' });

  try {
    const { rows } = await pool.query(
      `SELECT id, metadata
         FROM customers
        WHERE (metadata->>'reset_token') = $1
        LIMIT 1`,
      [token]
    );

    if (!rows.length) return res.status(400).json({ error: 'Token inválido' });

    const user = rows[0];
    const expires = user.metadata?.reset_expires;
    if (!expires || new Date(expires).getTime() < Date.now()) {
      return res.status(400).json({ error: 'Token expirado' });
    }

    const hash = await bcrypt.hash(String(new_password), 10);

    await pool.query(
      `UPDATE customers
          SET password = $1,
              metadata = (COALESCE(metadata,'{}'::jsonb) - 'reset_token' - 'reset_expires')
        WHERE id = $2`,
      [hash, user.id]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error('[reset] Error:', e);
    return res.status(500).json({ error: 'No se pudo restablecer la contraseña' });
  }
});

module.exports = router
