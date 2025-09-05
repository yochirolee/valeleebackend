const express = require('express')
require('dotenv').config()
const { pool } = require('./db')
const fs = require('fs')
const path = require('path')
const cors = require('cors')

const { ownersRouter, ownersPublicRouter } = require('./routes/owners')
const ownerAreasRouter = require('./routes/ownerAreas')
const shippingRouter = require('./routes/shipping')

// routers por funcionalidad
const productsRouter = require('./routes/products')
const ordersRouter = require('./routes/orders')
const categoriesRouter = require('./routes/categories')
const customersRouter = require('./routes/customers')
const cartRouter = require('./routes/cart')

// Flujos existentes
const checkoutRoutes = require('./routes/checkout')
const paymentsRouter = require('./routes/payments')
const checkoutDirectRoutes = require('./routes/checkout_direct')
const paymentsDirectRoutes = require('./routes/payments_direct')

// Middlewares auxiliares (si otros módulos los necesitan)
const authenticateToken = require('./middleware/authenticateToken')
const {
  requireAdmin,
  isAdminUser,
  getUserRoleAndOwnerId,
  requirePartnerOrAdmin,
} = require('./middleware/roles');

const PORT = process.env.PORT || 4000
const HOST = process.env.HOST || '0.0.0.0'

const app = express()
app.set('trust proxy', 1)
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// CORS
const originsFromEnv = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)
const allowedOrigins = ['http://localhost:3000', ...originsFromEnv]
const allowVercelPreviews = true
const isAllowed = (origin) => {
  if (!origin) return true
  if (allowedOrigins.includes(origin)) return true
  if (allowVercelPreviews && /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) return true
  return false
}
const corsOptions = {
  origin: process.env.NODE_ENV === 'production'
    ? (origin, cb) => isAllowed(origin) ? cb(null, true) : cb(new Error('Not allowed by CORS'))
    : true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}
app.use(cors(corsOptions))
app.use((req, res, next) => (req.method === 'OPTIONS' ? res.sendStatus(204) : next()))

// Archivos estáticos y uploads
for (const dir of ['img', 'cats']) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}
app.use('/img', express.static('img'))
app.use('/cats', express.static('cats'))

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads')
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })
app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }
}))

// Health & raíz
app.get('/', (_req, res) => res.send('¡Tu backend con Express está funcionando! 🚀'))
app.get('/health', (_req, res) => res.json({ ok: true }))

// === Montaje de rutas existentes ===
app.use('/checkout', authenticateToken, checkoutRoutes)   // protegida
app.use('/payments', paymentsRouter)                      // callback público
app.use('/checkout-direct', checkoutDirectRoutes)
app.use('/payments-direct', paymentsDirectRoutes)


app.use(productsRouter)
app.use(ordersRouter)
app.use(categoriesRouter)
app.use(customersRouter)
app.use(cartRouter)

// === Owners / Shipping ya existentes ===
app.use('/owners', ownersPublicRouter)                                 // público: /owners/options
app.use('/admin/owners', authenticateToken, ownersRouter)              // admin CRUD
app.use('/admin/owners/:ownerId/areas', authenticateToken, ownerAreasRouter)
app.use('/shipping', authenticateToken, shippingRouter)
app.use('/admin/owners', authenticateToken, requireAdmin, ownersRouter);
// Rutas de entrega
app.use('/deliver', require('./routes/deliver'))

const PORT_FINAL = process.env.PORT || 4000
app.listen(PORT_FINAL, () => console.log(`Servidor escuchando en el puerto ${PORT_FINAL}`))
