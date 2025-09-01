const https = require('https')
const http = require('http')

const BMS_URL  = process.env.BMS_URL || 'https://services.bmspay.com'
const MID      = Number(process.env.BMS_MID)
const CID      = Number(process.env.BMS_CID)
const USERNAME = process.env.BMS_USERNAME
const PASSWORD = process.env.BMS_PASSWORD
const APP_TYPE = Number(process.env.BMS_APP_TYPE || 1)
const APP_KEY  = String(process.env.BMS_APP_KEY || '')
const IS_TEST  = String(process.env.BMS_IS_TEST) === 'true'

function creds() {
  return {
    AppKey: APP_KEY,
    AppType: String(APP_TYPE),
    mid: String(MID),
    cid: String(CID),
    UserName: USERNAME || '',
    Password: PASSWORD || '',
    IsTest: String(!!IS_TEST),
  }
}

async function fetchJson(url, opts) {
  const method = (opts && opts.method) || 'GET'
  const baseHeaders =
    method === 'GET'
      ? { Accept: 'application/json' }
      : { 'Content-Type': 'application/json' }

  const res = await fetch(url, {
    ...opts,
    headers: { ...baseHeaders, ...(opts && opts.headers ? opts.headers : {}) },
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  return { ok: res.ok, status: res.status, data }
}

// GET con body x-www-form-urlencoded (replica cURL de Postman)
function fetchJsonGETWithBody(urlStr, formString) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const isHttps = u.protocol === 'https:'
    const client = isHttps ? https : http

    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(formString, 'utf8')
    }

    const req = client.request({
      method: 'GET',
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers
    }, (res) => {
      const chunks = []
      res.on('data', d => chunks.push(d))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let data = null
        try { data = text ? JSON.parse(text) : null } catch { data = null }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data })
      })
    })

    req.on('error', reject)
    req.write(formString)  // body en GET, requerido por el provider
    req.end()
  })
}

function extractGuidFromLink(link) {
  if (typeof link !== 'string') return null
  const m = link.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)
  return m ? m[0] : null
}

async function addPaymentLink({ amount, description, invoiceNumber }) {
  const body = {
    PaymentLink: {
      Amount: amount != null ? Number(amount).toFixed(2) : '0',
      Description: description || null,
      InvoiceNumber: invoiceNumber != null ? String(invoiceNumber) : null,
      Type: amount != null ? 'Fixed' : 'Open',
    },
    AppKey: APP_KEY,
    AppType: APP_TYPE,
    mid: MID,
    cid: CID,
    UserName: USERNAME,
    Password: PASSWORD,
    IsTest: IS_TEST,
  }

  const { ok, status, data } = await fetchJson(`${BMS_URL}/api/PaymentLinks/AddPaymentLink`, {
    method: 'POST',
    body: JSON.stringify(body),
  })

  if (!ok || data?.ResponseCode !== 200) {
    const msg = data?.Msg?.[0] || data?.verbiage || `BMSpay AddPaymentLink HTTP ${status}`
    const err = new Error(msg)
    err.response = data
    throw err
  }

  const pl = data.PaymentLink || {}
  const guid = pl.Id || extractGuidFromLink(pl.Link)

  return {
    id: guid,
    link: pl.Link,
    status: pl.Status,
    amount: pl.Amount,
    invoiceNumber: pl.InvoiceNumber,
    raw: data,
  }
}

// Único endpoint de consulta: /api/PaymentLinks con GET + body x-www-form-urlencoded
async function fetchPaymentLinksByInvoice(invoiceNumber) {
  const q = new URLSearchParams({ ...creds(), InvoiceNumber: String(invoiceNumber) })
  const url = `${BMS_URL}/api/PaymentLinks?${q.toString()}`
  const form = new URLSearchParams({ ...creds(), InvoiceNumber: String(invoiceNumber) }).toString()
  return await fetchJsonGETWithBody(url, form)
}

function statusToBool(st) {
  if (st === 1 || st === '1') return true
  if (typeof st === 'string' && st.toLowerCase() === 'paid') return true
  return false
}

/**
 * Confirmación (sin validar monto):
 *  - Requiere linkId (GUID del PaymentLink).
 *  - InvoiceNumber == orderId
 *  - PaymentLink.Id == linkId
 */
async function getPaymentStatus(key, opts = {}) {
  const idOrInv = String(key || '').trim()
  const invoiceNumber = opts.invoiceNumber != null ? String(opts.invoiceNumber) : idOrInv

  const guidFromParam = opts.linkId ? String(opts.linkId).toLowerCase() : null
  const guidFromLink = extractGuidFromLink(opts.link)
  const guid = (guidFromParam || guidFromLink || '').toLowerCase()

  if (!guid) {
    return { ok: false, paid: false, active: undefined, paymentLink: null, raw: null, error: new Error('link_id requerido para confirmar pago') }
  }

  try {
    const r = await fetchPaymentLinksByInvoice(invoiceNumber)

    if (!r.ok || (r.data?.ResponseCode && r.data.ResponseCode !== 200)) {
      return { ok: false, paid: false, active: undefined, paymentLink: null, raw: r.data || null, error: new Error(r.data?.Msg?.[0] || 'BMS error') }
    }

    const links = Array.isArray(r.data?.PaymentLinks) ? r.data.PaymentLinks : []
    for (let i = links.length - 1; i >= 0; i--) {
      const x = links[i] || {}
      const invStr = String(x.InvoiceNumber || '').trim()
      if (invStr !== invoiceNumber) continue

      const idStr = String(x.Id || '').toLowerCase()
      if (idStr !== guid) continue

      const paid = statusToBool(x.Status)
      return { ok: true, paid, active: x.Active === true, paymentLink: x, raw: r.data }
    }

    return { ok: true, paid: false, active: undefined, paymentLink: null, raw: r.data || null }
  } catch (e) {
    return { ok: false, paid: false, active: undefined, paymentLink: null, raw: null, error: e }
  }
}

function withReturnUrl(link, returnUrl) {
  const url = new URL(link)
  url.searchParams.set('returnUrl', returnUrl)
  return url.toString()
}

module.exports = {
  addPaymentLink,
  getPaymentStatus,
  withReturnUrl,
}
