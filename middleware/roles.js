// middleware/roles.js
const { pool } = require('../db')

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean)

async function isAdminUser(userId) {
  try {
    const { rows } = await pool.query(
      'SELECT email, metadata FROM customers WHERE id = $1',
      [userId]
    )
    if (!rows.length) return false
    const email = (rows[0].email || '').toLowerCase()
    const role = rows[0].metadata?.role
    return role === 'admin' || ADMIN_EMAILS.includes(email)
  } catch {
    return false
  }
}

async function getUserRoleAndOwnerId(userId) {
  try {
    const { rows } = await pool.query(
      'SELECT metadata FROM customers WHERE id = $1 LIMIT 1',
      [userId]
    )
    if (!rows.length) return { role: null, owner_id: null }
    const md = rows[0].metadata || {}
    return {
      role: md.role || null,
      owner_id: Number.isInteger(md.owner_id) ? md.owner_id : null
    }
  } catch {
    return { role: null, owner_id: null }
  }
}

async function requireAdmin(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT email, metadata FROM customers WHERE id = $1',
      [req.user.id]
    )
    if (!rows.length) return res.sendStatus(403)
    const email = (rows[0].email || '').toLowerCase()
    const role = rows[0].metadata?.role
    if (role === 'admin' || ADMIN_EMAILS.includes(email)) return next()
    return res.sendStatus(403)
  } catch {
    return res.sendStatus(403)
  }
}

async function requirePartnerOrAdmin(req, res, next) {
  try {
    const { role } = await getUserRoleAndOwnerId(req.user.id)
    if (role === 'admin' || role === 'owner' || role === 'delivery') return next()
    return res.sendStatus(403)
  } catch {
    return res.sendStatus(403)
  }
}

module.exports = {
  isAdminUser,
  getUserRoleAndOwnerId,
  requireAdmin,
  requirePartnerOrAdmin,
}
