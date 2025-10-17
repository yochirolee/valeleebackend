// services/bmspay3ds.js — JS puro (sin TypeScript), con cache+retry

const PROD = process.env.BMS_URL || 'https://services.bmspay.com';
const TEST = 'https://services.bmspay.com/testing';
const IS_TEST = String(process.env.BMS_IS_TEST || 'true') === 'true';

const USERNAME = process.env.BMS_USERNAME;
const PASSWORD = process.env.BMS_PASSWORD;
const MID = String(process.env.BMS_MID || '');
const CID = String(process.env.BMS_CID || '');
const APP_KEY = process.env.BMS_APP_KEY;
const APP_TYPE = String(process.env.BMS_APP_TYPE || '1');

// TTL configurable para cachear ApiKey/Token (default 12 min)
const THREE_DS_TTL_MS = Number.parseInt(process.env.THREE_DS_TTL_MS || '720000', 10);

// Cache en memoria del proceso
let _3dsCache = {
  apiKey: null,
  token: null,
  until: 0,
};

function ep(path) {
  return `${IS_TEST ? TEST : PROD}${path}`;
}

function missingEnv() {
  const missing = [];
  if (!MID) missing.push('BMS_MID');
  if (!CID) missing.push('BMS_CID');
  if (!USERNAME) missing.push('BMS_USERNAME');
  if (!PASSWORD) missing.push('BMS_PASSWORD');
  if (!APP_KEY) missing.push('BMS_APP_KEY');
  if (!APP_TYPE) missing.push('BMS_APP_TYPE');
  return missing;
}

async function postJSON(url, body, { attempts = 2 } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }

      // Algunos despliegues devuelven HTML 500 intermitente
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      const looksHtml500 = (!ct.includes('application/json') && /<html/i.test(text)) || res.status >= 500;

      if (res.ok && data) return { ok: true, data, status: res.status };
      if (looksHtml500) {
        lastErr = new Error(`Gateway HTML ${res.status || 500}`);
      } else {
        // rechazo “válido” (400/401/etc): no reintentar
        return { ok: false, data, status: res.status, text };
      }
    } catch (e) {
      lastErr = e;
    }
    // backoff lineal simple
    await new Promise(r => setTimeout(r, 500 + i * 400));
  }
  if (lastErr) throw lastErr;
  return { ok: false, data: null, status: 500, text: 'unknown error' };
}

async function getThreeDSCreds() {
  // Cache válido
  const now = Date.now();
  if (_3dsCache.token && _3dsCache.until > now) {
    return { apiKey: _3dsCache.apiKey, token: _3dsCache.token };
  }

  // Validar envs
  const missing = missingEnv();
  if (missing.length) {
    throw new Error(`Variables faltantes: ${missing.join(', ')}`);
  }

  // Llamada a BMS para pedir ApiKey/Token
  const body = {
    mid: Number(MID),
    UserName: USERNAME,
    Password: PASSWORD,
    AppType: Number(APP_TYPE),
    AppKey: APP_KEY,
    cid: String(CID),
  };

  let resp;
  try {
    resp = await postJSON(ep('/api/auth/tokenthreeds'), body, { attempts: 3 });
  } catch (err) {
    throw new Error(
      `Fallo de red hacia Blackstone 3DS: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!resp.ok || !resp.data || !resp.data.ApiKey || !resp.data.Token) {
    const detail =
      (resp && resp.data && (resp.data.Msg?.[0] || resp.data.message || resp.data.verbiage)) ||
      resp.text ||
      `HTTP ${resp.status || '??'}`;
    const hint = IS_TEST ? 'Estás en TEST (BMS_IS_TEST=true).' : 'Estás en PROD (BMS_IS_TEST=false).';
    throw new Error(`No se pudieron obtener credenciales 3DS. ${hint} Detalle: ${detail}`);
  }

  const apiKey = String(resp.data.ApiKey);
  const token = String(resp.data.Token);

  // Cachear
  _3dsCache = {
    apiKey,
    token,
    until: now + (Number.isFinite(THREE_DS_TTL_MS) ? THREE_DS_TTL_MS : 720000),
  };

  return { apiKey, token };
}

module.exports = { getThreeDSCreds };
