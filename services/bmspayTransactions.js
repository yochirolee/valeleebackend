// services/bmspayTransactions.js
const BMS_URL  = process.env.BMS_URL || 'https://services.bmspay.com';
const MID      = Number(process.env.BMS_MID);
const CID      = Number(process.env.BMS_CID);
const USERNAME = process.env.BMS_USERNAME;
const PASSWORD = process.env.BMS_PASSWORD;
const APP_TYPE = Number(process.env.BMS_APP_TYPE || 1);
const APP_KEY  = String(process.env.BMS_APP_KEY || '');
const IS_TEST  = String(process.env.BMS_IS_TEST) === 'true';

function creds() {
  return {
    AppKey: APP_KEY,
    AppType: APP_TYPE,
    mid: MID,
    cid: CID,
    UserName: USERNAME,
    Password: PASSWORD,
    IsTest: IS_TEST,
  };
}

async function fetchJson(url, opts) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts && opts.headers ? opts.headers : {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

/**
 * POST /api/Transactions/GetTransaction
 * Consulta por UserTransactionNumber (tu sessionId).
 */
async function getTransactionByUserTxnNumber(userTransactionNumber) {
  const body = { UserTransactionNumber: String(userTransactionNumber), ...creds() };
  const { ok, status, data } = await fetchJson(`${BMS_URL}/api/Transactions/GetTransaction`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  return {
    ok,
    status,
    data,
    approved: data?.ResponseCode === 200 || String(data?.verbiage || '').toUpperCase() === 'APPROVED',
  };
}

module.exports = { getTransactionByUserTxnNumber };
