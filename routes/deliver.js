const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { verifyDeliveryToken } = require('../helpers/deliveryToken');
const { uploadBufferToCloudinary } = require('../helpers/cloudinaryUpload');
const router = express.Router();

// === Config ===
const API_BASE = process.env.API_BASE_URL || 'http://localhost:4000';

const MAX_UPLOAD_MB = Number(process.env.DELIVERY_MAX_MB || 6);
const ALLOWED_MIME = /^(image\/(jpe?g|png|webp|heic|heif))$/i;

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
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const partnerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 120,                  // un poco más laxo para panel interno
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

// GET /deliver/:token → datos mínimos para el formulario
router.get('/:token', async (req, res) => {
  try {
    const decoded = verifyDeliveryToken(req.params.token);
    const ord = await getOrderById(decoded.order_id);
    if (!ord) return res.status(404).json({ ok: false, message: 'Orden no encontrada' });

    const delivered = isDelivered(ord.metadata);
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

      // 1) Idempotencia
      const existing = await client.query(
        `SELECT id FROM delivery_events WHERE order_id = $1 AND client_tx_id = $2 LIMIT 1`,
        [orderId, client_tx_id]
      );
      if (existing.rows.length) {
        await client.query('COMMIT');
        return res.json({ ok: true, order_id: orderId, repeated: true });
      }

      // 2) Estado actual
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
      const forbiddenStates = new Set(['canceled', 'cancelled', 'failed', 'refunded']);
      if (forbiddenStates.has(String(ord.status || '').toLowerCase())) {
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, message: 'La orden no puede entregarse en su estado actual' });
      }

      // 3) Subir foto a Cloudinary
      let photoUrl = null;
      let photoPublicId = null;
      if (req.file) {
        const publicId = `order_${orderId}_${client_tx_id}`;
        const up = await uploadBufferToCloudinary(req.file.buffer, {
          public_id: publicId,
          folder: process.env.CLOUDINARY_FOLDER || 'deliveries',
        });
        photoUrl = up.secure_url;
        photoPublicId = up.public_id;
      }

      // 4) Si ya estaba entregada
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
          photo_public_id: photoPublicId || null,
        });
      }

      // 5) Guardar evento
      await client.query(
        `INSERT INTO delivery_events(order_id, client_tx_id, notes, photo_url)
         VALUES ($1,$2,$3,$4)`,
        [orderId, client_tx_id, notes || null, photoUrl || null]
      );

      // 6) Marcar entregada (+ metadata con public_id)
      const deliveryPatch = {
        ...(meta.delivery || {}),
        delivered: true,
        delivered_at: new Date().toISOString(),
        delivered_by: 'link',
        notes: notes || null,
        photo_url: photoUrl || null,
        photo_public_id: photoPublicId || null,
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
      return res.json({
        ok: true,
        order_id: orderId,
        status: 'delivered',
        photo_url: photoUrl || null,
        photo_public_id: photoPublicId || null,
      });
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