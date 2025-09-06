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
const FROM_CUSTOMER = process.env.FROM_EMAIL_CUSTOMER || process.env.FROM_EMAIL || 'info@valelee.com';
const FROM_OWNER    = process.env.FROM_EMAIL_OWNER    || process.env.FROM_EMAIL || 'info@valelee.com';

// Opcionales: personalización visual y enlaces
const LOGO_URL        = process.env.EMAIL_LOGO_URL || ''; // ej: https://tu-dominio.com/logo.png
const CLIENT_BASE_URL = process.env.CLIENT_BASE_URL || 'http://localhost:3000';
// Si guardas rutas relativas para imágenes (p.ej. "/uploads/archivo.jpg"), define esta base pública:
const PUBLIC_ASSETS_BASE = process.env.PUBLIC_ASSETS_BASE || ''; // ej: https://api.tuapp.com/uploads

const safeStatus = (s) => (s ? String(s) : 'pagada');
const nonce = () => Math.random().toString(36).slice(2, 10);

// ===== Helpers =====

function thumb64Html(src, alt) {
  const url = toAbsoluteUrl(src);
  if (!url) {
    return `<div style="width:64px;height:64px;border:1px solid #eee;border-radius:6px;background:#f8f8f8;"></div>`;
  }
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" width="64" height="64"
           style="border-collapse:collapse;width:64px;height:64px;background:#ffffff;border:1px solid #eee;border-radius:6px;">
      <tr>
        <td align="center" valign="middle" style="width:64px;height:64px;line-height:0;">
          <img src="${esc(url)}" alt="${esc(alt || '')}"
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

// Convierte URL relativa en absoluta usando una base pública
function toAbsoluteUrl(u) {
  if (!u) return null;
  const s = String(u);
  if (/^https?:\/\//i.test(s)) return s; // ya es absoluta
  const base =
    PUBLIC_ASSETS_BASE ||
    CLIENT_BASE_URL ||
    'http://localhost:3000';
  return `${String(base).replace(/\/+$/,'')}/${s.replace(/^\/+/,'')}`;
}

// Render helper para dirección (CU/US) + Indicaciones
function renderAddressHTML(ship) {
  if (!ship || typeof ship !== 'object') return '';

  // ---- Cuba ----
  const cuLines = [
    ship.address || '',
    [ship.municipality, ship.province].filter(Boolean).join(', ')
  ].filter(s => String(s).trim() !== '');
  // Escapamos cada línea y luego unimos con <br/>
  const addrCU = cuLines.map(esc).join('<br/>');

  // ---- US ----
  const usLine1 = [ship.address_line1, ship.address_line2].filter(Boolean).join(' ');
  const usLine2 = [ship.city, ship.state, ship.zip].filter(Boolean).join(', ');
  const usLines = [usLine1, usLine2].filter(s => String(s).trim() !== '');
  const addrUS = usLines.map(esc).join('<br/>');

  const addressBlock = (ship.country === 'US') ? addrUS : addrCU;

  const instructions = (ship.instructions || '').toString().trim();
  const instructionsBlock = instructions
    ? `<tr><td style="padding:4px 0;font-weight:600;">Indicaciones:</td><td style="padding:4px 0;">${esc(instructions)}</td></tr>`
    : '';

  const contactBlock = `
    ${ship.email ? `<tr><td style="padding:4px 0;font-weight:600;">Email:</td><td style="padding:4px 0;">${esc(ship.email)}</td></tr>` : ''}
    ${ship.phone ? `<tr><td style="padding:4px 0;font-weight:600;">Teléfono:</td><td style="padding:4px 0;">${esc(ship.phone)}</td></tr>` : ''}
  `;

  return `
    <table role="presentation" style="border-collapse:collapse; font-size:14px; width:100%;">
      <tbody>
        <tr><td style="padding:4px 0;font-weight:600;">Nombre:</td><td style="padding:4px 0;">${esc([ship.first_name, ship.last_name].filter(Boolean).join(' '))}</td></tr>
        ${contactBlock}
        <tr><td style="padding:4px 0;font-weight:600;">Dirección:</td><td style="padding:4px 0;">${addressBlock}</td></tr>
        ${instructionsBlock}
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
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,Cantarell,'Helvetica Neue',Arial,sans-serif;">
    <tr>
      <td align="center" style="padding:10px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="width:600px;max-width:100%;border:1px solid #E5E5E5;">
          <tr>
            <td style="padding:24px 24px 12px 24px;text-align:center;">
              ${LOGO_URL ? `<img src="${esc(LOGO_URL)}" alt="Valelee" style="max-width:140px;height:auto;display:block;margin:0 auto 8px auto;" />` : ''}
              <h1 style="font-size:24px;line-height:1.3;margin:0;font-weight:700;letter-spacing:-0.4px;">${esc(heading)}</h1>
            </td>
          </tr>
          ${blocksHtml}
          <tr>
            <td style="padding:18px 24px 28px 24px;color:#AFAFAF;font-size:12px;text-align:center;">
              © ${new Date().getFullYear()} Valelee. Este es un correo automático; no respondas a esta dirección.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>`;
}

function pill(text, color='#16a34a') {
  const bg = color;
  const fg = '#ffffff';
  return `<span style="display:inline-block;font-size:12px;padding:4px 8px;border-radius:999px;background:${bg};color:${fg};">${esc(text)}</span>`;
}

function button(href, label, variant='primary') {
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
    const img   = toAbsoluteUrl(it.image_url);
    const name  = (it.product_name || ('Producto #' + it.product_id));
    const qty   = Number(it.quantity || 0);
    const price = Number(it.unit_price || 0).toFixed(2);
    return `
      <tr>
        <td style="padding:6px 0;width:64px;vertical-align:top;">
        ${thumb64Html(it.image_url, name)}
        </td>
        <td style="padding:6px 0 6px 10px;vertical-align:top;">
          <div style="font-size:14px;font-weight:500;margin:0 0 2px 0;">${esc(name)}</div>
          <div style="font-size:12px;color:#6F6F6F;margin:0;">x${qty} · US$ ${price}</div>
        </td>
      </tr>
    `;
  }).join('');

  const orderUrl = `${CLIENT_BASE_URL.replace(/\/+$/,'')}/es/orders/${order.id}`;

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
                ${button(orderUrl, 'Ver mi orden', 'secondary')}
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
    const img  = toAbsoluteUrl(it.image_url);
    const name = (it.product_name || ('Producto #' + it.product_id));
    const qty  = Number(it.quantity || 0);

    const desc =
      (typeof it.description === 'string' && it.description.trim()) ? it.description :
      (typeof it.product_description === 'string' && it.product_description.trim()) ? it.product_description :
      (typeof it.details === 'string' && it.details.trim()) ? it.details :
      (it?.meta && typeof it.meta.description === 'string' && it.meta.description.trim()) ? it.meta.description :
      null;

    return `
      <tr>
        <td style="padding:6px 0;width:64px;vertical-align:top;">
        ${thumb64Html(it.image_url, name)}
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
  const deliverUrl = `${CLIENT_BASE_URL.replace(/\/+$/,'')}/es/delivery/${encodeURIComponent(token)}`;

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

  const subject = `Tu orden #${order.id} — ${safeStatus(order.status)}`;
  const html = renderCustomerHTML(order, items);
  const headers = {
    'X-Order-Id': String(order.id),
    'X-Email-Role': 'customer',
    'X-Entity-Ref-ID': `cust-${order.id}-${nonce()}`,
    'List-Id': `customer-${order.id}.orders.valelee.com`,
  };

  return await resend.emails.send({
    from: `Valelee Pedidos <${FROM_CUSTOMER}>`,
    to,
    subject,
    html,
    headers,
  });
}

async function sendOwnerOrderEmail(to, order, items) {
  if (!resendKey) throw new Error('Missing RESEND_API_KEY');

  const subject = `Nueva orden asignada #${order.id}`;
  const html = renderOwnerHTML(order, items);
  const headers = {
    'X-Order-Id': String(order.id),
    'X-Email-Role': 'owner',
    'X-Entity-Ref-ID': `owner-${order.id}-${nonce()}`,
    'List-Id': `owner-${order.id}.orders.valelee.com`,
  };

  return await resend.emails.send({
    from: `Valelee Proveedores <${FROM_OWNER}>`,
    to,
    subject,
    html,
    headers,
  });
}

module.exports = { sendCustomerOrderEmail, sendOwnerOrderEmail };
