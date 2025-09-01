// routes/ownerAreas.js
const express = require('express');
const router = express.Router({ mergeParams: true });
const { pool } = require('../db');

// GET /admin/owners/:ownerId/areas
router.get('/', async (req, res) => {
  const ownerId = Number(req.params.ownerId);
  try {
    const { rows } = await pool.query(
      `SELECT id, province, municipality, created_at
         FROM owner_cu_areas
        WHERE owner_id = $1
        ORDER BY province, municipality NULLS FIRST`,
      [ownerId]
    );
    res.json(rows);
  } catch (e) {
    console.error('GET owner areas', e);
    res.status(500).json({ error: 'No se pudo listar áreas' });
  }
});

// POST /admin/owners/:ownerId/areas   body: { province, municipality? }
router.post('/', async (req, res) => {
  const ownerId = Number(req.params.ownerId);
  const { province, municipality } = req.body || {};
  if (!province) return res.status(400).json({ error: 'province requerido' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO owner_cu_areas (owner_id, province, municipality)
       VALUES ($1, $2, NULLIF($3,''))
       ON CONFLICT DO NOTHING
       RETURNING id, province, municipality, created_at`,
      [ownerId, province, municipality || null]
    );
    res.status(201).json(rows[0] || { ok: true });
  } catch (e) {
    console.error('POST owner area', e);
    res.status(500).json({ error: 'No se pudo crear área' });
  }
});

// PUT /admin/owners/:ownerId/areas
// body: { items: [{ province: string, municipality: string|null }, ...] }
router.put('/', async (req, res) => {
  const ownerId = Number(req.params.ownerId);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Limpiamos todas las áreas actuales del owner
    await client.query(`DELETE FROM owner_cu_areas WHERE owner_id = $1`, [ownerId]);

    // Insertamos las nuevas (si trae 0, queda sin áreas permitidas)
    if (items.length > 0) {
      const values = [];
      const params = [];
      let i = 1;
      for (const it of items) {
        if (!it?.province) continue;
        params.push(ownerId, it.province, it.municipality || null);
        values.push(`($${i++}, $${i++}, NULLIF($${i++}, ''))`);
      }
      const sql = `
        INSERT INTO owner_cu_areas (owner_id, province, municipality)
        VALUES ${values.join(',')}
        ON CONFLICT DO NOTHING
      `;
      await client.query(sql, params);
    }

    await client.query('COMMIT');
    res.json({ ok: true, count: items.length });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('PUT owner areas', e);
    res.status(500).json({ error: 'No se pudo guardar áreas' });
  } finally {
    client.release();
  }
});

// DELETE /admin/owners/:ownerId/areas/:areaId
router.delete('/:areaId', async (req, res) => {
  const ownerId = Number(req.params.ownerId);
  const areaId = Number(req.params.areaId);
  try {
    const del = await pool.query(
      `DELETE FROM owner_cu_areas WHERE id = $1 AND owner_id = $2 RETURNING id`,
      [areaId, ownerId]
    );
    if (!del.rows.length) return res.status(404).json({ error: 'No encontrado' });
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE owner area', e);
    res.status(500).json({ error: 'No se pudo eliminar área' });
  }
});

module.exports = router;
