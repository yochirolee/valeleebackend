// helpers/resend.js (CommonJS)
const { Resend } = require('resend');

const resendKey = process.env.RESEND_API_KEY;
const fromEmail = process.env.FROM_EMAIL || 'info@valelee.com';

const resend = new Resend(resendKey);

async function sendPasswordResetEmail(to, link, locale = process.env.DEFAULT_LOCALE || 'es') {
  if (!resendKey) {
    console.error('[resend] RESEND_API_KEY no está definido');
    throw new Error('Missing RESEND_API_KEY');
  }
  if (!fromEmail) {
    console.error('[resend] FROM_EMAIL no está definido');
    throw new Error('Missing FROM_EMAIL');
  }

  const subject =
    locale === 'en'
      ? 'Reset your password'
      : 'Restablece tu contraseña';

  const html =
    locale === 'en'
      ? `<p>Click the link to reset your password:</p><p><a href="${link}">${link}</a></p>`
      : `<p>Haz clic en el enlace para restablecer tu contraseña:</p><p><a href="${link}">${link}</a></p>`;

    try {
    const result = await resend.emails.send({
      from: fromEmail,
      to,
      subject,
      html,
    });

    console.log('[resend] Resultado:', result);
    return result;
  } catch (err) {
    console.error('[resend] Error al enviar:', err);
    throw err;
  }
}

module.exports = { sendPasswordResetEmail };
