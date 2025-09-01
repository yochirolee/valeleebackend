const jwt = require('jsonwebtoken');

const SECRET = process.env.DELIVERY_TOKEN_SECRET || 'dev-delivery-secret-change-me';

function signDeliveryToken({ order_id, owner_id, scope = 'deliver.confirm', ttl = '90d' }) {
  const payload = { order_id, owner_id, scope, nbf: Math.floor(Date.now()/1000) };
  return jwt.sign(payload, SECRET, { expiresIn: ttl });
}

function verifyDeliveryToken(token) {
  try {
    const decoded = jwt.verify(token, SECRET);
    if (decoded.scope !== 'deliver.confirm') {
      throw new Error('invalid_scope');
    }
    return decoded; // { order_id, owner_id, scope, iat, exp }
  } catch (e) {
    const err = new Error('invalid_token');
    err.cause = e;
    throw err;
  }
}

module.exports = { signDeliveryToken, verifyDeliveryToken };
