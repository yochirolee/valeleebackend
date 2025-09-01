// helpers.js (o al inicio de index.js)
const path = require('path')
const fs = require('fs').promises

function urlToLocalImgPath(apiBaseUrl, imageUrl) {
  if (!imageUrl) return null
  try {
    const a = new URL(apiBaseUrl)
    const b = new URL(imageUrl)
    if (a.host !== b.host) return null
    const parts = b.pathname.split('/').filter(Boolean) // ['img','file.jpg']
    if (parts.length < 2) return null
    return path.join(process.cwd(), parts[0], parts.slice(1).join('/'))
  } catch {
    return null
  }
}

async function safeUnlink(p) {
  if (!p) return
  try { await fs.unlink(p) } catch {}
}

module.exports = { urlToLocalImgPath, safeUnlink }
