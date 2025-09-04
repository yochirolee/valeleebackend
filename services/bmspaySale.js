// services/bmspaySale.js
// Ejecuta una venta directa en BMSPAY (Transactions/Sale)
// Usa x-www-form-urlencoded porque es lo que mejor compatibiliza con varios despliegues de BMS.


const { URLSearchParams } = require('url')

const PROD = process.env.BMS_URL || 'https://services.bmspay.com'
const TEST = 'https://services.bmspay.com/testing'
const IS_TEST = String(process.env.BMS_IS_TEST || 'true') === 'true'

const USERNAME = process.env.BMS_USERNAME
const PASSWORD = process.env.BMS_PASSWORD
const MID = String(process.env.BMS_MID || '')
const CID = String(process.env.BMS_CID || '')
const APP_KEY = process.env.BMS_APP_KEY
const APP_TYPE = String(process.env.BMS_APP_TYPE || '1')

function ep(path) {
  return `${IS_TEST ? TEST : PROD}${path}`
}

/**
 * Ejecuta venta directa (Transactions/Sale)
 * expMonth: "08", expYear: "30" -> ExpDate: "0830"
 *
 * Devuelve:
 *  {
 *    ok: boolean,
 *    message: string | undefined,
 *    authNumber: string | null,
 *    reference: string | null,
 *    userTransactionNumber: string,   // 👈 UTN devuelto tal cual se envió
 *    raw: any
 *  }
 */
async function sale({
  amount,
  zipCode,
  cardNumber,
  expMonth,
  expYear,
  cvn,
  nameOnCard,
  userTransactionNumber,
}) {
  const ExpDate = `${String(expMonth || '').padStart(2, '0')}${String(expYear || '').slice(-2)}`
  const Amount = Number(amount || 0).toFixed(2)

  // x-www-form-urlencoded (muy compatible con BMS)
  const form = new URLSearchParams({
    UserName: USERNAME || '',
    Password: PASSWORD || '',
    mid: MID,
    cid: CID,
    Amount,
    TransactionType: '1',      // 1 = CREDIT
    Track2: '',
    ZipCode: zipCode || '',
    CVN: cvn || '',
    CardNumber: String(cardNumber || '').replace(/\D/g, ''),
    ExpDate,
    NameOnCard: nameOnCard || '',
    AppKey: APP_KEY || '',
    AppType: APP_TYPE,
    UserTransactionNumber: userTransactionNumber || '', // 👈 lo enviamos
    Source: 'ApiClient',
    IsTest: IS_TEST ? 'true' : 'false',
  })

  const res = await fetch(ep('/api/Transactions/Sale'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  })

  const text = await res.text()
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('application/json')) {
    // respuesta HTML o texto plano ⇒ tratar como error del gateway
    if (/<html/i.test(text)) {
      return { ok: false, message: 'gateway_html_500', raw: text };
    }
  }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }

  // Señales de aprobación:
  // - ResponseCode === 200 (documentado)
  // - verbiage contiene "APPROVED" (observado en tus respuestas)
  // - AuthorizationNumber presente (suele venir cuando aprueba)
  const responseCodeOk = Number(json?.ResponseCode) === 200
  const verbiageOk = String(json?.verbiage || '').toUpperCase().includes('APPROV')
  const authOk = Boolean(json?.AuthorizationNumber)

  const approved = responseCodeOk || verbiageOk || authOk

  return {
    ok: !!approved,
    message: json?.verbiage || json?.message || json?.ResponseText,
    authNumber: json?.AuthorizationNumber ?? null,
    reference: json?.ServiceReferenceNumber ?? null,
    userTransactionNumber: userTransactionNumber || null, // 👈 devolvemos el UTN
    raw: json,
  }
}

module.exports = { sale }

/*
 // Si tu instancia de BMS requiere JSON puro, este sería el payload equivalente:
 const payload = {
   Amount: Number(amount || 0),
   ZipCode: zipCode || '',
   CVN: cvn || '',
   CardNumber: String(cardNumber || '').replace(/\D/g, ''),
   ExpDate,
   NameOnCard: nameOnCard || '',
   UserTransactionNumber: userTransactionNumber || '',
   TransactionType: 1,
   AppKey: APP_KEY,
   AppType: Number(APP_TYPE),
   mid: Number(MID),
   cid: Number(CID),
   UserName: USERNAME,
   Password: PASSWORD,
   Source: 'ApiClient',
   IsTest: IS_TEST
 }
 const res = await fetch(ep('/api/Transactions/Sale'), {
   method: 'POST',
   headers: { 'Content-Type': 'application/json' },
   body: JSON.stringify(payload),
 })
*/
