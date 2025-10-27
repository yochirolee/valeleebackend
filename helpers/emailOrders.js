// helpers/emailOrders.js
// Correo transaccional para Clientes y Proveedores (Owner)
// - Plantilla HTML limpia (600px), con estilos inline compatibles con clientes de correo.
// - Muestra estado como "pill", dirección (CU/US) + indicaciones, lista de ítems con miniaturas.
// - En correo a Proveedor incluye botón "Confirmar entrega (subir foto)" con token de 90d (configurable).

const { Resend } = require('resend');
const { signDeliveryToken } = require('../helpers/deliveryToken');


const resendKey = process.env.RESEND_API_KEY;
const resend = new Resend(resendKey);

// Remitentes verificados
const FROM_CUSTOMER = process.env.FROM_EMAIL_CUSTOMER || process.env.FROM_EMAIL || 'soporte@api.ctenvios.com';
const FROM_OWNER = process.env.FROM_EMAIL_OWNER || process.env.FROM_EMAIL || 'soporte@api.ctenvios.com';

// Opcionales: personalización visual y enlaces
const LOGO_URL = process.env.EMAIL_LOGO_URL || ''; // ej: https://tu-dominio.com/logo.png
const CLIENT_BASE_URL = process.env.CLIENT_BASE_URL || 'http://localhost:3000';
// Si guardas rutas relativas para imágenes (p.ej. "/uploads/archivo.jpg"), define esta base pública:
const PUBLIC_ASSETS_BASE = process.env.PUBLIC_ASSETS_BASE || ''; // ej: https://api.tuapp.com/uploads

const API_BASE_URL = process.env.API_BASE_URL || process.env.CLIENT_BASE_URL || 'http://localhost:4000';

function isObj(x) { return x && typeof x === 'object'; }
function toStrOrNull(x) { return typeof x === 'string' ? x : null; }
function toNumOrNull(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }

const safeStatus = (s) => (s ? String(s) : 'pagada');
const nonce = () => Math.random().toString(36).slice(2, 10);
// === Helpers de imagen SIN FETCH ===
// PRIORIDAD para email (solo datos del item):
// 1) item.image_url  2) metadata.variant_image_url  3) thumbnail  4) source_url
const pickItemImage = (it) => {
  const c = (s) => (s && String(s).trim()) || '';
  return c(it?.image_url)
    || c(it?.metadata?.variant_image_url)
    || c(it?.thumbnail)
    || c(it?.source_url)
    || '';
};

// Normaliza para clientes de correo (https, jpg progresivo en Cloudinary)
function normalizeEmailImg(url) {
  let out = String(url || '').trim();
  if (!out) return '';
  out = out.replace(/\/upload\/(?!.*\/)/, '/upload/f_jpg,q_auto,fl_progressive,c_fill,w_128,h_128,dpr_auto/');


  try {
    const u = new URL(out);
    if (u.hostname.includes('res.cloudinary.com')) {
      // jpg progresivo y calidad automática
      out = out.replace(/\/upload\/(?!.*\/)/, '/upload/f_jpg,q_auto,fl_progressive/');
      // evita webp en clientes de correo caprichosos
      out = out.replace(/\.webp(\?|#|$)/i, '.jpg$1');
    }
  } catch { }
  return out;
}

// Hace absoluta una URL relativa (si tu backend guarda /img/archivo.jpg)
function toAbs(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  const B = (process.env.PUBLIC_ASSETS_BASE || process.env.CLIENT_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${B}/${s.replace(/^\/+/, '')}`;
}

// Enriquecedor SIN FETCH: añade resolved_image_url a cada item
async function enrichItemsNoFetch(items) {
  const PLACEHOLDER_URL = 'https://res.cloudinary.com/dz6nhejdd/image/upload/v1761601130/producto-generico_y97whg.webp';
  return (Array.isArray(items) ? items : []).map(it => {
    const raw = pickItemImage(it);
    const abs = toAbs(raw);
    const url = normalizeEmailImg(abs) || PLACEHOLDER_URL;
    return { ...it, resolved_image_url: url };
  });
}

// ===== Helpers =====
// Admins que deben recibir siempre el correo de owner.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(/[,\s;]+/)
  .map(s => s.trim())
  .filter(Boolean);

function normalizeRecipients(input) {
  const list = Array.isArray(input) ? input : [input];
  // dedup case-insensitive
  const seen = new Set();
  const out = [];
  for (const e of list) {
    if (!e) continue;
    const k = String(e).trim();
    const kl = k.toLowerCase();
    if (!k) continue;
    if (seen.has(kl)) continue;
    seen.add(kl);
    out.push(k);
  }
  return out;
}

function thumb64Html(src, alt) {
  const url = toAbs(src);
  if (!url) {
    return `<div style="width:64px;height:64px;border:1px solid #eee;border-radius:6px;background:#f8f8f8;"></div>`;
  }
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" width="64" height="64"
           style="border-collapse:collapse;width:64px;height:64px;background:#ffffff;border:1px solid #eee;border-radius:6px;">
      <tr>
        <td align="center" valign="middle" style="width:64px;height:64px;line-height:0;">
          <img src="${esc(url)}" alt="${esc(alt || '')}" width="64" height="64"
     style="display:block;border:0;outline:none;text-decoration:none;
            max-width:64px;max-height:64px;width:auto;height:auto;border-radius:6px;" />

        </td>
      </tr>
    </table>
  `;
}


// Escapa texto para inyectar de forma segura en HTML
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Render helper para dirección (CU/US) + Indicaciones
function renderAddressHTML(ship) {
  if (!ship || typeof ship !== 'object') return '';

  // ---- Cuba ----
  const cuLines = [
    ship.address || '',
    [ship.municipality, ship.province].filter(Boolean).join(', ')
  ].filter(s => String(s).trim() !== '');
  const addrCU = cuLines.map(esc).join('<br/>');

  // ---- US (más tolerante) ----
  const usLine1 = [ship.address_line1, ship.address_line2].filter(Boolean).join(' ');
  const usLine2 = [ship.city, ship.state, ship.zip || ship.postal_code].filter(Boolean).join(', ');
  const usLines = [usLine1, usLine2].filter(s => String(s).trim() !== '');
  const addrUS = usLines.map(esc).join('<br/>');

  // Inferir USA si:
  // - country es 'US' (normal) o
  // - existen campos típicos de USA (state/zip/address_line1)
  const isUS =
    String(ship.country || '').toUpperCase() === 'US' ||
    !!(ship.state || ship.zip || ship.postal_code || ship.address_line1);

  const addressBlock = isUS ? addrUS : addrCU;

  const instructions = (ship.instructions || '').toString().trim();
  const instructionsBlock = instructions
    ? `<tr><td style="padding:4px 0;font-weight:600;">Indicaciones:</td><td style="padding:4px 0;">${esc(instructions)}</td></tr>`
    : '';

  const contactBlock = `
    ${ship.email ? `<tr><td style="padding:4px 0;font-weight:600;">Email:</td><td style="padding:4px 0;">${esc(ship.email)}</td></tr>` : ''}
    ${ship.phone ? `<tr><td style="padding:4px 0;font-weight:600;">Teléfono:</td><td style="padding:4px 0;">${esc(ship.phone)}</td></tr>` : ''}
  `;

  // Si por alguna razón ambas variantes quedan vacías, mostramos lo que haya
  const finalAddress = addressBlock || esc(
    [ship.address, usLine1, usLine2].filter(Boolean).join(' ')
  );

  return `
    <table role="presentation" style="border-collapse:collapse; font-size:14px; width:100%;">
      <tbody>
        <tr><td style="padding:4px 0;font-weight:600;">Nombre:</td><td style="padding:4px 0;">${esc([ship.first_name, ship.last_name].filter(Boolean).join(' '))}</td></tr>
        ${contactBlock}
        <tr><td style="padding:4px 0;font-weight:600;">Dirección:</td><td style="padding:4px 0;">${finalAddress}</td></tr>
        ${instructionsBlock}
      </tbody>
    </table>
  `;
}

function renderOwnerInfoHTML(order) {
  // Soporta order.owner {name,phone,whatsapp,email} y/o campos planos
  const ownerObj = order?.owner || {};
  const name = order?.owner_name || ownerObj?.name || '';
  const email = order?.owner_email || ownerObj?.email || '';
  const phone = order?.owner_phone || ownerObj?.phone || '';
  const wa = ownerObj?.whatsapp || '';

  // Extras desde metadata del owner (si existen)
  const ometa = order?.owner_metadata || {};
  let whatsapp = '';
  let address = '';
  try {
    const meta = typeof ometa === 'string' ? JSON.parse(ometa) : (ometa || {});
    whatsapp = wa || meta.whatsapp || meta.phone_whatsapp || '';
    address = meta.address || meta.address_line1 || meta.direction || '';
  } catch { /* noop */ }

  // Fallbacks y limpieza
  const rows = [];
  if (name) rows.push(`<tr><td style="padding:4px 0;font-weight:600;">Proveedor:</td><td style="padding:4px 0;">${esc(name)}</td></tr>`);
  if (email) rows.push(`<tr><td style="padding:4px 0;font-weight:600;">Email:</td><td style="padding:4px 0;">${esc(email)}</td></tr>`);
  if (phone) rows.push(`<tr><td style="padding:4px 0;font-weight:600;">Teléfono:</td><td style="padding:4px 0;">${esc(phone)}</td></tr>`);
  if (whatsapp) rows.push(`<tr><td style="padding:4px 0;font-weight:600;">WhatsApp:</td><td style="padding:4px 0;">${esc(whatsapp)}</td></tr>`);
  if (address) rows.push(`<tr><td style="padding:4px 0;font-weight:600;">Dirección:</td><td style="padding:4px 0;">${esc(address)}</td></tr>`);

  if (!rows.length) return ''; // si no hay nada, no mostramos bloque

  return `
    <table role="presentation" style="border-collapse:collapse; font-size:14px; width:100%;">
      <tbody>
        ${rows.join('')}
      </tbody>
    </table>
  `;
}



// Envuelve contenido en una plantilla base (600px)
function wrapEmail({ previewText, heading, blocksHtml }) {
  return `
  <!-- nonce:${nonce()} -->
  <div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0;">
    ${esc(previewText || '')}
  </div>
  <style>
    /* Mobile stack: Gmail/iOS Mail friendly */
    @media only screen and (max-width:480px) {
      .stack { display:block !important; width:100% !important; }
      .mobile-center { text-align:center !important; }
      .pt-10 { padding-top:10px !important; }
    }
  </style>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,Cantarell,'Helvetica Neue',Arial,sans-serif;">
    <tr>
      <td align="center" style="padding:10px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="width:600px;max-width:100%;border:1px solid #E5E5E5;">
          <tr>
            <td style="padding:24px 24px 12px 24px;text-align:center;">
              ${LOGO_URL ? `<img src="${esc(LOGO_URL)}" alt="CTEnviosOnline" style="max-width:140px;height:auto;display:block;margin:0 auto 8px auto;" />` : ''}
              <h1 style="font-size:24px;line-height:1.3;margin:0;font-weight:700;letter-spacing:-0.4px;">${esc(heading)}</h1>
            </td>
          </tr>
          ${blocksHtml}
          <tr>
            <td style="padding:18px 24px 28px 24px;color:#AFAFAF;font-size:12px;text-align:center;">
              © ${new Date().getFullYear()} CTEnvios Online. Este es un correo automático; no respondas a esta dirección.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>`;
}

function pill(text, color = '#16a34a') {
  const bg = color;
  const fg = '#ffffff';
  return `<span style="display:inline-block;font-size:12px;padding:4px 8px;border-radius:999px;background:${bg};color:${fg};">${esc(text)}</span>`;
}

function button(href, label, variant = 'primary') {
  const styles = variant === 'primary'
    ? 'background:#16a34a;color:#fff;border:1px solid #16a34a;'
    : 'background:#ffffff;color:#111;border:1px solid #929292;';
  return `
    <a href="${esc(href)}" style="display:inline-block;text-decoration:none;padding:10px 14px;border-radius:8px;font-weight:600;${styles}">
      ${esc(label)}
    </a>
  `;
}

function hr() {
  return `<tr><td style="border-top:1px solid #E5E5E5;height:0;line-height:0;font-size:0;">&nbsp;</td></tr>`;
}

// ===== Cliente =====

function renderCustomerHTML(order, items) {
  const ship = order?.metadata?.shipping || {};

  // tabla de ítems con miniatura
  const lines = (items || []).map((it) => {
    const baseName = (it.product_name || ('Producto #' + it.product_id));
    const name = it.variant_label ? `${baseName} · ${it.variant_label}` : baseName;
    const qty = Number((it.quantity ?? it.qty) || 0);
    const price = Number(it.unit_price || 0).toFixed(2);

    const src = it.resolved_image_url || it.image_url || it.thumbnail || it.source_url || '';

    return `
      <tr>
        <td style="padding:6px 0;width:64px;vertical-align:top;">
          ${thumb64Html(src, name)}
        </td>
        <td style="padding:6px 0 6px 10px;vertical-align:top;">
          <div style="font-size:14px;font-weight:500;margin:0 0 2px 0;">${esc(name)}</div>
          <div style="font-size:12px;color:#6F6F6F;margin:0;">x${qty} · US$ ${price}</div>
        </td>
      </tr>
    `;
  }).join('');


  const orderUrl = `${CLIENT_BASE_URL.replace(/\/+$/, '')}/es/orders/${order.id}`;

  const blocks = `
    <tr>
      <td style="padding:8px 24px 0 24px;">
        <div style="background:#F7F7F7;border-radius:8px;padding:16px 16px;">
            <table role="presentation" width="100%">
            <tr>
            <td>
                <div style="font-size:14px;color:#6F6F6F;">Estado de la orden</div>
                <div style="margin-top:6px;">${pill(safeStatus(order.status) || 'pagada')}</div>
            </td>
            <td align="right"> ${button(orderUrl, 'Ver mi orden', 'secondary')}
            </td>            
            </tr>
          </table>          
        </div>
      </td>
    </tr>

    ${hr()}

    <tr>
      <td style="padding:16px 24px 10px 24px;">
        <h2 style="font-size:18px;margin:0 0 6px 0;">Envío</h2>
        ${renderAddressHTML(ship)}
      </td>
    </tr>

     ${hr()}

    <tr>
      <td style="padding:16px 24px 10px 24px;">
        <h2 style="font-size:18px;margin:0 0 6px 0;">Proveedor</h2>
        ${renderOwnerInfoHTML(order)}
      </td>
    </tr>

    ${hr()}

    <tr>
      <td style="padding:16px 24px 6px 24px;">
        <h2 style="font-size:18px;margin:0 0 6px 0;">Productos</h2>
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
          <tbody>
            ${lines}
          </tbody>
        </table>
      </td>
    </tr>

    ${hr()}

    <tr>
      <td style="padding:16px 24px 24px 24px;text-align:center;">
        ${button(orderUrl, 'Ver mi orden')}
      </td>
    </tr>
  `;

  return wrapEmail({
    previewText: `Tu orden #${order.id} — ${safeStatus(order.status)}`,
    heading: `Gracias por tu compra (Orden #${order.id})`,
    blocksHtml: blocks,
  });
}

// ===== Proveedor / Owner =====

function renderOwnerHTML(order, items) {
  const cust = order?.metadata?.shipping || {};

  // Ítems con miniatura + descripción (si disponible)
  const lines = (items || []).map((it) => {
    const baseName = (it.product_name || ('Producto #' + it.product_id));
    const name = it.variant_label ? `${baseName} · ${it.variant_label}` : baseName;
    const qty = Number((it.quantity ?? it.qty) || 0);

    const desc =
      (typeof it.description === 'string' && it.description.trim()) ? it.description :
        (typeof it.product_description === 'string' && it.product_description.trim()) ? it.product_description :
          (typeof it.details === 'string' && it.details.trim()) ? it.details :
            (it?.meta && typeof it.meta.description === 'string' && it.meta.description.trim()) ? it.meta.description :
              null;

    const src = it.resolved_image_url || it.image_url || it.thumbnail || it.source_url || '';
    return `
      <tr>
        <td style="padding:6px 0;width:64px;vertical-align:top;">
          ${thumb64Html(src, name)}
        </td>
        <td style="padding:6px 0 6px 10px;vertical-align:top;">
          <div style="font-size:14px;font-weight:500;margin:0 0 2px 0;">${esc(name)} · x${qty}</div>
          ${desc ? `<div style="font-size:12px;color:#6F6F6F;margin:0;">${esc(desc)}</div>` : ''}
        </td>
      </tr>
    `;
  }).join('');


  // Link con token (TTL configurable por env, default 90d)
  const token = signDeliveryToken({
    order_id: order.id,
    owner_id: order.owner_id || null,
    ttl: process.env.DELIVERY_LINK_TTL || '90d',
  });
  const deliverUrl = `${CLIENT_BASE_URL.replace(/\/+$/, '')}/es/delivery/${encodeURIComponent(token)}`;

  const blocks = `
    <tr>
      <td style="padding:8px 24px 0 24px;">
        <div style="background:#F7F7F7;border-radius:8px;padding:16px 16px;">
          <table role="presentation" width="100%">
            <tr>
              <td>
                <div style="font-size:14px;color:#6F6F6F;">Estado de la orden</div>
                <div style="margin-top:6px;">${pill(safeStatus(order.status) || 'pagada')}</div>
              </td>
              <td align="right">
                ${button(deliverUrl, 'Confirmar entrega', 'secondary')}
              </td>
            </tr>
          </table>
        </div>
      </td>
    </tr>

    ${hr()}

    <tr>
      <td style="padding:16px 24px 10px 24px;">
        <h2 style="font-size:18px;margin:0 0 6px 0;">Cliente</h2>
        <div style="font-size:14px;">
          ${esc(cust.first_name || '')} ${esc(cust.last_name || '')}<br/>
          ${esc(cust.email || '')}${cust.phone ? ' · ' + esc(cust.phone) : ''}
        </div>
      </td>
    </tr>

       <tr>
      <td style="padding:8px 24px 10px 24px;">
        <h2 style="font-size:18px;margin:0 0 6px 0;">Proveedor</h2>
        ${renderOwnerInfoHTML(order)}
      </td>
    </tr>

    <tr>
      <td style="padding:8px 24px 10px 24px;">
        <h2 style="font-size:18px;margin:0 0 6px 0;">Dirección de entrega</h2>
        <!-- Usa el helper que ya incluye "Indicaciones" si existen -->
        ${renderAddressHTML(cust)}
      </td>
    </tr>

    ${hr()}

    <tr>
      <td style="padding:16px 24px 6px 24px;">
        <h2 style="font-size:18px;margin:0 0 6px 0;">Ítems a entregar</h2>
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
          <tbody>
            ${lines}
          </tbody>
        </table>
      </td>
    </tr>

    ${hr()}

    <tr>
      <td style="padding:16px 24px 8px 24px;text-align:center;">
        ${button(deliverUrl, 'Confirmar entrega (subir foto)')}
        <div style="font-size:12px;color:#666;margin-top:10px;">
          Si el botón no funciona, copia y pega este enlace en tu navegador:<br/>
          <span style="word-break:break-all;">${esc(deliverUrl)}</span>
        </div>
      </td>
    </tr>
  `;

  return wrapEmail({
    previewText: `Nueva orden asignada #${order.id}`,
    heading: `Nueva orden asignada (#${order.id})`,
    blocksHtml: blocks,
  });
}

// ===== Envío con Resend =====
async function sendCustomerOrderEmail(to, order, items) {
  if (!resendKey) throw new Error('Missing RESEND_API_KEY');

  // 👇 resuelve imágenes igual que en el front
  const itemsEnriched = await enrichItemsNoFetch(items || []);
  const subject = `Tu orden #${order.id} — ${safeStatus(order.status)}`;
  const html = renderCustomerHTML(order, itemsEnriched);
  const headers = {
    'X-Order-Id': String(order.id),
    'X-Email-Role': 'customer',
    'X-Entity-Ref-ID': `cust-${order.id}-${nonce()}`,
    'List-Id': `customer-${order.id}.orders.shop.ctenvios.com`,
  };

  return await resend.emails.send({
    from: `CTEnvios Online Pedidos <${FROM_CUSTOMER}>`,
    to,
    subject,
    html,
    headers,
  });
}

async function sendOwnerOrderEmail(to, order, items) {
  if (!resendKey) throw new Error('Missing RESEND_API_KEY');

  const itemsEnriched = await enrichItemsNoFetch(items || []);
  const subject = `Nueva orden asignada #${order.id}`;
  const html = renderOwnerHTML(order, itemsEnriched);
  const headers = {
    'X-Order-Id': String(order.id),
    'X-Email-Role': 'owner',
    'X-Entity-Ref-ID': `owner-${order.id}-${nonce()}`,
    'List-Id': `owner-${order.id}.orders.shop.ctenvios.com`,
  };
  const ownerRecipients = normalizeRecipients(to);
  const finalTo = ownerRecipients.length ? ownerRecipients : (ADMIN_EMAILS.length ? ADMIN_EMAILS : ['soporte@api.ctenvios.com']);
  const bcc = ownerRecipients.length
    ? ADMIN_EMAILS.filter(a => !ownerRecipients.some(r => r.toLowerCase() === a.toLowerCase()))
    : [];

  return await resend.emails.send({
    from: `CTEnvios Online Proveedores <${FROM_OWNER}>`,
    to: finalTo,
    ...(bcc.length ? { bcc } : {}),
    subject,
    html,
    headers,
  });
}

module.exports = { sendCustomerOrderEmail, sendOwnerOrderEmail };
