const jwt = require('jsonwebtoken')
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET es requerido (no uses el fallback en prod)')
}
const SECRET = process.env.JWT_SECRET

module.exports = function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers.authorization
  const token = authHeader && authHeader.split(' ')[1]
  if (!token) return res.sendStatus(401)

  jwt.verify(token, SECRET, (err, user) => {
    if (err) return res.sendStatus(403)
    req.user = user
    next()
  })
}
