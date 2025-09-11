// middleware/authenticateToken.js
const jwt = require('jsonwebtoken')
const { pool } = require('../db')

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET es requerido (no uses el fallback en prod)')
}
const SECRET = process.env.JWT_SECRET

module.exports = async function authenticateToken(req, res, next) {
  try {
    const raw = req.headers['authorization'] || req.headers.authorization || ''
    const authHeader = typeof raw === 'string' ? raw.trim() : ''
    const token = authHeader && authHeader.split(' ')[1]
    if (!token) return res.sendStatus(401)

    let payload
    try {
      payload = jwt.verify(token, SECRET) // respeta exp si lo firma el login (30d)
    } catch {
      return res.sendStatus(403)
    }

    const userId = payload && (payload.id || payload.sub)
    if (!userId) return res.sendStatus(403)

    // 🔐 Valida contra la base y saca role/owner_id desde metadata
    const { rows } = await pool.query(
      `
      SELECT
        id,
        email,
        (metadata->>'role')      AS role,
        NULLIF((metadata->>'owner_id'),'') AS owner_id_raw
      FROM customers
      WHERE id = $1
      LIMIT 1
      `,
      [userId]
    )
    if (!rows.length) return res.sendStatus(403)

    const row = rows[0]
    // normaliza owner_id a número si aplica
    const ownerIdNum = Number(row.owner_id_raw)
    const owner_id = Number.isFinite(ownerIdNum) ? ownerIdNum : null

    // ⚠️ Usa SIEMPRE lo de la DB, no lo del token
    req.user = {
      id: row.id,
      email: row.email,
      role: row.role || null,
      ...(owner_id != null ? { owner_id } : {}),
    }

    return next()
  } catch {
    return res.sendStatus(403)
  }
}
