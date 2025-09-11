// middleware/roles.js
const { pool } = require('../db')

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean)

async function fetchUserRow(userId) {
  const { rows } = await pool.query(
    'SELECT email, metadata FROM customers WHERE id = $1 LIMIT 1',
    [userId]
  )
  return rows[0] || null
}

async function isAdminUser(userId) {
  try {
    const row = await fetchUserRow(userId)
    if (!row) return false
    const email = (row.email || '').toLowerCase()
    const role = row.metadata?.role
    return role === 'admin' || ADMIN_EMAILS.includes(email)
  } catch {
    return false
  }
}

async function getUserRoleAndOwnerId(userId) {
  try {
    const row = await fetchUserRow(userId)
    if (!row) return { role: null, owner_id: null }
    const md = row.metadata || {}
    const owner_id_num = Number(md.owner_id)
    return {
      role: md.role || null,
      owner_id: Number.isFinite(owner_id_num) ? owner_id_num : null,
    }
  } catch {
    return { role: null, owner_id: null }
  }
}

async function requireAdmin(req, res, next) {
  if (!req.user?.id) return res.sendStatus(401)
  try {
    const row = await fetchUserRow(req.user.id)
    if (!row) return res.sendStatus(403)
    const email = (row.email || '').toLowerCase()
    const role = row.metadata?.role
    if (role === 'admin' || ADMIN_EMAILS.includes(email)) return next()
    return res.sendStatus(403)
  } catch {
    return res.sendStatus(403)
  }
}

async function requirePartnerOrAdmin(req, res, next) {
  if (!req.user?.id) return res.sendStatus(401)
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
