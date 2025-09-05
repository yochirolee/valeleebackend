const { cloudinary } = require('../config/cloudinary')
const stream = require('stream')

function uploadBufferToCloudinary(buffer, { folder, public_id, quality = 'auto', fetch_format = 'auto' } = {}) {
  return new Promise((resolve, reject) => {
    const passthrough = new stream.PassThrough()
    const upload = cloudinary.uploader.upload_stream(
      {
        folder: folder || process.env.CLOUDINARY_FOLDER || 'uploads',
        public_id,
        resource_type: 'image',
        overwrite: true,
        transformation: [
          { width: 1600, crop: 'limit' },
          { quality },           // q_auto
          { fetch_format }       // f_auto
        ]
      },
      (err, result) => (err ? reject(err) : resolve(result))
    )
    passthrough.end(buffer)
    passthrough.pipe(upload)
  })
}

module.exports = { uploadBufferToCloudinary }
