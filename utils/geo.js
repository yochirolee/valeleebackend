function zoneKeyForCuba(province, area_type) {
  const isHabana = String(province || '').trim().toLowerCase() === 'la habana';
  const isCity = (String(area_type || '').toLowerCase() === 'city');
  if (isHabana) return isCity ? 'habana_city' : 'habana_municipio';
  return isCity ? 'provincias_city' : 'provincias_municipio';
}
module.exports = { zoneKeyForCuba };
