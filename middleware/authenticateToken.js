const jwt = require('jsonwebtoken')
const { pool } = require('../db')

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET es requerido')
}
const SECRET = process.env.JWT_SECRET

// cache simple 60s
const cache = new Map()
const TTL_MS = 60 * 1000

module.exports = async function authenticateToken(req, res, next) {
  try {
    const raw = req.headers['authorization'] || req.headers.authorization || ''
    const authHeader = typeof raw === 'string' ? raw.trim() : ''
    const token = authHeader && authHeader.split(' ')[1]
    if (!token) return res.sendStatus(401)

    let payload
    try {
      payload = jwt.verify(token, SECRET)
    } catch {
      return res.sendStatus(403) // token inválido/expirado
    }

    const userId = payload && (payload.id || payload.sub)
    if (!userId) return res.sendStatus(403)

    // cache 60s
    const now = Date.now()
    const c = cache.get(userId)
    if (c && c.exp > now) {
      req.user = c.data
      return next()
    }

    let row
    try {
      const { rows } = await pool.query(
        `
        SELECT
          id,
          email,
          (metadata->>'role') AS role,
          NULLIF((metadata->>'owner_id'),'') AS owner_id_raw
        FROM customers
        WHERE id = $1
        LIMIT 1
        `,
        [userId]
      )
      if (!rows.length) return res.sendStatus(403)
      row = rows[0]
    } catch (e) {
      // antes devolvías 403, ahora 503 para ver el problema real y no confundir al front
      return res.status(503).json({ error: 'auth_db_unavailable' })
    }

    const ownerIdNum = Number(row.owner_id_raw)
    const owner_id = Number.isFinite(ownerIdNum) ? ownerIdNum : null

    const user = {
      id: row.id,
      email: row.email,
      role: row.role || null,
      ...(owner_id != null ? { owner_id } : {}),
    }

    cache.set(userId, { exp: now + TTL_MS, data: user })
    req.user = user
    next()
  } catch {
    return res.status(500).json({ error: 'auth_internal_error' })
  }
}
