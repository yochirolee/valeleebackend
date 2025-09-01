// middleware/authenticateToken.js
const jwt = require('jsonwebtoken')

// Usa el mismo secreto con el que firmas tus tokens
const SECRET = process.env.JWT_SECRET || 'secret'

module.exports = function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers.authorization
  const token = authHeader && authHeader.split(' ')[1] // "Bearer <token>"
  if (!token) return res.sendStatus(401)

  jwt.verify(token, SECRET, (err, user) => {
    if (err) return res.sendStatus(403)
    req.user = user
    next()
  })
}
