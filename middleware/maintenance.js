// middleware/maintenance.js
const jwt = require('jsonwebtoken');
const { isAdminUser } = require('./roles'); // ya lo tienes
const { getMode } = require('../state/maintenanceState');

// Helpers
function readBearer(req) {
  const raw = req.headers.authorization || req.headers.Authorization || '';
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s.startsWith('Bearer ') ? s.slice(7) : null;
}

function extractUserIdFromJWT(req) {
  const token = readBearer(req);
  if (!token || !process.env.JWT_SECRET) return null;
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET);
    return p && (p.id || p.sub) ? (p.id || p.sub) : null;
  } catch {
    return null;
  }
}

function pathMatches(path, patterns) {
  return patterns.some((p) => {
    if (p instanceof RegExp) return p.test(path);
    if (typeof p === 'string') {
      if (p.endsWith('*')) return path.startsWith(p.slice(0, -1));
      return path === p;
    }
    return false;
  });
}

/**
 * Guard global de mantenimiento
 * - off         → pasa todo
 * - admin_only  → solo admins, y permite rutas de login para poder entrar
 * - full        → 503 a todo (salvo whitelist mínima, p.ej. /health)
 *
 * Ajusta allowFull/allowAuth si quieres abrir/cerrar más cosas.
 */
function maintenanceGuard(options = {}) {
  const allowFull = options.allowFull || [
    '/health',
    // ⚠️ Si quieres que el admin pueda salir del modo full desde el panel:
    // '/admin/maintenance', // <-- descomenta si no quieres "candado total"
  ];
  const allowAuth = options.allowAuth || [
    // Aquí pon tus rutas de login/refresh si las tienes:
    // '/customers/login', '/customers/refresh'
  ];

  const retrySec = options.retryAfterSec ?? 300;

  return async (req, res, next) => {
    const mode = getMode(); // o lee de ENV si prefieres
    if (mode === 'off') return next();

    // Siempre deja health (y lo que definas en allowFull)
    if (pathMatches(req.path, allowFull)) return next();

    if (mode === 'full') {
      return res
        .status(503)
        .set('Retry-After', String(retrySec))
        .json({ ok: false, error: 'maintenance', mode });
    }

    // admin_only
    if (pathMatches(req.path, allowAuth)) return next();

    const userId = extractUserIdFromJWT(req);
    if (userId && (await isAdminUser(userId))) {
      return next();
    }

    return res
      .status(503)
      .set('Retry-After', String(retrySec))
      .json({
        ok: false,
        error: 'maintenance',
        mode,
        message: 'La tienda está en mantenimiento (solo administradores).',
      });
  };
}

module.exports = maintenanceGuard;
