const express = require('express');
const multer = require('multer'); // para multipart (foto)
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');                    // 👈 nuevo
const rateLimit = require('express-rate-limit');   // 👈 nuevo
const { pool } = require('../db');
const { verifyDeliveryToken } = require('../helpers/deliveryToken');

const router = express.Router();

// === Config ===
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
const API_BASE = process.env.API_BASE_URL || 'http://localhost:4000';
const PUBLIC_UPLOAD_BASE = process.env.PUBLIC_UPLOAD_BASE || `${API_BASE}/uploads`;

const MAX_UPLOAD_MB = Number(process.env.DELIVERY_MAX_MB || 6); // 👈 6MB por defecto
const ALLOWED_MIME = /^(image\/(jpe?g|png|webp|heic|heif))$/i;

// crea carpeta si no existe
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// === Multer en memoria + validaciones ===
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.test(file.mimetype || '')) {
      const err = new Error('invalid_type');
      err.code = 'LIMIT_FILE_TYPE';
      return cb(err);
    }
    cb(null, true);
  },
});

// Rate limit básico para confirmar entrega
const confirmLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 60,                  // 60 req por IP
  standardHeaders: true,
  legacyHeaders: false,
});

// Utilidad: leer orden y chequear estado
async function getOrderById(orderId) {
  const { rows } = await pool.query(
    `SELECT id, owner_id, status, metadata
       FROM orders
      WHERE id = $1
      LIMIT 1`,
    [orderId]
  );
  return rows[0] || null;
}

function isDelivered(meta) {
  return Boolean(meta && meta.delivery && meta.delivery.delivered === true);
}

function mimeToExt(m) {
  const mm = String(m || '').toLowerCase();
  if (mm.includes('jpeg') || mm.includes('jpg')) return '.jpg';
  if (mm.includes('png')) return '.png';
  if (mm.includes('webp')) return '.webp';
  if (mm.includes('heic') || mm.includes('heif')) return '.heic';
  return '.jpg';
}

// Procesa y guarda la foto (jpg optimizado). Si falla, guarda original.
async function processAndSavePhoto(file) {
  if (!file) return null;
  const baseName = `proof_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const jpgName = `${baseName}.jpg`;
  const jpgPath = path.join(UPLOAD_DIR, jpgName);

  try {
    await sharp(file.buffer)
      .rotate() // respeta EXIF orientation
      .resize({ width: 1600, withoutEnlargement: true, fit: 'inside' })
      .jpeg({ quality: 78, mozjpeg: true })
      .toFile(jpgPath);
    return jpgName; // éxito como JPG
  } catch (e) {
    // fallback: guarda el buffer original con su extensión
    const fallbackName = `${baseName}${mimeToExt(file.mimetype)}`;
    const fallbackPath = path.join(UPLOAD_DIR, fallbackName);
    try {
      fs.writeFileSync(fallbackPath, file.buffer);
      return fallbackName;
    } catch {
      throw e; // si también falla, propaga
    }
  }
}

// GET /deliver/:token → datos mínimos para el formulario
router.get('/:token', async (req, res) => {
  try {
    const decoded = verifyDeliveryToken(req.params.token);
    const ord = await getOrderById(decoded.order_id);
    if (!ord) return res.status(404).json({ ok: false, message: 'Orden no encontrada' });

    // si ya está entregada → solo lectura
    const delivered = isDelivered(ord.metadata);

    // info esencial para mostrar al mensajero
    const ship = ord.metadata?.shipping || {};
    return res.json({
      ok: true,
      delivered,
      order: {
        id: ord.id,
        owner_id: ord.owner_id || null,
        status: ord.status,
        shipping: {
          country: ship.country,
          address: ship.address || ship.address_line1 || '',
          address2: ship.address_line2 || '',
          city: ship.city || ship.municipality || '',
          state: ship.state || ship.province || '',
          zip: ship.zip || '',
          contact: `${ship.first_name || ''} ${ship.last_name || ''}`.trim(),
          phone: ship.phone || '',
        },
      },
    });
  } catch (e) {
    return res.status(401).json({ ok: false, message: 'Token inválido o vencido' });
  }
});

// Helper para envolver upload y capturar errores de multer
function handleUpload(field) {
  return (req, res, next) => {
    upload.single(field)(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ ok: false, message: `La imagen excede ${MAX_UPLOAD_MB} MB` });
      }
      if (err.code === 'LIMIT_FILE_TYPE' || err.message === 'invalid_type') {
        return res.status(400).json({ ok: false, message: 'Formato no permitido. Usa JPG, PNG, WEBP o HEIC.' });
      }
      console.error('[multer] Error:', err);
      return res.status(400).json({ ok: false, message: 'Error subiendo archivo' });
    });
  };
}

// POST /deliver/confirm
// Campos: token, client_tx_id, notes, photo (multipart)
router.post(
  '/confirm',
  confirmLimiter,
  handleUpload('photo'),
  async (req, res) => {
    const { token, client_tx_id, notes } = req.body || {};
    if (!token || !client_tx_id) {
      return res.status(400).json({ ok: false, message: 'Faltan token o client_tx_id' });
    }

    let decoded;
    try {
      decoded = verifyDeliveryToken(token);
    } catch {
      return res.status(401).json({ ok: false, message: 'Token inválido o vencido' });
    }

    const orderId = decoded.order_id;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1) Idempotencia: si ya existe ese (order_id, client_tx_id) devolvemos 200
      const existing = await client.query(
        `SELECT id FROM delivery_events WHERE order_id = $1 AND client_tx_id = $2 LIMIT 1`,
        [orderId, client_tx_id]
      );
      if (existing.rows.length) {
        await client.query('COMMIT');
        return res.json({ ok: true, order_id: orderId, repeated: true });
      }

      // 2) Ver estado actual y bloquear fila
      const { rows: orows } = await client.query(
        `SELECT id, status, metadata FROM orders WHERE id = $1 FOR UPDATE`,
        [orderId]
      );
      if (!orows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, message: 'Orden no encontrada' });
      }

      const ord = orows[0];
      const meta = ord.metadata || {};

      // Estados donde NO se permite marcar como entregada
      const forbiddenStates = new Set(['canceled', 'cancelled', 'failed', 'refunded']);
      if (forbiddenStates.has(String(ord.status || '').toLowerCase())) {
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, message: 'La orden no puede entregarse en su estado actual' });
      }

      // 3) Si hay foto, procesar y guardar AHORA (ya validamos estado)
      let photoUrl = null;
      if (req.file) {
        const savedName = await processAndSavePhoto(req.file);
        photoUrl = `${PUBLIC_UPLOAD_BASE}/${encodeURIComponent(savedName)}`;
      }

      // 4) Si ya estaba entregada, registra evento idempotente y sal
      if (isDelivered(meta)) {
        await client.query(
          `INSERT INTO delivery_events(order_id, client_tx_id, notes, photo_url)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [orderId, client_tx_id, notes || null, photoUrl || null]
        );
        await client.query('COMMIT');
        return res.json({
          ok: true,
          order_id: orderId,
          already_delivered: true,
          status: 'delivered',
          photo_url: photoUrl || null,
        });
      }

      // 5) Guardar evento
      await client.query(
        `INSERT INTO delivery_events(order_id, client_tx_id, notes, photo_url)
         VALUES ($1,$2,$3,$4)`,
        [orderId, client_tx_id, notes || null, photoUrl || null]
      );

      // 6) Marcar entregada en metadata y status
      const deliveryPatch = {
        ...(meta.delivery || {}),
        delivered: true,
        delivered_at: new Date().toISOString(),
        delivered_by: 'link', // o 'courier'
        notes: notes || null,
        photo_url: photoUrl || null,
      };

      await client.query(
        `UPDATE orders
            SET status = 'delivered',
                metadata = COALESCE(metadata,'{}'::jsonb)
                          || jsonb_build_object('delivery', $2::jsonb)
          WHERE id = $1`,
        [orderId, JSON.stringify(deliveryPatch)]
      );

      await client.query('COMMIT');
      return res.json({ ok: true, order_id: orderId, status: 'delivered', photo_url: photoUrl || null });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[deliver.confirm] Error:', e?.code, e?.message || e);
      return res.status(500).json({ ok: false, message: 'Error registrando entrega' });
    } finally {
      client.release();
    }
  }
);

module.exports = router;
