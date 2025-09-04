const express = require('express')
const router = express.Router()
const { pool } = require('../db')
const authenticateToken = require('../middleware/authenticateToken')
const { requireAdmin } = require('../middleware/roles')

// Público
router.get('/categories', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, slug, name, image_url FROM categories ORDER BY name')
    res.json(rows)
  } catch (e) {
    console.error(e); res.status(500).send('Error al listar categorías')
  }
})

// Admin create
router.post('/admin/categories', authenticateToken, requireAdmin, async (req, res) => {
  const { slug, name, image_url } = req.body
  if (!slug || !name) return res.status(400).json({ error: 'slug y name son requeridos' })
  try {
    const { rows } = await pool.query(
      'INSERT INTO categories (slug, name, image_url) VALUES ($1, $2, $3) RETURNING id, slug, name, image_url',
      [slug, name, image_url || null]
    )
    res.status(201).json(rows[0])
  } catch (e) {
    console.error(e); res.status(500).send('Error al crear categoría')
  }
})

router.put('/admin/categories/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { slug, name, image_url } = req.body
  try {
    const { rows } = await pool.query(
      `UPDATE categories
          SET slug = COALESCE($1, slug),
              name = COALESCE($2, name),
              image_url = COALESCE($3, image_url)
        WHERE id = $4
        RETURNING id, slug, name, image_url`,
      [slug ?? null, name ?? null, image_url ?? null, req.params.id]
    )
    if (!rows.length) return res.status(404).send('Categoría no encontrada')
    res.json(rows[0])
  } catch (e) {
    console.error(e); res.status(500).send('Error al actualizar categoría')
  }
})

router.delete('/admin/categories/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM categories WHERE id=$1', [req.params.id])
    if (!rowCount) return res.status(404).send('Categoría no encontrada')
    res.sendStatus(204)
  } catch (e) {
    console.error(e); res.status(500).send('Error al eliminar categoría (puede tener productos)')
  }
})

module.exports = router
