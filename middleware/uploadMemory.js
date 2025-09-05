const multer = require('multer')

const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 6)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const okTypes = ['image/jpeg','image/png','image/webp','image/heic','image/heif']
    if (!okTypes.includes(file.mimetype)) return cb(new Error('Formato no permitido'))
    cb(null, true)
  }
})

module.exports = { upload }
