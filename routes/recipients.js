// routes/recipients.js
const express = require('express')
const router = express.Router()
const { pool } = require('../db')
const authenticateToken = require('../middleware/authenticateToken')

// Validación mínima
const isUSZip = (s) => /^\d{5}(-\d{4})?$/.test(String(s || '').trim())
const isCUCI  = (s) => /^\d{11}$/.test(String(s || '').trim())
const PHONE_MIN = (s) => String(s || '').replace(/\D/g,'').length >= 8

function pickRecipientBody(body) {
  const r = body || {}
  const base = {
    country: (r.country || '').toUpperCase(),
    first_name: r.first_name?.trim(),
    last_name: r.last_name?.trim(),
    phone: r.phone != null ? String(r.phone).trim() : null,
    email: r.email ? String(r.email).trim() : null,
    instructions: r.instructions ? String(r.instructions).trim() : null,
    metadata: typeof r.metadata === 'object' && r.metadata ? r.metadata : {},
    // nuevos campos (front)
    label: r.label ? String(r.label).trim() : null,
    notes: r.notes ? String(r.notes).trim() : null,
    is_default: r.is_default === true
  }

  if (base.country === 'CU') {
    return {
      ...base,
      cu_province: r.province || r.cu_province || null,
      cu_municipality: r.municipality || r.cu_municipality || null,
      cu_address: r.address || r.cu_address || null,
      cu_ci: r.ci || r.cu_ci || null,
      cu_area_type: r.area_type || r.cu_area_type || null,
      // limpiar US
      us_address_line1: null, us_address_line2: null, us_city: null, us_state: null, us_zip: null
    }
  }

  if (base.country === 'US') {
    return {
      ...base,
      us_address_line1: r.address_line1 || r.us_address_line1 || null,
      us_address_line2: r.address_line2 || r.us_address_line2 || null,
      us_city: r.city || r.us_city || null,
      us_state: r.state || r.us_state || null,
      us_zip: r.zip || r.us_zip || null,
      // limpiar CU
      cu_province: null, cu_municipality: null, cu_address: null, cu_ci: null, cu_area_type: null
    }
  }

  return base
}

function validateRecipient(rec) {
  if (!rec.country || !['CU','US'].includes(rec.country)) return 'country inválido'
  if (!rec.first_name) return 'first_name requerido'
  if (!rec.last_name) return 'last_name requerido'
  if (rec.phone && !PHONE_MIN(rec.phone)) return 'phone inválido'

  if (rec.country === 'CU') {
    if (!rec.cu_province || !rec.cu_municipality) return 'province/municipality requeridos'
    if (!rec.cu_address) return 'address requerido'
    if (!isCUCI(rec.cu_ci)) return 'ci inválido (11 dígitos)'
  }
  if (rec.country === 'US') {
    if (!rec.us_address_line1) return 'address_line1 requerido'
    if (!rec.us_city) return 'city requerido'
    if (!rec.us_state) return 'state requerido'
    if (!isUSZip(rec.us_zip)) return 'zip inválido'
  }
  return null
}

function toClientRow(r) {
  return {
    id: r.id,
    customer_id: r.customer_id,
    country: r.country,
    first_name: r.first_name,
    last_name: r.last_name,
    phone: r.phone,
    email: r.email,
    instructions: r.instructions,
    metadata: r.metadata || {},
    label: r.label,
    notes: r.notes,
    is_default: !!r.is_default,
    // CU
    province: r.cu_province,
    municipality: r.cu_municipality,
    address: r.cu_address,
    ci: r.cu_ci,
    area_type: r.cu_area_type,
    // US
    address_line1: r.us_address_line1,
    address_line2: r.us_address_line2,
    city: r.us_city,
    state: r.us_state,
    zip: r.us_zip,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

// Listar mis destinatarios (?country=CU|US)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const vals = [req.user.id]
    const where = ['customer_id = $1']
    if (req.query.country && ['CU','US'].includes(String(req.query.country).toUpperCase())) {
      vals.push(String(req.query.country).toUpperCase())
      where.push(`country = $${vals.length}`)
    }
    const { rows } = await pool.query(
      `SELECT * FROM shipping_recipients WHERE ${where.join(' AND ')} ORDER BY created_at DESC`,
      vals
    )
    res.json(rows.map(toClientRow))
  } catch (e) {
    console.error('GET /recipients', e)
    res.status(500).json({ error: 'recipients_list_failed' })
  }
})

// Obtener uno por id (solo dueño)
router.get('/:id', authenticateToken, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' })
  try {
    const r = await pool.query('SELECT * FROM shipping_recipients WHERE id=$1 AND customer_id=$2', [id, req.user.id])
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' })
    res.json(toClientRow(r.rows[0]))
  } catch (e) {
    console.error('GET /recipients/:id', e)
    res.status(500).json({ error: 'recipient_get_failed' })
  }
})

// Crear
router.post('/', authenticateToken, async (req, res) => {
  try {
    const rec = pickRecipientBody(req.body || {})
    const err = validateRecipient(rec)
    if (err) return res.status(400).json({ error: err })

    const q = `
      INSERT INTO shipping_recipients
      (customer_id, country, first_name, last_name, phone, email, instructions, metadata,
       label, notes, is_default,
       cu_province, cu_municipality, cu_address, cu_ci, cu_area_type,
       us_address_line1, us_address_line2, us_city, us_state, us_zip)
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,
       $9,$10,$11,
       $12,$13,$14,$15,$16,
       $17,$18,$19,$20,$21)
      RETURNING *`
    const { rows } = await pool.query(q, [
      req.user.id, rec.country, rec.first_name, rec.last_name, rec.phone, rec.email, rec.instructions, rec.metadata,
      rec.label, rec.notes, !!rec.is_default,
      rec.cu_province, rec.cu_municipality, rec.cu_address, rec.cu_ci, rec.cu_area_type,
      rec.us_address_line1, rec.us_address_line2, rec.us_city, rec.us_state, rec.us_zip
    ])

    const inserted = rows[0]
    if (inserted.is_default === true) {
      await pool.query('SELECT set_unique_default_recipient($1,$2)', [req.user.id, inserted.id])
    }

    res.status(201).json(toClientRow(inserted))
  } catch (e) {
    console.error('POST /recipients', e)
    res.status(500).json({ error: 'recipient_create_failed' })
  }
})

// Actualizar (solo dueño) — acepta PUT y PATCH
async function updateRecipientCore(id, userId, body, res) {
  const own = await pool.query('SELECT customer_id FROM shipping_recipients WHERE id=$1', [id])
  if (!own.rows.length) return res.status(404).json({ error: 'not_found' })
  if (Number(own.rows[0].customer_id) !== Number(userId)) return res.sendStatus(403)

  const rec = pickRecipientBody(body || {})
  const err = validateRecipient(rec)
  if (err) return res.status(400).json({ error: err })

  const q = `
    UPDATE shipping_recipients SET
      country=$2, first_name=$3, last_name=$4, phone=$5, email=$6, instructions=$7, metadata=$8,
      label=$9, notes=$10, is_default=$11,
      cu_province=$12, cu_municipality=$13, cu_address=$14, cu_ci=$15, cu_area_type=$16,
      us_address_line1=$17, us_address_line2=$18, us_city=$19, us_state=$20, us_zip=$21
    WHERE id=$1
    RETURNING *`
  const { rows } = await pool.query(q, [
    id,
    rec.country, rec.first_name, rec.last_name, rec.phone, rec.email, rec.instructions, rec.metadata,
    rec.label, rec.notes, !!rec.is_default,
    rec.cu_province, rec.cu_municipality, rec.cu_address, rec.cu_ci, rec.cu_area_type,
    rec.us_address_line1, rec.us_address_line2, rec.us_city, rec.us_state, rec.us_zip
  ])

  const updated = rows[0]
  if (updated.is_default === true) {
    await pool.query('SELECT set_unique_default_recipient($1,$2)', [userId, updated.id])
  }

  return res.json(toClientRow(updated))
}

router.put('/:id', authenticateToken, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' })
  try {
    await updateRecipientCore(id, req.user.id, req.body, res)
  } catch (e) {
    console.error('PUT /recipients/:id', e)
    res.status(500).json({ error: 'recipient_update_failed' })
  }
})

router.patch('/:id', authenticateToken, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' })
  try {
    await updateRecipientCore(id, req.user.id, req.body, res)
  } catch (e) {
    console.error('PATCH /recipients/:id', e)
    res.status(500).json({ error: 'recipient_update_failed' })
  }
})

// Marcar como predeterminado (solo dueño)
router.patch('/:id/default', authenticateToken, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' })
  try {
    const own = await pool.query('SELECT customer_id FROM shipping_recipients WHERE id=$1', [id])
    if (!own.rows.length) return res.status(404).json({ error: 'not_found' })
    if (Number(own.rows[0].customer_id) !== Number(req.user.id)) return res.sendStatus(403)

    const { rows } = await pool.query(
      'UPDATE shipping_recipients SET is_default=true WHERE id=$1 RETURNING *',
      [id]
    )
    await pool.query('SELECT set_unique_default_recipient($1,$2)', [req.user.id, id])
    res.json({ ok: true, id: rows[0].id })
  } catch (e) {
    console.error('PATCH /recipients/:id/default', e)
    res.status(500).json({ error: 'recipient_set_default_failed' })
  }
})

// Borrar (solo dueño)
router.delete('/:id', authenticateToken, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' })
  try {
    const q = await pool.query(
      'DELETE FROM shipping_recipients WHERE id=$1 AND customer_id=$2 RETURNING id',
      [id, req.user.id]
    )
    if (!q.rows.length) return res.status(404).json({ error: 'not_found' })
    res.json({ ok: true })
  } catch (e) {
    console.error('DELETE /recipients/:id', e)
    res.status(500).json({ error: 'recipient_delete_failed' })
  }
})

module.exports = router
