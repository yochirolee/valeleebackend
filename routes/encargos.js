// routes/encargos.js
const express = require('express')
const router = express.Router()
const { pool } = require('../db')
const authenticateToken = require('../middleware/authenticateToken')

// ====================== CONFIG / CONSTANTES ======================
const CARD_FEE_PCT = Number(process.env.CARD_FEE_PCT || process.env.NEXT_PUBLIC_CARD_FEE_PCT || 3)
const FEE_RATE = Number.isFinite(CARD_FEE_PCT) ? CARD_FEE_PCT / 100 : 0

// Owner por defecto para “encargos”
const ENCARGOS_OWNER_NAME = (process.env.ENCARGOS_OWNER_NAME || 'valelee').trim()
const ENCARGOS_OWNER_EMAIL = (process.env.ENCARGOS_OWNER_EMAIL || '').trim() || null

// ====================== HELPERS GENERALES ======================
const toCents = (n) => Math.max(0, Math.round(Number(n || 0) * 100))
const centsToUsd = (c) => Number(((Number(c || 0)) / 100).toFixed(2))
const num = (v) => (v == null ? 0 : Number(v))
const safeJson = (v, fallback = {}) => {
  try { return JSON.parse(JSON.stringify(v ?? fallback)) } catch { return fallback }
}

// Zona Cuba, consistente con el flujo normal
function zoneKeyForCuba(province, area_type) {
  const isHabana = String(province || '').trim().toLowerCase() === 'la habana'
  const isCity = String(area_type || '').toLowerCase() === 'city'
  if (isHabana) return isCity ? 'habana_city' : 'habana_municipio'
  return isCity ? 'provincias_city' : 'provincias_municipio'
}

// ====================== HELPERS DE CAPTURA/RESOLVE ======================
function detectSource(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./, '').toLowerCase()
    if (h === 'a.co' || /(^|\.)amazon\./i.test(h)) return 'amazon'
    if (/(^|\.)shein\./i.test(h)) return 'shein'
  } catch { }
  return 'unknown'
}

function extractSheinIdFromUrl(u) {
  try {
    const p = new URL(u).pathname
    // patrones comunes: /p/12345678.html | /pdp/...-p-12345678.html
    const m = p.match(/(?:^|[-\/])p-?(\d{6,})\.html/i) || p.match(/\/p\/(\d{6,})\.html/i)
    return m?.[1] || null
  } catch { return null }
}

function extractAsinFromUrl(u) {
  try {
    const url = new URL(u)
    const p = url.pathname
    const m = p.match(/\/(?:dp|gp\/product|gp\/aw\/d|-\s*\/dp)\/([A-Z0-9]{10})(?:[/?]|$)/i)
    if (m?.[1]) return m[1].toUpperCase()
    const qp = url.searchParams.get('asin')
    if (qp && /^[A-Z0-9]{10}$/i.test(qp)) return qp.toUpperCase()
    return null
  } catch { return null }
}

const pick = (re, html) => {
  const m = html.match(re)
  return m && m[1] ? String(m[1]).trim() : null
}

function tryTitle(html) {
  return (
    pick(/<span[^>]+id=['"]productTitle['"][^>]*>\s*([^<]+)\s*<\/span>/i, html) ||
    pick(/<meta[^>]+property=['"]og:title['"][^>]*content=['"]([^"']+)['"]/i, html) ||
    (pick(/<title>([^<]+)<\/title>/i, html)?.replace(/\s+Amazon\.com.*$/i, '').trim() || null)
  )
}

function tryImage(html) {
  return (
    pick(/<meta[^>]+property=['"]og:image['"][^>]*content=['"]([^"']+)['"]/i, html) ||
    pick(/"hiRes"\s*:\s*"([^"]+)"/i, html) ||
    pick(/"large"\s*:\s*"([^"]+)"/i, html) ||
    pick(/<img[^>]+id=['"]landingImage['"][^>]*src=['"]([^"']+)['"]/i, html)
  )
}



// Normaliza "$1,234.56" o "1.234,56" -> 1234.56
function toNumberOrNull(raw) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  const n1 = Number(s.replace(/[^\d.-]/g, ''))
  if (Number.isFinite(n1)) return n1
  const n2 = Number(s.replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, ''))
  return Number.isFinite(n2) ? n2 : null
}

// ====================== HELPERS DB / SNAPSHOT ======================
async function getUserEncargos(client, customerId) {
  const { rows } = await client.query(
    `SELECT id, source, external_id, asin, source_url, title, image_url, price_estimate, currency, created_at
       FROM pending_encargos
      WHERE customer_id = $1
      ORDER BY created_at ASC`,
    [customerId]
  )
  return rows
}

function buildTotalsSnapshot(encargosRows, shippingCents) {
  const items = (encargosRows || []).map(r => ({
    id: r.id,
    source: r.source || 'unknown',
    external_id: r.external_id || null,
    asin: r.asin || null,
    source_url: r.source_url || null,
    title: r.title || null,
    image_url: r.image_url || null,
    price_estimate: r.price_estimate == null ? null : Number(r.price_estimate),
    currency: r.currency || 'USD',
    quantity: 1,
  }))

  const subtotalCents = items.reduce((acc, it) => acc + toCents(it.price_estimate), 0)
  const taxCents = 0
  const shipping_cents = Number(shippingCents || 0)
  const grand_total_cents = subtotalCents + taxCents + shipping_cents

  return {
    kind: 'encargos',
    items,
    subtotal_cents: subtotalCents,
    tax_cents: taxCents,
    shipping_cents,
    grand_total_cents,
    currency: 'USD',
  }
}

async function createCheckoutSession(client, {
  customerId,
  amount_total_cents,
  snapshot,
  payment_method = 'bmspay',
  metadata = {},
}) {
  const { rows } = await client.query(
    `INSERT INTO checkout_sessions
       (customer_id, cart_id, status, amount_total, currency, snapshot, metadata, payment_method)
     VALUES ($1, NULL, 'pending', $2, 'USD', $3::jsonb, $4::jsonb, $5)
     RETURNING id`,
    [customerId, (amount_total_cents / 100), JSON.stringify(snapshot), JSON.stringify(metadata), payment_method]
  )
  return rows[0]?.id
}

// ====================== OWNER “ENCARGOS” + SHIPPING POR CONFIG ======================
async function getEncargosOwner(client) {
  const { rows } = await client.query(
    `
    SELECT id, name, email
      FROM owners
     WHERE lower(name) = lower($1::text)
        OR ($2::text IS NOT NULL AND lower(email) = lower($2::text))
     ORDER BY id ASC
     LIMIT 1
    `,
    [ENCARGOS_OWNER_NAME, ENCARGOS_OWNER_EMAIL]
  )
  return rows[0] || null
}

/**
 * Calcula envío de Encargos usando owner_shipping_config del owner por defecto.
 * Respeta lista blanca (owner_cu_areas) y modos fixed/by_weight.
 * Peso estimado se asume 0 (puedes ajustarlo en el futuro).
 *
 * => { ok: true, shipping_total_cents, breakdown } |
 *    { ok: false, message?, unavailable?: [{owner_id, owner_name}] }
 */
async function computeEncargosShipping(client, shipping) {
  if (!shipping || !shipping.country) {
    return { ok: false, message: 'shipping_required' }
  }

  const owner = await getEncargosOwner(client)
  if (!owner) {
    return { ok: false, message: 'encargos_owner_not_found' }
  }

  const country = String(shipping.country || '').toUpperCase()
  const zoneKey = country === 'CU'
    ? zoneKeyForCuba(shipping.province, shipping.area_type)
    : null

  // Config activa del owner para el país
  const { rows: cfgRows } = await client.query(
    `SELECT *
       FROM owner_shipping_config
      WHERE owner_id = $1
        AND country = $2
        AND active = true
      LIMIT 1`,
    [owner.id, country]
  )
  if (!cfgRows.length) {
    return { ok: false, message: 'no_shipping_config' }
  }
  const cfg = cfgRows[0]

  // Lista blanca Cuba
  if (country === 'CU' && cfg.cu_restrict_to_list === true) {
    const p = String(shipping.province || '').toLowerCase()
    const m = String(shipping.municipality || '').toLowerCase()
    const { rows: wl } = await client.query(
      `SELECT 1
         FROM owner_cu_areas
        WHERE owner_id = $1
          AND lower(province) = $2
          AND (municipality IS NULL OR lower(municipality) = $3)
        LIMIT 1`,
      [owner.id, p, m]
    )
    if (!wl.length) {
      return {
        ok: false,
        unavailable: [{ owner_id: owner.id, owner_name: owner.name || 'Encargos' }],
      }
    }
  }

  // Peso estimado para encargos (0 por ahora)
  const weightLb = 0
  let cents = 0
  let mode = 'none'

  if (country === 'US') {
    const usd = Number(cfg.us_flat || 0)
    cents = toCents(usd)
    mode = 'fixed'
  } else if (country === 'CU') {
    const modeRaw = String(cfg.mode || 'fixed').toLowerCase()
    if (modeRaw === 'fixed') {
      mode = 'fixed'
      const usd =
        zoneKey === 'habana_city' ? Number(cfg.cu_hab_city_flat || 0) :
          zoneKey === 'habana_municipio' ? Number(cfg.cu_hab_rural_flat || 0) :
            zoneKey === 'provincias_city' ? Number(cfg.cu_other_city_flat || 0) :
              zoneKey === 'provincias_municipio' ? Number(cfg.cu_other_rural_flat || 0) : 0
      cents = toCents(usd)
    } else {
      mode = 'by_weight'
      const rate = Number(cfg.cu_rate_per_lb || 0)
      const base =
        zoneKey === 'habana_city' ? Number(cfg.cu_hab_city_base || 0) :
          zoneKey === 'habana_municipio' ? Number(cfg.cu_hab_rural_base || 0) :
            zoneKey === 'provincias_city' ? Number(cfg.cu_other_city_base || 0) :
              zoneKey === 'provincias_municipio' ? Number(cfg.cu_other_rural_base || 0) : 0

      const minFee = Number(cfg.cu_min_fee || 0)
      const usd = base + rate * (Number(weightLb) || 0)
      cents = toCents(Math.max(usd, minFee))
    }
  } else {
    return { ok: false, message: 'country_not_supported' }
  }

  return {
    ok: true,
    shipping_total_cents: cents,
    breakdown: [{
      owner_id: owner.id,
      owner_name: owner.name || 'Encargos',
      mode,
      weight_lb: Number(weightLb.toFixed ? weightLb.toFixed(2) : weightLb) || 0,
      shipping_cents: cents,
    }]
  }
}

// routes/encargos.resolve.js
// Requiere Node 18+ (tiene fetch global). En Node <18 instala `node-fetch` y haz: const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args))

// ========= Helpers =========


function normalizePriceDisplayed(value, currencyHint) {
  if (value == null) return null
  const s = String(value).trim()
  if (!s) return null

  // si ya viene con símbolo + dígitos, respétalo
  if (/[$€£]\s*\d/.test(s)) return s

  let num = s.replace(/[^\d.,-]/g, '')
  const hasDot = num.includes('.')
  const hasComma = num.includes(',')

  if (hasDot && hasComma && /,\d{2}$/.test(num)) {
    // 1.234,56 -> 1234.56
    num = num.replace(/\./g, '').replace(',', '.')
  } else if (hasComma && !hasDot) {
    // 1234,56 -> 1234.56
    num = num.replace(',', '.')
  } else {
    // 1,234.56 -> 1234.56
    num = num.replace(/,/g, '')
  }

  const n = Number(num)
  if (!Number.isFinite(n)) return s

  const cur = (currencyHint || 'USD').toUpperCase()
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(n)
  } catch {
    const sym = cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : '$'
    return `${sym}${n.toFixed(2)}`
  }
}

function detectSource(u) {
  try {
    const h = new URL(u).hostname.toLowerCase()
    if (h.includes('amazon.')) return 'amazon'
    if (h.includes('shein.')) return 'shein'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

function extractAsinFromUrl(u) {
  try {
    const url = new URL(u)
    const m1 = url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|-\s*\/dp)\/([A-Z0-9]{10})(?:[/?]|$)/i)
    if (m1 && m1[1]) return m1[1].toUpperCase()
    const asinParam = url.searchParams.get('asin')
    if (asinParam && /^[A-Z0-9]{10}$/i.test(asinParam)) return asinParam.toUpperCase()
    return null
  } catch {
    return null
  }
}

function tryImage(html) {
  const dyn =
    pick(/id=["']landingImage["'][^>]*\sdata-a-dynamic-image=["']([^"']+)["']/i, html) ||
    pick(/data-a-dynamic-image=["']([^"']+)["'][^>]*id=["']landingImage["']/i, html) ||
    pick(/class=["'][^"']*imgTagWrapper[^"']*["'][\s\S]*?data-a-dynamic-image=["']([^"']+)["']/i, html)

  if (dyn) {
    try {
      const json = JSON.parse(dyn.replace(/&quot;/g, '"'))
      const urls = Object.keys(json || {})
      if (urls.length) {
        urls.sort((a, b) => (json[b]?.[0] || 0) - (json[a]?.[0] || 0))
        return urls[0]
      }
    } catch { }
  }

  return (
    pick(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i, html) ||
    pick(/<img[^>]+id=["']landingImage["'][^>]*\ssrc=["']([^"']+)["']/i, html) ||
    null
  )
}

function tryPrice(html) {
  const currencyHint =
    pick(/<meta\s+itemprop=["']priceCurrency["']\s+content=["']([A-Z]{3})["']/i, html) ||
    pick(/"priceCurrency"\s*:\s*"([A-Z]{3})"/i, html) ||
    pick(/"currencyCode"\s*:\s*"([A-Z]{3})"/i, html) ||
    undefined

  // 0) JSON embebido “to pay”
  const p2pJson =
    pick(/"apexPriceToPay"[\s\S]*?"displayPrice"\s*:\s*"([^"]+)"/i, html) ||
    pick(/"priceToPay"[\s\S]*?"displayPrice"\s*:\s*"([^"]+)"/i, html) ||
    pick(/"currentPrice"[\s\S]*?"priceString"\s*:\s*"([^"]+)"/i, html)
  if (p2pJson) {
    const norm = normalizePriceDisplayed(p2pJson, currencyHint)
    console.log('[tryPrice] JSON priceToPay/currentPrice:', p2pJson, '=>', norm)
    if (norm) return norm
  }

  // 0.b) Otros JSON modernos (rebajado)
  const jsonOpt =
    pick(/"buyingOptionSectionData"[\s\S]*?"priceAmount"\s*:\s*"([^"]+)"/i, html) ||
    pick(/"priceInfo"[\s\S]*?"finalPrice"[\s\S]*?"amount"\s*:\s*"([^"]+)"/i, html)
  if (jsonOpt) {
    const norm = normalizePriceDisplayed(jsonOpt, currencyHint)
    console.log('[tryPrice] JSON buyingOption/priceInfo:', jsonOpt, '=>', norm)
    if (norm) return norm
  }

  // 1) corePriceDisplay_...
  const coreBlock = html.match(/id=["']corePriceDisplay_[^"']*["'][\s\S]{0,2500}?<\/span>/i)
  if (coreBlock && coreBlock[0]) {
    const off = pick(/class=["'][^"']*a-offscreen[^"']*["'][^>]*>([^<]+)<\/span>/i, coreBlock[0])
    if (off) {
      const norm = normalizePriceDisplayed(off, currencyHint)
      console.log('[tryPrice] corePriceDisplay a-offscreen:', off, '=>', norm)
      if (norm) return norm
    }
    // aria-hidden dentro del core
    const hidden = coreBlock[0].match(/<span[^>]*aria-hidden=["']true["'][^>]*>([\s\S]*?)<\/span>/i)
    if (hidden && hidden[1]) {
      let txt = hidden[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      txt = txt.replace(/\s*\.\s*/g, '.')
      const mnum = txt.match(/([$€£]?\s*\d[\d,]*([.]\d{2})?)/)
      if (mnum) {
        const norm = normalizePriceDisplayed(mnum[0], currencyHint)
        console.log('[tryPrice] corePriceDisplay aria-hidden:', txt, '=>', norm)
        if (norm) return norm
      }
    }
  }

  // 2) Bloques .a-price (excluye list price)
  const priceBlocks = [...html.matchAll(/<span[^>]*class=["'][^"']*a-price[^"']*["'][^>]*>([\s\S]*?)<\/span>/ig)]
  for (const m of priceBlocks) {
    const block = m[0]
    if (/a-text-price/.test(block)) continue

    // 2.a) a-offscreen directo
    const off = pick(/class=["'][^"']*a-offscreen[^"']*["'][^>]*>([^<]+)<\/span>/i, block)
    if (off) {
      const norm = normalizePriceDisplayed(off, currencyHint)
      console.log('[tryPrice] a-price a-offscreen:', off, '=>', norm)
      if (norm) return norm
    }

    // 2.b) aria-hidden “compuesto”
    const hiddenMatch = block.match(/<span[^>]*aria-hidden=["']true["'][^>]*>([\s\S]*?)<\/span>/i)
    if (hiddenMatch && hiddenMatch[1]) {
      let txt = hiddenMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      txt = txt.replace(/\s*\.\s*/g, '.')
      const mnum = txt.match(/([$€£]?\s*\d[\d,]*([.]\d{2})?)/)
      if (mnum) {
        const norm = normalizePriceDisplayed(mnum[0], currencyHint)
        console.log('[tryPrice] a-price aria-hidden:', txt, '=>', norm)
        if (norm) return norm
      } else {
        console.log('[tryPrice] a-price aria-hidden (sin número claro):', txt)
      }
    }

    // 2.c) whole + fraction (clásico)
    const whole = pick(/class=["'][^"']*a-price-whole[^"']*["'][^>]*>([^<]+)</i, block)
    const frac  = pick(/class=["'][^"']*a-price-fraction[^"']*["'][^>]*>([^<]+)</i, block)
    if (whole) {
      const raw = `${whole.replace(/[^\d.,]/g, '')}${frac ? '.' + String(frac).replace(/[^\d]/g, '') : ''}`
      const norm = normalizePriceDisplayed(frac ? raw : whole + '.00', currencyHint)
      console.log('[tryPrice] a-price whole/fraction:', whole, frac, '=>', norm)
      if (norm) return norm
    }
  }

  // 3) Legacy ids
  const legacyIds = ['priceblock_dealprice', 'priceblock_saleprice', 'priceblock_ourprice']
  for (const id of legacyIds) {
    const p = pick(new RegExp(`id=["']${id}["'][^>]*>([\\s\\S]*?)<`, 'i'), html)
    if (p) {
      const norm = normalizePriceDisplayed(p, currencyHint)
      console.log('[tryPrice] legacy id', id, ':', p, '=>', norm)
      if (norm) return norm
    }
  }

  // 4) Fallback global .a-offscreen
  const anyOff = pick(/class=["'][^"']*a-offscreen[^"']*["'][^>]*>([^<]+)<\/span>/i, html)
  if (anyOff) {
    const norm = normalizePriceDisplayed(anyOff, currencyHint)
    console.log('[tryPrice] fallback a-offscreen:', anyOff, '=>', norm)
    if (norm) return norm
  }

  // 5) Microdata itemprop=price
  const itemProp = pick(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i, html)
  if (itemProp) {
    const norm = normalizePriceDisplayed(itemProp, currencyHint)
    console.log('[tryPrice] microdata itemprop=price:', itemProp, '=>', norm)
    if (norm) return norm
  }

  console.log('[tryPrice] no price found')
  return null
}



function tryCompareAtPrice(html) {
  const currencyHint =
    pick(/<meta\s+itemprop=["']priceCurrency["']\s+content=["']([A-Z]{3})["']/i, html) ||
    pick(/"priceCurrency"\s*:\s*"([A-Z]{3})"/i, html) ||
    pick(/"currencyCode"\s*:\s*"([A-Z]{3})"/i, html) ||
    undefined

  // 1) Bloque a-text-price (list price tachado)
  const block = html.match(/<span[^>]*class=["'][^"']*a-price[^"']*a-text-price[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)
  if (block && block[0]) {
    const off = pick(/class=["'][^"']*a-offscreen[^"']*["'][^>]*>([^<]+)<\/span>/i, block[0])
    if (off) {
      console.log('[tryCompareAtPrice] a-text-price offscreen:', off)
      const norm = normalizePriceDisplayed(off, currencyHint)
      if (norm) return norm
    }
    // Whole + fraction en el bloque tachado
    const whole = pick(/class=["'][^"']*a-price-whole[^"']*["'][^>]*>([^<]+)</i, block[0])
    const frac = pick(/class=["'][^"']*a-price-fraction[^"']*["'][^>]*>([^<]+)</i, block[0])
    if (whole) {
      const composed = `${whole.replace(/[^\d.,]/g, '')}.${(frac || '00').replace(/[^\d]/g, '').padStart(2, '0')}`
      console.log('[tryCompareAtPrice] a-text-price whole/fraction:', composed)
      const norm = normalizePriceDisplayed(composed, currencyHint)
      if (norm) return norm
    }
  }

  // 2) JSON: listPrice / wasPrice / rrp / regularPrice
  const jsonList =
    pick(/"listPrice"\s*:\s*"([0-9][0-9.,]*)"/i, html) ||
    pick(/"wasPrice"\s*:\s*"([0-9][0-9.,]*)"/i, html) ||
    pick(/"rrp"\s*:\s*"([0-9][0-9.,]*)"/i, html) ||
    pick(/"regularPrice"\s*:\s*"([0-9][0-9.,]*)"/i, html)
  if (jsonList) {
    console.log('[tryCompareAtPrice] JSON list/was/rrp:', jsonList)
    const norm = normalizePriceDisplayed(jsonList, currencyHint)
    if (norm) return norm
  }

  // 3) Legacy id (raro)
  const legacy = pick(/id=["']priceblock_ourprice["'][^>]*>([\s\S]*?)</i, html)
  if (legacy) {
    console.log('[tryCompareAtPrice] legacy ourprice:', legacy)
    const norm = normalizePriceDisplayed(legacy, currencyHint)
    if (norm) return norm
  }

  console.log('[tryCompareAtPrice] no compare-at found')
  return null
}



// ========= Endpoint =========
router.post('/resolve', async (req, res) => {
  try {
    const { url } = req.body || {}
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ ok: false, error: 'url_required' })
    }

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    }

    const resp = await fetch(url, { redirect: 'follow', headers })
    const finalUrl = resp.url || url
    const source = detectSource(finalUrl)

    let html = ''
    const ct = resp.headers.get('content-type') || ''
    if (ct.includes('text/html')) {
      html = await resp.text()
      // a veces Amazon codifica &quot; en atributos JSON
      html = html.replace(/&amp;quot;/g, '&quot;')
    }

    let external_id = null
    let title = null
    let image = null
    let price = null
    let currency = 'USD'
    let compare_at_price = null

    if (source === 'amazon') {
      const asinFromUrl = extractAsinFromUrl(finalUrl)
      const asinFromHtmlMatch = html.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i)
      const asinFromHtml = asinFromHtmlMatch && asinFromHtmlMatch[1] ? asinFromHtmlMatch[1] : null
      external_id = (asinFromUrl || asinFromHtml || '').toUpperCase() || null

      title = html ? tryTitle(html) : null
      image = html ? tryImage(html) : null
      price = html ? tryPrice(html) : null
      compare_at_price = html ? tryCompareAtPrice(html) : null

      currency =
        pick(/<meta\s+itemprop=["']priceCurrency["']\s+content=["']([A-Z]{3})["']/i, html) ||
        pick(/"priceCurrency"\s*:\s*"([A-Z]{3})"/i, html) ||
        pick(/"currencyCode"\s*:\s*"([A-Z]{3})"/i, html) ||
        'USD'
    } else if (source === 'shein') {
      external_id = extractSheinIdFromUrl(finalUrl) ||
        pick(/"goods_id"\s*:\s*"?(\d{6,})"?/i, html) ||
        null

      title =
        pick(/<meta[^>]+property=['"]og:title['"][^>]*content=['"]([^"']+)['"]/i, html) ||
        pick(/<title>([^<]+)<\/title>/i, html)
      image = pick(/<meta[^>]+property=['"]og:image['"][^>]*content=['"]([^"']+)['"]/i, html)

      const sheinPrice =
        pick(/<meta[^>]+property=['"]product:price:amount['"][^>]*content=['"]([^"']+)['"]/i, html) ||
        pick(/"retailPrice"\s*:\s*"?([\d\.,]+)"?/i, html)
      price = normalizePriceDisplayed(sheinPrice, 'USD')
      currency = 'USD'
    } else {
      title =
        pick(/<meta[^>]+property=['"]og:title['"][^>]*content=['"]([^"']+)['"]/i, html) ||
        pick(/<title>([^<]+)<\/title>/i, html)
      image = pick(/<meta[^>]+property=['"]og:image['"][^>]*content=['"]([^"']+)['"]/i, html)
    }

    const asin = source === 'amazon' ? external_id : null

    return res.json({
      ok: true,
      source,
      finalUrl,
      external_id,
      asin,
      title,
      image,
      price,
      compare_at_price,
      currency,
    })
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'resolve_failed' })
  }
})

// ---- POST /encargos/capture (auth) ----
router.post('/capture', authenticateToken, async (req, res) => {
  try {
    const {
      source = 'amazon',
      external_id,
      source_url,
      title,
      image_url,
      price_estimate,
      currency = 'USD',
      asin, // compat amazon
    } = req.body

    if ((!external_id && !asin) && !source_url) {
      return res.status(400).json({ ok: false, error: 'id_or_url_required' })
    }

    const price_num = toNumberOrNull(price_estimate)
    const customerId = req.user?.id ?? null
    if (!customerId) return res.status(401).json({ ok: false, error: 'unauthorized' })

    const extId = external_id || (source === 'amazon' ? (asin || null) : null)

    const q = `
      INSERT INTO pending_encargos
        (customer_id, source, external_id, asin, source_url, title, image_url, price_estimate, currency)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `
    const vals = [
      customerId,
      source,
      extId,
      source === 'amazon' ? (asin || extId || null) : null,
      source_url || null,
      title || null,
      image_url || null,
      price_num,
      currency || 'USD',
    ]
    const { rows } = await pool.query(q, vals)
    return res.json({ ok: true, id: rows[0].id })
  } catch (e) {
    console.error('[encargos/capture] DB error:', e.code, e.message, e.detail)
    return res.status(500).json({ ok: false, message: 'Error capturando encargo' })
  }
})

// ---- GET /encargos/mine (auth) ----
router.get('/mine', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, source, external_id, asin, source_url, title, image_url, price_estimate, currency, created_at
         FROM pending_encargos
        WHERE customer_id = $1
        ORDER BY created_at DESC`,
      [req.user.id]
    )
    return res.json({ ok: true, items: rows })
  } catch {
    return res.status(500).json({ ok: false, message: 'Error listando encargos' })
  }
})

// ---- POST /encargos/create-order (auth) ----
router.post('/create-order', authenticateToken, async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const { rows: enc } = await client.query(
      `SELECT id, source, external_id, asin, source_url, title, image_url, price_estimate, currency
         FROM pending_encargos
        WHERE customer_id = $1
        ORDER BY created_at ASC`,
      [req.user.id]
    )
    if (!enc.length) {
      await client.query('ROLLBACK')
      return res.status(400).json({ ok: false, message: 'No hay encargos' })
    }

    const subtotal = enc.reduce((acc, it) => acc + (Number(it.price_estimate) || 0), 0)

    const sourcesSet = new Set(enc.map(it => it.source || 'unknown'))
    const ord = await client.query(
      `INSERT INTO orders (customer_id, customer_name, total, status, payment_method, metadata)
       VALUES ($1, NULL, $2, 'pending', 'encargo',
         jsonb_build_object('source','external_encargo','sources', $3::jsonb)
       )
       RETURNING id`,
      [req.user.id, subtotal, JSON.stringify(Array.from(sourcesSet))]
    )
    const orderId = ord.rows[0].id

    for (const it of enc) {
      const md = {
        external: true,
        source: it.source || 'unknown',
        external_id: it.external_id || null,
        asin: it.asin || null,
        source_url: it.source_url || null,
        title: it.title || null,
        image_url: it.image_url || null,
        currency: it.currency || 'USD',
      }
      await client.query(
        `INSERT INTO line_items (order_id, product_id, quantity, unit_price, metadata)
         VALUES ($1, NULL, 1, $2, $3::jsonb)`,
        [orderId, Number(it.price_estimate) || 0, JSON.stringify(md)]
      )
    }

    await client.query(`DELETE FROM pending_encargos WHERE customer_id = $1`, [req.user.id])

    await client.query('COMMIT')
    return res.json({ ok: true, order_id: orderId })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('[encargos/create-order] error:', e.code, e.message, e.detail)
    return res.status(500).json({ ok: false, message: 'No se pudo crear la orden' })
  } finally {
    client.release()
  }
})

// ---- POST /encargos/remove (auth) ----
router.post('/remove', authenticateToken, async (req, res) => {
  try {
    const customerId = req.user?.id;
    if (!customerId) {
      return res.status(401).json({ ok: false, message: 'unauthorized' });
    }

    const { id, ids, all } = req.body || {};
    let removed = 0;
    let removedIds = [];

    if (all === true) {
      const { rows } = await pool.query(
        `DELETE FROM pending_encargos
          WHERE customer_id = $1
          RETURNING id`,
        [customerId]
      );
      removed = rows.length;
      removedIds = rows.map(r => r.id);
      return res.json({ ok: true, removed, ids: removedIds });
    }

    const idList = Array.isArray(ids)
      ? ids.map(n => Number(n)).filter(Number.isFinite)
      : (Number.isFinite(Number(id)) ? [Number(id)] : []);

    if (idList.length === 0) {
      return res.status(400).json({ ok: false, message: 'id_or_ids_required' });
    }

    const { rows } = await pool.query(
      `DELETE FROM pending_encargos
        WHERE customer_id = $1
          AND id = ANY($2::int[])
        RETURNING id`,
      [customerId, idList]
    );

    removed = rows.length;
    removedIds = rows.map(r => r.id);
    return res.json({ ok: true, removed, ids: removedIds });
  } catch (e) {
    console.error('[encargos/remove] error:', e);
    return res.status(500).json({ ok: false, message: 'remove_failed' });
  }
});

// ---- POST /encargos/quote (auth) ----
router.post('/quote', authenticateToken, async (req, res) => {
  const client = await pool.connect()
  try {
    const customerId = req.user?.id
    if (!customerId) return res.status(401).json({ ok: false, message: 'unauthorized' })

    const { shipping } = req.body || {}
    if (!shipping || !shipping.country) {
      return res.status(400).json({ ok: false, message: 'shipping_required' })
    }

    const encargos = await getUserEncargos(client, customerId)
    if (!encargos.length) {
      return res.status(400).json({ ok: false, message: 'no_pending_encargos' })
    }

    const quote = await computeEncargosShipping(client, shipping)
    if (!quote.ok) {
      if (Array.isArray(quote.unavailable) && quote.unavailable.length) {
        return res.status(409).json({
          ok: false,
          message: 'Envío no disponible para la dirección seleccionada',
          unavailable: quote.unavailable,
        })
      }
      return res.status(409).json({ ok: false, message: quote.message || 'quote_failed' })
    }

    return res.json({
      ok: true,
      shipping_total_cents: quote.shipping_total_cents,
      breakdown: quote.breakdown,
    })
  } catch (e) {
    console.error('[encargos/quote] error:', e)
    return res.status(500).json({ ok: false, message: 'quote_failed' })
  } finally {
    client.release()
  }
})

// ---- POST /encargos/checkout (auth) ----
router.post('/checkout', authenticateToken, async (req, res) => {
  const client = await pool.connect()
  try {
    const customerId = req.user?.id
    if (!customerId) return res.status(401).json({ ok: false, message: 'unauthorized' })

    const { shipping, locale, metadata = {} } = req.body || {}
    if (!shipping || !shipping.country) {
      return res.status(400).json({ ok: false, message: 'shipping_required' })
    }

    const encargos = await getUserEncargos(client, customerId)
    if (!encargos.length) {
      return res.status(400).json({ ok: false, message: 'no_pending_encargos' })
    }

    const q = await computeEncargosShipping(client, shipping)
    if (!q.ok) {
      if (Array.isArray(q.unavailable) && q.unavailable.length) {
        return res.status(409).json({ ok: false, message: 'Envío no disponible para la dirección seleccionada', unavailable: q.unavailable })
      }
      return res.status(409).json({ ok: false, message: q.message || 'quote_failed' })
    }

    const shipping_cents = Number(q.shipping_total_cents || 0)
    const snapshot = buildTotalsSnapshot(encargos, shipping_cents)

    const sessionMeta = {
      ...safeJson(metadata),
      flow: 'encargos',
      shipping,
      locale: locale || 'es',
      sources: Array.from(new Set(encargos.map(e => e.source || 'unknown'))),
    }

    const sessionId = await createCheckoutSession(client, {
      customerId,
      amount_total_cents: snapshot.grand_total_cents,
      snapshot,
      payment_method: 'bmspay',
      metadata: sessionMeta,
    })

    return res.json({ ok: true, sessionId, payUrl: null })
  } catch (e) {
    console.error('[encargos/checkout] error:', e)
    return res.status(500).json({ ok: false, message: 'checkout_failed' })
  } finally {
    client.release()
  }
})

// ---- POST /encargos/start-direct (auth) ----
router.post('/start-direct', authenticateToken, async (req, res) => {
  const client = await pool.connect()
  try {
    const customerId = req.user?.id
    if (!customerId) return res.status(401).json({ ok: false, message: 'unauthorized' })

    // 👇 AQUI: también recibimos metadata
    const { shipping, locale, metadata = {} } = req.body || {}
    if (!shipping || !shipping.country) {
      return res.status(400).json({ ok: false, message: 'shipping_required' })
    }

    const encargos = await getUserEncargos(client, customerId)
    if (!encargos.length) {
      return res.status(400).json({ ok: false, message: 'no_pending_encargos' })
    }

    // Cotiza envío usando config del owner de encargos (no hardcode)
    const q = await computeEncargosShipping(client, shipping)
    if (!q.ok) {
      if (Array.isArray(q.unavailable) && q.unavailable.length) {
        return res.status(409).json({ ok: false, message: 'Envío no disponible para la dirección seleccionada', unavailable: q.unavailable })
      }
      return res.status(409).json({ ok: false, message: q.message || 'quote_failed' })
    }

    const shipping_cents = Number(q.shipping_total_cents || 0)
    const snapshot = buildTotalsSnapshot(encargos, shipping_cents)

    // Fee por tarjeta
    const card_fee_cents = Math.round(snapshot.grand_total_cents * FEE_RATE)
    const total_with_card_cents = snapshot.grand_total_cents + card_fee_cents

    // 👇 AQUI: mergeamos lo que manda el front (terms/billing/payer) en metadata
    const sessionMeta = {
      ...safeJson(metadata),          // ← incluye { terms, payer?, billing? }
      flow: 'encargos',
      direct: true,
      shipping,
      locale: locale || 'es',
      card_fee_pct: CARD_FEE_PCT,
      totals: {
        ...snapshot,
        card_fee_cents,
        total_with_card_cents,
      }
    }

    const sessionId = await createCheckoutSession(client, {
      customerId,
      amount_total_cents: total_with_card_cents,
      snapshot,
      payment_method: 'bmspay',
      metadata: sessionMeta,
    })

    return res.json({ ok: true, sessionId, amount: total_with_card_cents })
  } catch (e) {
    console.error('[encargos/start-direct] error:', e)
    return res.status(500).json({ ok: false, message: 'start_direct_failed' })
  } finally {
    client.release()
  }
})


module.exports = router
