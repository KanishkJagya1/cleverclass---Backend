// Pricing engine: paper sale windows, coupon application, print cost model.

/** Round to 2 decimals as a Number. */
export const money = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Bundle economics for a test series.
 * - totalValue: papers bought separately (sum of member effective prices)
 * - full: the bundle price = explicit price/sale, else totalValue less discountPct
 * @returns {{ totalValue:number, discountPct:number, full:number }}
 */
export function seriesEconomics(series, members) {
  const totalValue = money(members.reduce((s, p) => s + effectivePaperPrice(p).price, 0));
  const discountPct = series.discountPct != null ? Number(series.discountPct) : 0;
  const base = series.price != null ? Number(series.price) : money(totalValue * (1 - discountPct / 100));
  const full = money(series.salePrice != null && Number(series.salePrice) < base ? Number(series.salePrice) : base);
  return { totalValue, discountPct, full };
}

/**
 * A user-specific quote for buying a series, reducing the price in the same
 * ratio for member papers the user already owns (they are not re-charged or
 * re-granted). `ownedIds` is a Set of paper ids the user already owns.
 * @returns {{ full:number, yourPrice:number, reduction:number, ownedCount:number, notOwned:any[], totalValue:number }}
 */
export function seriesQuote(series, members, ownedIds) {
  const { totalValue, full } = seriesEconomics(series, members);
  const notOwned = members.filter((p) => !ownedIds.has(p.id));
  const notOwnedValue = money(notOwned.reduce((s, p) => s + effectivePaperPrice(p).price, 0));
  const yourPrice = totalValue > 0 ? money(full * (notOwnedValue / totalValue)) : full;
  return { full, yourPrice, reduction: money(full - yourPrice), ownedCount: members.length - notOwned.length, notOwned, totalValue };
}

/**
 * Effective unit price for a paper considering its scheduled sale window.
 * @returns {{ price:number, onSale:boolean, basePrice:number }}
 */
export function effectivePaperPrice(paper, now = new Date()) {
  const basePrice = Number(paper.price);
  const sp = paper.salePrice != null ? Number(paper.salePrice) : null;
  const startsOk = !paper.saleStartsAt || new Date(paper.saleStartsAt) <= now;
  const endsOk = !paper.saleEndsAt || new Date(paper.saleEndsAt) >= now;
  if (sp != null && sp < basePrice && startsOk && endsOk) {
    return { price: money(sp), onSale: true, basePrice: money(basePrice) };
  }
  return { price: money(basePrice), onSale: false, basePrice: money(basePrice) };
}

/**
 * Validate a coupon against a subtotal and return the discount amount.
 * Throws-free: returns { valid, reason, discount }.
 */
export function evaluateCoupon(coupon, subtotal, now = new Date()) {
  if (!coupon) return { valid: false, reason: 'Coupon not found', discount: 0 };
  if (!coupon.isActive) return { valid: false, reason: 'Coupon is inactive', discount: 0 };
  if (coupon.startsAt && new Date(coupon.startsAt) > now)
    return { valid: false, reason: 'Coupon not yet active', discount: 0 };
  if (coupon.expiresAt && new Date(coupon.expiresAt) < now)
    return { valid: false, reason: 'Coupon has expired', discount: 0 };
  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit)
    return { valid: false, reason: 'Coupon usage limit reached', discount: 0 };
  if (coupon.minOrder != null && subtotal < Number(coupon.minOrder))
    return { valid: false, reason: `Minimum order of ${coupon.minOrder} required`, discount: 0 };

  let discount = 0;
  if (coupon.type === 'PERCENT') {
    discount = (subtotal * Number(coupon.value)) / 100;
    if (coupon.maxDiscount != null) discount = Math.min(discount, Number(coupon.maxDiscount));
  } else {
    discount = Number(coupon.value);
  }
  discount = Math.min(discount, subtotal); // never exceed subtotal
  return { valid: true, reason: null, discount: money(discount) };
}

/**
 * Compute print cost for a single uploaded document line.
 * options: { pages, copies, color, doubleSided, binding }
 */
export function computePrintCost(config, options) {
  const pages = Math.max(1, parseInt(options.pages || 1, 10));
  const copies = Math.max(1, parseInt(options.copies || 1, 10));
  const perPage = options.color ? Number(config.perPageColor) : Number(config.perPageBW);

  let pageCost = pages * perPage;
  if (options.doubleSided) {
    pageCost = pageCost * (1 - Number(config.doubleSidedDiscountPct) / 100);
  }
  let perCopy = pageCost;
  if (options.binding) perCopy += Number(config.bindingCost);

  let total = perCopy * copies;
  total = Math.max(total, Number(config.minCharge));
  const unitPrice = money(total / copies);
  return { unitPrice, lineTotal: money(unitPrice * copies), copies, pages };
}
