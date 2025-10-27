// helpers/resolveItemImages.js
function toStr(x) { return (typeof x === 'string' ? x : '').trim(); }
function imgFromMeta(meta) {
  try {
    const arr = Array.isArray(meta?.images) ? meta.images : [];
    const hit = arr.find(u => typeof u === 'string' && u.trim());
    return hit || null;
  } catch { return null; }
}

function parseVariantOptions(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    const parts = raw.split(/[\/|·-]/).map(s => s.trim()).filter(Boolean);
    const values = parts.map(p => (p.includes(':') ? p.split(':')[1] : p).trim()).filter(Boolean);
    return { option1: values[0] ?? null, option2: values[1] ?? null, option3: values[2] ?? null };
  }
  if (typeof raw === 'object') {
    const o = raw || {};
    const o1 = o.option1 ?? o.Option1 ?? null;
    const o2 = o.option2 ?? o.Option2 ?? null;
    const o3 = o.option3 ?? o.Option3 ?? null;
    if (o1 || o2 || o3) return { option1: o1, option2: o2, option3: o3 };
    const vals = Object.values(o).map(String).filter(Boolean);
    return { option1: vals[0] ?? null, option2: vals[1] ?? null, option3: vals[2] ?? null };
  }
  return {};
}

function normalizeItemVariant(it) {
  if (it.option1 || it.option2 || it.option3) return it;
  const parsed = parseVariantOptions(it?.metadata?.variant_options);
  if (parsed.option1 || parsed.option2 || parsed.option3) return { ...it, ...parsed };
  return it;
}

function matchVariant(variants, it) {
  if (!variants || !variants.length) return null;
  if (it.variant_id != null) {
    const byId = variants.find(v => Number(v.id) === Number(it.variant_id));
    if (byId) return byId;
  }
  const o1 = toStr(it.option1), o2 = toStr(it.option2), o3 = toStr(it.option3);
  if (o1 || o2 || o3) {
    const hit = variants.find(v =>
      (o1 ? toStr(v.option1) === o1 : true) &&
      (o2 ? toStr(v.option2) === o2 : true) &&
      (o3 ? toStr(v.option3) === o3 : true)
    );
    if (hit) return hit;
  }
  return null;
}

function pickEffectiveImage(it, product, variant) {
  const metaImg = toStr(it?.metadata?.variant_image_url);
  if (metaImg) return metaImg;
  const varImg = toStr(variant?.image_url);
  if (varImg) return varImg;
  const itemImg = toStr(it?.image_url);
  if (itemImg) return itemImg;
  const prodImg = toStr(product?.image_url) || toStr(imgFromMeta(product?.metadata));
  return prodImg || '';
}

async function loadProductsAndVariants(client, productIds) {
  if (!productIds.length) return { products: new Map(), variantsByProduct: new Map() };

  const ids = Array.from(new Set(productIds.filter(n => Number.isFinite(n))));
  const pRes = await client.query(
    `SELECT id, image_url, metadata FROM products WHERE id = ANY($1::int[])`,
    [ids]
  );
  const products = new Map();
  for (const r of pRes.rows) products.set(Number(r.id), { id: Number(r.id), image_url: r.image_url, metadata: r.metadata });

  const vRes = await client.query(
    `SELECT id, product_id, option1, option2, option3, image_url
       FROM product_variants
      WHERE product_id = ANY($1::int[])`,
    [ids]
  );
  const variantsByProduct = new Map();
  for (const r of vRes.rows) {
    const pid = Number(r.product_id);
    if (!variantsByProduct.has(pid)) variantsByProduct.set(pid, []);
    variantsByProduct.get(pid).push({
      id: Number(r.id),
      option1: r.option1, option2: r.option2, option3: r.option3,
      image_url: r.image_url
    });
  }
  return { products, variantsByProduct };
}

/**
 * Enriquecer items con resolved_image_url (sin tocar DB)
 * @param {PoolClient} client - pg client dentro de tu transacción o contexto
 * @param {Array} items - items tal como los usas para armar el email
 * @returns {Array} nuevos items con `resolved_image_url`
 */
async function enrichItemsWithResolvedImages(client, items) {
  const normalized = items.map(normalizeItemVariant);
  const ids = normalized.map(it => Number(it.product_id)).filter(Number.isFinite);
  const { products, variantsByProduct } = await loadProductsAndVariants(client, ids);

  return normalized.map(it => {
    const pid = Number(it.product_id);
    const product = products.get(pid) || null;
    const variants = variantsByProduct.get(pid) || [];
    const variant = matchVariant(variants, it);
    const url = pickEffectiveImage(it, product, variant);
    return { ...it, resolved_image_url: url };
  });
}

module.exports = { enrichItemsWithResolvedImages };
