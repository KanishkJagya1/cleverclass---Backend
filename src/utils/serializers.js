import { effectivePaperPrice, money } from './pricing.js';

const num = (d) => (d == null ? null : Number(d));

/**
 * Public/admin view of a test series (a bundle of papers).
 * Effective price = explicit bundle sale/price if set, else the summed effective
 * price of its member papers.
 */
export function serializeTestSeries(series, { includePapers = true } = {}) {
  const links = series.papers || [];
  const papers = links
    .map((l) => l.paper)
    .filter(Boolean)
    .map((p) => serializePaper(p));
  const summed = money(papers.reduce((s, p) => s + Number(p.effectivePrice ?? p.price ?? 0), 0));
  // Bundle default = summed less the series discount (that's why clubbing is cheaper);
  // an explicit price overrides it.
  const discountPct = series.discountPct != null ? Number(series.discountPct) : 0;
  const base = series.price != null ? Number(series.price) : money(summed * (1 - discountPct / 100));
  const sale = series.salePrice != null ? Number(series.salePrice) : null;
  const onSale = sale != null && sale < base;
  const effectivePrice = money(onSale ? sale : base);
  return {
    id: series.id,
    title: series.title,
    slug: series.slug,
    description: series.description,
    subject: series.subject,
    coverImage: series.coverImage,
    price: money(base),
    salePrice: sale != null ? money(sale) : null,
    discountPct,
    effectivePrice,
    onSale,
    // What the bundle would cost buying each paper separately (for a "save X" badge).
    itemsTotal: summed,
    paperCount: links.length,
    isActive: series.isActive,
    isFeatured: series.isFeatured,
    createdAt: series.createdAt,
    ...(includePapers ? { papers } : {}),
  };
}

/** Public/catalog view of a paper (includes effective sale price, hides fileKey). */
export function serializePaper(paper, { includeFile = false } = {}) {
  const eff = effectivePaperPrice(paper);
  return {
    id: paper.id,
    title: paper.title,
    slug: paper.slug,
    description: paper.description,
    subject: paper.subject,
    board: paper.board,
    grade: paper.grade,
    year: paper.year,
    coverImage: paper.coverImage,
    previewText: paper.previewText,
    price: num(paper.price),
    salePrice: num(paper.salePrice),
    effectivePrice: eff.price,
    onSale: eff.onSale,
    saleStartsAt: paper.saleStartsAt,
    saleEndsAt: paper.saleEndsAt,
    pages: paper.pages,
    fileName: paper.fileName,
    fileSize: paper.fileSize,
    isActive: paper.isActive,
    isFeatured: paper.isFeatured,
    viewable: paper.viewable,
    createdAt: paper.createdAt,
    ...(includeFile ? { storageProvider: paper.storageProvider, fileKey: paper.fileKey } : {}),
  };
}

/** Full order (user who owns it, or admin). Includes all pricing. */
export function serializeOrder(order) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    type: order.type,
    status: order.status,
    paymentStatus: order.paymentStatus,
    refundStatus: order.refundStatus,
    refundAmount: num(order.refundAmount),
    refundId: order.refundId,
    refundInitiatedAt: order.refundInitiatedAt,
    refundCompletedAt: order.refundCompletedAt,
    subtotal: num(order.subtotal),
    discount: num(order.discount),
    total: num(order.total),
    currency: order.currency,
    couponCode: order.couponCode,
    razorpayOrderId: order.razorpayOrderId,
    razorpayPaymentId: order.razorpayPaymentId,
    shipping: {
      name: order.shipName,
      phone: order.shipPhone,
      email: order.shipEmail,
      line1: order.shipLine1,
      line2: order.shipLine2,
      city: order.shipCity,
      state: order.shipState,
      pincode: order.shipPincode,
    },
    notes: order.notes,
    items: (order.items || []).map((it) => ({
      id: it.id,
      kind: it.kind,
      title: it.title,
      copies: it.copies,
      unitPrice: num(it.unitPrice),
      lineTotal: num(it.lineTotal),
      printOptions: it.printOptions,
      paperId: it.paperId,
      documentId: it.documentId,
      seriesId: it.seriesId || null,
      seriesTitle: it.seriesTitle || null,
      paperViewable: it.paper ? it.paper.viewable : null,
      paperSlug: it.paper ? it.paper.slug : null,
    })),
    user: order.user ? { id: order.user.id, name: order.user.name, email: order.user.email } : undefined,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

/**
 * Manager view of an order: shipping + what to print, but NO pricing,
 * coupons, totals or payment amounts. Managers only fulfil/print/deliver.
 */
export function serializeOrderForManager(order) {
  const printItems = (order.items || []).filter((it) => it.kind === 'PRINT');
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    type: order.type,
    status: order.status,
    shipping: {
      name: order.shipName,
      phone: order.shipPhone,
      line1: order.shipLine1,
      line2: order.shipLine2,
      city: order.shipCity,
      state: order.shipState,
      pincode: order.shipPincode,
    },
    notes: order.notes,
    // Managers only ever handle the PRINT items (never the buyer's digital papers), and never see money.
    items: printItems.map((it) => ({
      id: it.id,
      kind: it.kind,
      title: it.title,
      copies: it.copies,
      printOptions: it.printOptions,
      paperId: it.paperId,
      documentId: it.documentId,
      hasFile: Boolean(it.paperId || it.documentId),
    })),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

/**
 * Manager's PRICED print-order record: pdf count, pages, printing dynamics and
 * cost per print item + the print subtotal — but NO customer identity/content
 * details. This is the manager's billing view.
 */
export function serializeOrderForManagerBill(order) {
  const printItems = (order.items || []).filter((it) => it.kind === 'PRINT');
  const items = printItems.map((it) => {
    const o = it.printOptions || {};
    return {
      id: it.id,
      // Neutral label — no paper/document identity leaked to the store.
      label: it.documentId ? 'Uploaded document' : 'Catalog paper',
      pages: o.pages ?? null,
      copies: it.copies,
      color: !!o.color,
      doubleSided: !!o.doubleSided,
      binding: !!o.binding,
      unitPrice: num(it.unitPrice),
      lineTotal: num(it.lineTotal),
    };
  });
  const printTotal = money(items.reduce((s, i) => s + Number(i.lineTotal || 0), 0));
  const totalPages = items.reduce((s, i) => s + (i.pages || 0) * (i.copies || 1), 0);
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    type: order.type,
    status: order.status,
    createdAt: order.createdAt,
    pdfCount: items.length,
    totalPages,
    printTotal,
    items,
  };
}
