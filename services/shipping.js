// services/shipping.js
const { pool } = require('../db');

function tierForCuba(province, areaType /* 'city' | 'municipio' */) {
  const isHabana = String(province || '').toLowerCase() === 'la habana';
  const isMunicipio = String(areaType || '').toLowerCase() === 'municipio';
  if (isHabana && !isMunicipio) return 'hab_city';
  if (isHabana && isMunicipio)  return 'hab_rural';
  if (!isHabana && !isMunicipio) return 'other_city';
  return 'other_rural';
}

function pick(obj, keyMap) {
  return Number(obj?.[keyMap] ?? 0) || 0;
}

async function shippingForOwner({ owner_id, country, province, area_type, total_weight_lbs }) {
  const { rows } = await pool.query(
    `SELECT * FROM owner_shipping_config WHERE owner_id = $1 AND country = $2 AND active = true LIMIT 1`,
    [owner_id, country]
  );
  if (!rows.length) return 0;
  const c = rows[0];

  if (country === 'US') {
    return Number(c.us_flat || 0);
  }

  // CU
  const tier = tierForCuba(province, area_type);
  if (c.mode === 'fixed') {
    const keys = {
      hab_city:   'cu_hab_city_flat',
      hab_rural:  'cu_hab_rural_flat',
      other_city: 'cu_other_city_flat',
      other_rural:'cu_other_rural_flat',
    };
    return pick(c, keys[tier]);
  } else {
    const baseKeys = {
      hab_city:   'cu_hab_city_base',
      hab_rural:  'cu_hab_rural_base',
      other_city: 'cu_other_city_base',
      other_rural:'cu_other_rural_base',
    };
    const base = pick(c, baseKeys[tier]);
    const rate = Number(c.cu_rate_per_lb || 0);
    const minFee = Number(c.cu_min_fee || 0);
    const calc = base + rate * (Number(total_weight_lbs) || 0);
    return Math.max(calc, minFee);
  }
}

module.exports = { shippingForOwner };
