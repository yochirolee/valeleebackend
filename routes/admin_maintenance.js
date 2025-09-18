// routes/admin_maintenance.js
const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/authenticateToken');
const { requireAdmin } = require('../middleware/roles');
const { getMode, setMode } = require('../state/maintenanceState');

router.get('/', authenticateToken, requireAdmin, (_req, res) => {
  res.json({ ok: true, mode: getMode() });
});

router.put('/', authenticateToken, requireAdmin, (req, res) => {
  const { mode } = req.body || {};
  if (!['off', 'admin_only', 'full'].includes(String(mode))) {
    return res.status(400).json({ ok: false, message: 'Modo inválido' });
  }
  setMode(mode);
  res.json({ ok: true, mode });
});

module.exports = router;
