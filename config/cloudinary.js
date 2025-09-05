const cloudinary = require('cloudinary').v2

// Soporta usar CLOUDINARY_URL (opcional) o las tres variables por separado
if (process.env.CLOUDINARY_URL) {
  cloudinary.config({ secure: true })         // la URL ya trae key/secret/name
} else {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  })
}

module.exports = { cloudinary }
