const express = require('express')
require('dotenv').config() 
const { pool } = require('./db')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')

const PORT = process.env.PORT || 4000
const HOST = process.env.HOST || '0.0.0.0'
const API_BASE_URL = process.env.API_BASE_URL || `http://${HOST}:${PORT}`


const SECRET = process.env.JWT_SECRET || 'secret'

const app = express()

const cors = require('cors')

const originsFromEnv = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)

const allowedOrigins = ['http://localhost:3000', ...originsFromEnv]

// ✅ Permite prod exacto y (opcional) cualquier *.vercel.app para previews
const allowVercelPreviews = true
const isAllowed = (origin) => {
  if (!origin) return true // Postman, curl, SSR
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
  credentials: false, // usas Bearer
}

app.use(cors(corsOptions))
app.use((req, res, next) => (req.method === 'OPTIONS' ? res.sendStatus(204) : next()))

app.use(express.json())

app.use('/img', express.static('img'))


// 🔐 Middleware de autenticación
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]
  if (!token) return res.sendStatus(401)

  jwt.verify(token, SECRET, (err, user) => {
    if (err) return res.sendStatus(403)
    req.user = user // { id, email }
    next()
  })
}

app.get('/', (req, res) => {
  res.send('¡Tu backend con Express está funcionando! 🚀')
})

// 🔎 Listar productos (opcional: filtrar por categoría)
app.get('/products', async (req, res) => {
  const { category_id } = req.query

  try {
    let query = 'SELECT id, title, description, price, weight, category_id, image_url, metadata FROM products'
    const params = []

    if (category_id) {
      query += ' WHERE category_id = $1'
      params.push(Number(category_id))
    }

    const result = await pool.query(query, params)
    res.json(result.rows)
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al obtener productos')
  }
})

// 🔎 Obtener un producto por ID
app.get('/products/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, description, price, weight, category_id, image_url, metadata FROM products WHERE id = $1',
      [req.params.id]
    )
    if (result.rows.length === 0) return res.status(404).send('Producto no encontrado')
    res.json(result.rows[0])
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al obtener producto')
  }
})

// ➕ Crear producto (solo title, nada de name)
app.post('/products', async (req, res) => {
  const { title, price, weight, category_id, image_url, description, metadata } = req.body

  if (!title || price == null) {
    return res.status(400).json({ error: 'title y price son requeridos' })
  }

  try {
    const result = await pool.query(
      `INSERT INTO products (title, description, price, weight, category_id, image_url, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, title, description, price, weight, category_id, image_url, metadata`,
      [title, description || null, price, weight || null, category_id || null, image_url || null, metadata || {}]
    )
    res.status(201).json(result.rows[0])
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al crear producto')
  }
})

// ✏️ Actualizar producto (solo title)
app.put('/products/:id', async (req, res) => {
  const { title, price, weight, category_id, image_url, description, metadata } = req.body

  try {
    const result = await pool.query(
      `UPDATE products
         SET title = $1,
             description = $2,
             price = $3,
             weight = $4,
             category_id = $5,
             image_url = $6,
             metadata = $7
       WHERE id = $8
       RETURNING id, title, description, price, weight, category_id, image_url, metadata`,
      [title || null, description || null, price, weight || null, category_id || null, image_url || null, metadata || {}, req.params.id]
    )

    if (result.rows.length === 0) return res.status(404).send('Producto no encontrado')
    res.json(result.rows[0])
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al actualizar producto')
  }
})

// 🗑️ Eliminar producto
app.delete('/products/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM products WHERE id = $1 RETURNING id', [req.params.id])
    if (result.rows.length === 0) return res.status(404).send('Producto no encontrado')
    res.json({ message: 'Producto eliminado' })
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al eliminar producto')
  }
})


app.get('/orders', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC')
    res.json(result.rows)
  } catch {
    res.status(500).send('Error al obtener órdenes')
  }
})

app.get('/orders/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id])
    if (result.rows.length === 0) return res.status(404).send('Orden no encontrada')
    res.json(result.rows[0])
  } catch {
    res.status(500).send('Error al obtener orden')
  }
})

app.post('/orders', async (req, res) => {
  const {
    customer_id,
    customer_name,
    total,
    status,
    payment_method,
    metadata
  } = req.body

  try {
    const result = await pool.query(
      'INSERT INTO orders (customer_id, customer_name, total, status, payment_method, metadata) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [customer_id, customer_name, total, status, payment_method, metadata]
    )
    res.status(201).json(result.rows[0])
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al crear la orden')
  }
})


app.put('/orders/:id', async (req, res) => {
  const { customer_name, total, status } = req.body
  try {
    const result = await pool.query(
      'UPDATE orders SET customer_name = $1, total = $2, status = $3 WHERE id = $4 RETURNING *',
      [customer_name, total, status, req.params.id]
    )
    if (result.rows.length === 0) return res.status(404).send('Orden no encontrada')
    res.json(result.rows[0])
  } catch {
    res.status(500).send('Error al actualizar orden')
  }
})

app.delete('/orders/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM orders WHERE id = $1 RETURNING *', [req.params.id])
    if (result.rows.length === 0) return res.status(404).send('Orden no encontrada')
    res.json({ message: 'Orden eliminada' })
  } catch {
    res.status(500).send('Error al eliminar orden')
  }
})

app.post('/customers', async (req, res) => {
  const { email, first_name, last_name, phone, address } = req.body
  try {
    const result = await pool.query(
      `INSERT INTO customers (email, first_name, last_name, phone, address)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [email, first_name, last_name, phone, address]
    )
    res.status(201).json(result.rows[0])
  } catch {
    res.status(500).send('Error al crear el cliente')
  }
})


// Obtener todos los customers
app.get('/customers', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM customers')
    res.json(result.rows)
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al obtener los clientes')
  }
})

// Ruta protegida para obtener el cliente autenticado
app.get('/customers/me', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, first_name, last_name FROM customers WHERE id = $1',
      [req.user.id]
    )
    if (!rows.length) return res.status(404).send('Cliente no encontrado')
    res.json(rows[0])
  } catch (e) {
    console.error(e)
    res.status(500).send('Error al obtener el cliente')
  }
})

// Obtener un customer por ID
app.get('/customers/:id', async (req, res) => {
  const { id } = req.params

  try {
    const result = await pool.query('SELECT * FROM customers WHERE id = $1', [id])
    if (result.rows.length === 0) {
      return res.status(404).send('Cliente no encontrado')
    }
    res.json(result.rows[0])
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al obtener el cliente')
  }
})

// Actualizar un customer
app.put('/customers/:id', async (req, res) => {
  const { id } = req.params
  const { name, email, address, payment_method, metadata } = req.body

  try {
    const result = await pool.query(
      'UPDATE customers SET name = $1, email = $2, address = $3, payment_method = $4, metadata = $5 WHERE id = $6 RETURNING *',
      [name, email, address, payment_method, metadata, id]
    )
    if (result.rows.length === 0) {
      return res.status(404).send('Cliente no encontrado')
    }
    res.json(result.rows[0])
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al actualizar el cliente')
  }
})

// Eliminar un customer
app.delete('/customers/:id', async (req, res) => {
  const { id } = req.params

  try {
    const result = await pool.query('DELETE FROM customers WHERE id = $1 RETURNING *', [id])
    if (result.rows.length === 0) {
      return res.status(404).send('Cliente no encontrado')
    }
    res.send('Cliente eliminado')
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al eliminar el cliente')
  }
})

// GET todos los line items
app.get('/line-items', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM line_items')
    res.json(result.rows)
  } catch (err) {
    res.status(500).send('Error al obtener los line items')
  }
})

// GET line items por ID
app.get('/line-items/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM line_items WHERE id = $1', [req.params.id])
    if (result.rows.length === 0) return res.status(404).send('No encontrado')
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).send('Error al obtener el line item')
  }
})

// POST crear line item
app.post('/line-items', async (req, res) => {
  const { order_id, product_id, quantity, unit_price, metadata } = req.body
  try {
    const result = await pool.query(
      'INSERT INTO line_items (order_id, product_id, quantity, unit_price, metadata) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [order_id, product_id, quantity, unit_price, metadata || {}]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    res.status(500).send('Error al crear el line item')
  }
})

// DELETE line item
app.delete('/line-items/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM line_items WHERE id = $1', [req.params.id])
    res.sendStatus(204)
  } catch (err) {
    res.status(500).send('Error al eliminar el line item')
  }
})

app.post('/cart', async (req, res) => {
  try {
    const { customer_id } = req.body
    const result = await pool.query(
      'INSERT INTO carts (customer_id) VALUES ($1) RETURNING *',
      [customer_id || null]
    )
    res.status(201).json(result.rows[0])
  } catch (error) {
    res.status(500).send('Error al crear el carrito')
  }
})

app.post('/cart/:id/items', async (req, res) => {
  try {
    const cartId = req.params.id
    const { product_id, quantity, unit_price } = req.body

    const result = await pool.query(
      `INSERT INTO cart_items (cart_id, product_id, quantity, unit_price)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [cartId, product_id, quantity, unit_price]
    )

    res.status(201).json(result.rows[0])
  } catch (error) {
    res.status(500).send('Error al agregar item al carrito')
  }
})

app.get('/cart/:id/items', async (req, res) => {
  try {
    const cartId = req.params.id
    const result = await pool.query(
      `SELECT * FROM cart_items WHERE cart_id = $1`,
      [cartId]
    )
    res.json(result.rows)
  } catch (error) {
    res.status(500).send('Error al obtener los items del carrito')
  }
})

app.delete('/cart/:cartId/items/:itemId', async (req, res) => {
  try {
    const { cartId, itemId } = req.params
    await pool.query(
      `DELETE FROM cart_items WHERE id = $1 AND cart_id = $2`,
      [itemId, cartId]
    )
    res.sendStatus(204)
  } catch (error) {
    res.status(500).send('Error al eliminar el item del carrito')
  }
})


// ✅ Checkout con metadata, protegido y transaccional
app.post('/checkout/:cartId', authenticateToken, async (req, res) => {
  const client = await pool.connect()
  try {
    const { cartId } = req.params
    const { payment_method, metadata } = req.body

    await client.query('BEGIN')

    // 1) Obtener carrito abierto del usuario autenticado
    const cartResult = await client.query(
      'SELECT * FROM carts WHERE id = $1 AND customer_id = $2 AND completed = false',
      [cartId, req.user.id]
    )
    const cart = cartResult.rows[0]
    if (!cart) {
      await client.query('ROLLBACK')
      return res.status(404).send('Carrito no encontrado, no pertenece al usuario, o ya completado')
    }

    // 2) Items del carrito
    const itemsResult = await client.query(
      'SELECT * FROM cart_items WHERE cart_id = $1',
      [cartId]
    )
    const items = itemsResult.rows
    if (items.length === 0) {
      await client.query('ROLLBACK')
      return res.status(400).send('Carrito vacío')
    }

    // 3) Crear orden (metadata debe ser json/jsonb en la tabla orders)
    const orderResult = await client.query(
      `INSERT INTO orders (customer_id, payment_method, metadata)
       VALUES ($1, $2, $3) RETURNING *`,
      [cart.customer_id, payment_method, metadata || {}]
    )
    const order = orderResult.rows[0]

    // 4) Insertar line_items
    for (const item of items) {
      await client.query(
        `INSERT INTO line_items (order_id, product_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4)`,
        [order.id, item.product_id, item.quantity, item.unit_price]
      )
    }

    // 5) Cerrar carrito
    await client.query(
      `UPDATE carts SET completed = true, updated_at = NOW() WHERE id = $1`,
      [cartId]
    )

    await client.query('COMMIT')
    // 6) Responder con algo útil
    return res.status(201).json({ message: 'Orden creada', orderId: order.id })
  } catch (error) {
    await client.query('ROLLBACK')
    console.error(error)
    res.status(500).send('Error al realizar el checkout')
  } finally {
    client.release()
  }
})



app.get('/customers/:customerId/orders', async (req, res) => {
  const { customerId } = req.params

  try {
    const ordersResult = await pool.query(
      `SELECT 
         o.id AS order_id,
         o.created_at,
         o.payment_method,
         o.metadata,
         li.product_id,
         li.quantity,
         li.unit_price,
         p.name AS product_name,
         p.weight
       FROM orders o
       JOIN line_items li ON o.id = li.order_id
       JOIN products p ON li.product_id = p.id
       WHERE o.customer_id = $1
       ORDER BY o.created_at DESC`,
      [customerId]
    )

    const rows = ordersResult.rows

    // Agrupar los productos por orden
    const grouped = {}
    for (const row of rows) {
      if (!grouped[row.order_id]) {
        grouped[row.order_id] = {
          order_id: row.order_id,
          created_at: row.created_at,
          payment_method: row.payment_method,
          metadata: row.metadata,
          items: [],
        }
      }

      grouped[row.order_id].items.push({
        product_id: row.product_id,
        product_name: row.product_name,
        quantity: row.quantity,
        unit_price: row.unit_price,
        weight: row.weight,
      })
    }

    const result = Object.values(grouped)
    res.json(result)
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al obtener el historial de órdenes')
  }
})

app.post('/register', async (req, res) => {
  const { email, password, address = null, first_name = null, last_name = null } = req.body
  if (!email || !password) return res.status(400).json({ error: 'Faltan campos requeridos' })

  try {
    const hashedPassword = await bcrypt.hash(password, 10)
    const { rows } = await pool.query(
      `INSERT INTO customers (email, password, address, first_name, last_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, first_name, last_name, address`,
      [email, hashedPassword, address, first_name, last_name]
    )
    res.status(201).json({ customer: rows[0] })
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Error al registrar el usuario' })
  }
})

app.post('/login', async (req, res) => {
  const { email, password } = req.body

  try {
    const userRes = await pool.query('SELECT * FROM customers WHERE email = $1', [email])

    if (userRes.rows.length === 0) {
      return res.status(400).json({ message: 'Usuario no encontrado' })
    }

    const user = userRes.rows[0]

    const match = await bcrypt.compare(password, user.password)

    if (!match) {
      return res.status(401).json({ message: 'Contraseña incorrecta' })
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: '1h' }
    )

    res.json({ token })
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al iniciar sesión')
  }
})


// Obtener carrito actual (ahora con JOIN a products)
app.get('/cart', authenticateToken, async (req, res) => {
  const customerId = req.user.id

  try {
    const cartRes = await pool.query(
      'SELECT * FROM carts WHERE customer_id = $1 AND completed = false LIMIT 1',
      [customerId]
    )

    if (cartRes.rows.length === 0) {
      return res.json({ cart: null, items: [] })
    }

    const cart = cartRes.rows[0]

    // 👇 Trae nombre e imagen desde products
    const itemsRes = await pool.query(
      `SELECT
         ci.id,
         ci.product_id,
         ci.quantity,
         ci.unit_price,
         p.title      AS title,
         p.image_url AS thumbnail
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       WHERE ci.cart_id = $1`,
      [cart.id]
    )

    res.json({ cart, items: itemsRes.rows })
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al obtener el carrito')
  }
})

// Agregar/actualizar item en carrito (mantengo respuesta de texto)
app.post('/cart/add', authenticateToken, async (req, res) => {
  const customerId = req.user.id
  const { product_id, quantity, unit_price } = req.body

  try {
    let cart = await pool.query(
      'SELECT * FROM carts WHERE customer_id = $1 AND completed = false LIMIT 1',
      [customerId]
    )

    if (cart.rows.length === 0) {
      const newCart = await pool.query(
        'INSERT INTO carts (customer_id) VALUES ($1) RETURNING *',
        [customerId]
      )
      cart = newCart
    }

    const cartId = cart.rows[0].id

    const existing = await pool.query(
      'SELECT id FROM cart_items WHERE cart_id = $1 AND product_id = $2',
      [cartId, product_id]
    )

    if (existing.rows.length > 0) {
      await pool.query(
        'UPDATE cart_items SET quantity = quantity + $1 WHERE cart_id = $2 AND product_id = $3',
        [quantity, cartId, product_id]
      )
    } else {
      await pool.query(
        'INSERT INTO cart_items (cart_id, product_id, quantity, unit_price) VALUES ($1, $2, $3, $4)',
        [cartId, product_id, quantity, unit_price]
      )
    }

    res.send('Producto agregado o actualizado en el carrito')
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al agregar al carrito')
  }
})

// Quitar/disminuir item del carrito (mantengo respuesta de texto)
app.delete('/cart/remove/:itemId', authenticateToken, async (req, res) => {
  const itemId = req.params.itemId
  const customerId = req.user.id

  try {
    const cart = await pool.query(
      'SELECT * FROM carts WHERE customer_id = $1 AND completed = false LIMIT 1',
      [customerId]
    )

    if (cart.rows.length === 0) {
      return res.status(404).send('Carrito no encontrado')
    }

    const cartId = cart.rows[0].id

    const itemRes = await pool.query(
      'SELECT quantity FROM cart_items WHERE id = $1 AND cart_id = $2',
      [itemId, cartId]
    )

    if (itemRes.rows.length === 0) {
      return res.status(404).send('Item no encontrado')
    }

    const quantity = itemRes.rows[0].quantity

    if (quantity > 1) {
      await pool.query('UPDATE cart_items SET quantity = quantity - 1 WHERE id = $1', [itemId])
    } else {
      await pool.query('DELETE FROM cart_items WHERE id = $1', [itemId])
    }

    res.send('Producto actualizado o eliminado del carrito')
  } catch (error) {
    console.error(error)
    res.status(500).send('Error al eliminar del carrito')
  }
})

app.get('/products/category/:slug', async (req, res) => {
  const { slug } = req.params;

  try {
    const categoryRes = await pool.query('SELECT id FROM categories WHERE slug = $1', [slug]);

    if (categoryRes.rows.length === 0) return res.status(404).send('Categoría no encontrada');

    const categoryId = categoryRes.rows[0].id;

    const productRes = await pool.query(
      'SELECT * FROM products WHERE category_id = $1',
      [categoryId]
    );

    res.json(productRes.rows);
  } catch (error) {
    console.error(error);
    res.status(500).send('Error al obtener productos por categoría');
  }
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});

app.get('/health', (req, res) => res.json({ ok: true }))