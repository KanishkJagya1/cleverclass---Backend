/* End-to-end API test. Assumes the server is running and DB is seeded. */
const BASE = process.env.API_BASE || 'http://localhost:5000/api';

let passed = 0;
let failed = 0;
const fails = [];

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✔ ${msg}`);
  } else {
    failed++;
    fails.push(msg);
    console.log(`  ✖ ${msg}`);
  }
}

async function req(method, path, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload = body;
  if (body && !raw) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data, headers: res.headers };
}

function makePdfBlob(text = 'Test Upload') {
  const stream = `BT /F1 20 Tf 72 720 Td (${text}) Tj ET`;
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents 4 0 R >>
endobj
4 0 obj
<< /Length ${stream.length} >>
stream
${stream}
endstream
endobj
trailer
<< /Root 1 0 R >>
%%EOF`;
  return new Blob([pdf], { type: 'application/pdf' });
}

async function main() {
  console.log('\n=== CleverClass API E2E Test ===\n');

  // 1. Health
  console.log('[Health]');
  const health = await req('GET', '/health');
  assert(health.status === 200 && health.data.status === 'ok', 'GET /health returns ok');

  // 2. Admin login
  console.log('\n[Auth: admin/manager]');
  const adminLogin = await req('POST', '/auth/login', {
    body: { email: 'admin@cleverclass.com', password: 'Admin@123' },
  });
  assert(adminLogin.status === 200 && adminLogin.data.user.role === 'ADMIN', 'Admin can log in');
  const adminToken = adminLogin.data.token;

  const managerLogin = await req('POST', '/auth/login', {
    body: { email: 'manager@cleverclass.com', password: 'Manager@123' },
  });
  assert(managerLogin.status === 200 && managerLogin.data.user.role === 'MANAGER', 'Manager can log in');
  const managerToken = managerLogin.data.token;
  const managerId = managerLogin.data.user.id;
  assert(managerLogin.data.user.isPrimaryManager === true, 'Seeded manager is a PRIMARY manager');

  // Ordinary manager (used for permission checks)
  const ordLogin = await req('POST', '/auth/login', {
    body: { email: 'manager2@cleverclass.com', password: 'Manager@123' },
  });
  assert(ordLogin.status === 200 && ordLogin.data.user.isPrimaryManager === false, 'Ordinary manager can log in (not primary)');
  const ordToken = ordLogin.data.token;
  const ordId = ordLogin.data.user.id;

  // 3. Register + login a fresh user
  console.log('\n[Auth: new user]');
  const email = `test_${Date.now()}@example.com`;
  const reg = await req('POST', '/auth/register', {
    body: { name: 'Test User', email, password: 'Test@123', phone: '9999999999' },
  });
  assert(reg.status === 201 && reg.data.token, 'User can register');
  const userToken = reg.data.token;
  const me = await req('GET', '/auth/me', { token: userToken });
  assert(me.status === 200 && me.data.user.email === email, 'GET /auth/me returns current user');
  assert(reg.data.user.role === 'USER', 'New registrations are USER role');

  // 4. Admin creates a paper (multipart)
  console.log('\n[Admin: create paper]');
  const fd = new FormData();
  fd.append('title', `E2E Test Paper ${Date.now()}`);
  fd.append('subject', 'Testing');
  fd.append('board', 'CBSE');
  fd.append('grade', 'Class 10');
  fd.append('price', '100');
  fd.append('salePrice', '80');
  fd.append('isFeatured', 'true');
  fd.append('file', makePdfBlob('E2E Paper Content'), 'e2e.pdf');
  const createPaper = await fetch(`${BASE}/admin/papers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: fd,
  });
  const createPaperData = await createPaper.json();
  assert(createPaper.status === 201 && createPaperData.data.id, 'Admin creates paper with PDF upload');
  const paperId = createPaperData.data.id;
  assert(createPaperData.data.effectivePrice === 80, 'Sale price is applied as effective price');

  // Non-admin cannot create paper
  const forbid = await fetch(`${BASE}/admin/papers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}` },
    body: (() => { const f = new FormData(); f.append('title', 'x'); f.append('price', '1'); f.append('file', makePdfBlob(), 'x.pdf'); return f; })(),
  });
  assert(forbid.status === 403, 'Regular user is forbidden from admin paper creation');

  // 5. Admin creates a coupon; print pricing is owned by the primary manager
  console.log('\n[Admin coupon + manager-owned print pricing]');
  const couponCode = `E2E${Date.now().toString().slice(-6)}`;
  const createCoupon = await req('POST', '/admin/coupons', {
    token: adminToken,
    body: { code: couponCode, type: 'PERCENT', value: 20, maxDiscount: 50, description: 'E2E 20%' },
  });
  assert(createCoupon.status === 201, 'Admin creates coupon');

  // Print pricing is set by the PRIMARY manager now (not admin).
  // Bump to a sentinel first so the canonical save below is always a real change (recorded).
  await req('PATCH', '/manager/print-config', { token: managerToken, body: { perPageBW: 1, perPageColor: 1, bindingCost: 1, minCharge: 1 } });
  const cfg = await req('PATCH', '/manager/print-config', {
    token: managerToken,
    body: { perPageBW: 3, perPageColor: 10, bindingCost: 40, minCharge: 25 },
  });
  assert(cfg.status === 200 && cfg.data.data.perPageBW === 3, 'Primary manager sets print pricing');

  // That save is RECORDED as a price-change event in the activity log.
  const chgFeed = await req('GET', '/manager/price-activity?type=change&pageSize=5', { token: managerToken });
  assert(chgFeed.status === 200 && chgFeed.data.items.every((i) => i.kind === 'CHANGE'), 'Change filter returns only price-change events');
  const lastChange = chgFeed.data.items[0];
  assert(lastChange && lastChange.after.perPageBW === 3, 'Latest change event has after-snapshot of new pricing');
  assert(lastChange.before && lastChange.after, 'Change event carries before + after snapshots for the diff popup');

  // Ordinary manager cannot change pricing.
  const ordCfg = await req('PATCH', '/manager/print-config', { token: ordToken, body: { perPageBW: 99 } });
  assert(ordCfg.status === 403, 'Ordinary manager cannot change print pricing');

  // Admin can only VIEW pricing and SEND a change request.
  const adminCfg = await req('GET', '/admin/print-config', { token: adminToken });
  assert(adminCfg.status === 200 && adminCfg.data.data.perPageBW === 3, 'Admin views print pricing (read-only)');
  const adminNoPatch = await req('PATCH', '/admin/print-config', { token: adminToken, body: { perPageBW: 1 } });
  assert(adminNoPatch.status === 404, 'Admin cannot edit print pricing (endpoint removed)');
  const reqChange = await req('POST', '/admin/print-config/requests', {
    token: adminToken,
    body: { message: 'Please raise B/W rate to Rs.4' },
  });
  assert(reqChange.status === 201, 'Admin sends a pricing change request');

  // Only ONE open request at a time — a second POST is rejected (409).
  const dupReq = await req('POST', '/admin/print-config/requests', { token: adminToken, body: { message: 'Another one' } });
  assert(dupReq.status === 409, 'Admin cannot open a second request while one is pending');
  // The open request can be EDITED until acknowledged.
  const editReq = await req('PATCH', `/admin/print-config/requests/${reqChange.data.data.id}`, { token: adminToken, body: { message: 'Please raise B/W rate to Rs.5' } });
  assert(editReq.status === 200 && editReq.data.data.message === 'Please raise B/W rate to Rs.5', 'Admin edits the pending request');
  const cfgOpen = await req('GET', '/admin/print-config', { token: adminToken });
  assert(cfgOpen.data.openRequest && cfgOpen.data.openRequest.id === reqChange.data.data.id, 'Admin sees the single open request');

  // Primary manager sees that request in the activity feed + an open-count for the sidebar badge.
  const reqId = reqChange.data.data.id;
  const feed = await req('GET', '/manager/price-activity?type=request&pageSize=5', { token: managerToken });
  assert(
    feed.status === 200 && feed.data.items.some((r) => r.id === reqId && r.kind === 'REQUEST' && r.status === 'OPEN'),
    'Primary manager sees the admin change request in the activity feed (OPEN)'
  );
  assert(feed.data.pageSize === 5 && typeof feed.data.pages === 'number', 'Activity feed is paginated (5/page)');
  const mgrCfg = await req('GET', '/manager/print-config', { token: managerToken });
  assert(mgrCfg.status === 200 && mgrCfg.data.openCount >= 1, 'Open request count is exposed for the sidebar badge');
  const badge = await req('GET', '/manager/price-requests/count', { token: managerToken });
  assert(badge.status === 200 && badge.data.openCount >= 1, 'Sidebar badge count endpoint returns open requests');
  // Search + date-range filters work on the feed.
  const search = await req('GET', `/manager/price-activity?q=${encodeURIComponent('raise B/W')}`, { token: managerToken });
  assert(search.status === 200 && search.data.items.some((r) => r.id === reqId), 'Activity search matches the request message');
  const future = await req('GET', '/manager/price-activity?from=2999-01-01', { token: managerToken });
  assert(future.status === 200 && future.data.total === 0, 'Date-range filter excludes out-of-range items');
  // Acknowledging keeps the request ON RECORD (status RESOLVED), it is not deleted.
  const ack = await req('PATCH', `/manager/price-requests/${reqId}`, { token: managerToken, body: {} });
  assert(ack.status === 200 && ack.data.acknowledged && ack.data.data.status === 'RESOLVED', 'Primary manager acknowledges the request');
  const afterAck = await req('GET', '/manager/price-activity?type=request', { token: managerToken });
  assert(
    afterAck.data.items.some((r) => r.id === reqId && r.status === 'RESOLVED'),
    'Acknowledged request is still recorded (RESOLVED), not removed'
  );
  const afterCfg = await req('GET', '/manager/print-config', { token: managerToken });
  assert(afterCfg.data.openCount === badge.data.openCount - 1, 'Open count drops by one after acknowledging');
  const ordView = await req('GET', '/manager/print-config', { token: ordToken });
  assert(ordView.status === 403, 'Ordinary manager cannot view the pricing admin panel');
  const ordFeed = await req('GET', '/manager/price-activity', { token: ordToken });
  assert(ordFeed.status === 403, 'Ordinary manager cannot read the pricing activity feed');
  const ordBadge = await req('GET', '/manager/price-requests/count', { token: ordToken });
  assert(ordBadge.status === 403, 'Ordinary manager cannot read the request count');

  // A manager PRICE CHANGE auto-acknowledges any still-open admin requests.
  const req2 = await req('POST', '/admin/print-config/requests', { token: adminToken, body: { message: 'Lower binding to Rs.30' } });
  assert(req2.status === 201, 'Admin opens a fresh request');
  const beforeAuto = await req('GET', '/manager/price-requests/count', { token: managerToken });
  assert(beforeAuto.data.openCount >= 1, 'The fresh request is open');
  await req('PATCH', '/manager/print-config', { token: managerToken, body: { perPageBW: 5 } }); // a real change
  await req('PATCH', '/manager/print-config', { token: managerToken, body: { perPageBW: 3 } }); // reset for downstream
  const afterAuto = await req('GET', '/manager/print-config', { token: managerToken });
  assert(afterAuto.data.openCount === 0, 'Changing price auto-acknowledges all open requests');
  const req2State = await req('GET', '/manager/price-activity?type=request', { token: managerToken });
  assert(req2State.data.items.some((r) => r.id === req2.data.data.id && r.status === 'RESOLVED'), 'The auto-acknowledged request is recorded RESOLVED');

  // 6. Public catalog
  console.log('\n[Public: catalog]');
  const list = await req('GET', '/papers?limit=50');
  assert(list.status === 200 && Array.isArray(list.data.data), 'GET /papers returns catalog');
  assert(list.data.data.some((p) => p.id === paperId), 'New paper appears in catalog');
  const facets = await req('GET', '/papers/facets');
  assert(facets.status === 200 && Array.isArray(facets.data.subjects), 'GET /papers/facets works');
  const detail = await req('GET', `/papers/${createPaperData.data.slug}`);
  assert(detail.status === 200 && detail.data.data.id === paperId, 'GET /papers/:slug works');
  assert(detail.data.data.fileKey === undefined, 'Public paper detail hides fileKey');

  // 7. Coupon validate
  console.log('\n[Coupon validate]');
  const validate = await req('POST', '/coupons/validate', {
    token: userToken,
    body: { code: couponCode, subtotal: 200 },
  });
  assert(validate.status === 200 && validate.data.valid && validate.data.discount === 40, 'Coupon computes discount (20% of 200 = 40)');

  // 8. PURCHASE order + payment (bypass)
  console.log('\n[Order: PURCHASE]');
  const shipping = { name: 'Test User', phone: '9999999999', line1: '1 Test St', city: 'Testville', state: 'TS', pincode: '123456' };
  const purchase = await req('POST', '/orders', {
    token: userToken,
    body: { items: [{ mode: 'BUY', paperId }], couponCode, shipping },
  });
  assert(purchase.status === 201, 'Create PURCHASE order intent (no order persisted yet)');
  assert(purchase.data.orderPreview.subtotal === 80, 'Buy is one-time: subtotal = paper price 80 (no quantity)');
  assert(purchase.data.orderPreview.discount === 16, 'Coupon 20% of 80 = 16 discount');
  assert(purchase.data.orderPreview.total === 64, 'Total = 80 - 16 = 64');
  assert(purchase.data.payment.bypass === true, 'Payment is in bypass mode');
  const verify = await req('POST', '/orders/verify', { token: userToken, body: { token: purchase.data.draftToken } });
  assert(verify.status === 201 && verify.data.paid, 'Verify creates the paid order');
  const po = verify.data.order;
  assert(po.paymentStatus === 'BYPASSED' && po.status === 'BOUGHT', 'Digital buy is marked BOUGHT');
  const rebuy = await req('POST', '/orders', { token: userToken, body: { items: [{ mode: 'BUY', paperId }], shipping } });
  assert(rebuy.status === 400, 'Cannot buy a paper you already own');

  // 9. Bought papers are VIEW-ONLY (no download) — buyer reads watermarked pages.
  console.log('\n[Bought paper: view-only]');
  const dl = await fetch(`${BASE}/download/paper/${paperId}`, { headers: { Authorization: `Bearer ${userToken}` } });
  assert(dl.status === 403, 'Buyer CANNOT download a purchased paper (view-only)');
  const meta = await req('GET', `/view/paper/${paperId}/meta`, { token: userToken });
  assert(meta.status === 200 && meta.data.pages >= 1, 'Owner reads paper metadata (page count)');
  const pageImg = await fetch(`${BASE}/view/paper/${paperId}/page/1`, { headers: { Authorization: `Bearer ${userToken}` } });
  const pageBuf = Buffer.from(await pageImg.arrayBuffer());
  assert(pageImg.status === 200 && pageBuf.slice(0, 4).toString('hex') === '89504e47', 'Owner reads a watermarked PNG page (not the raw PDF)');

  // A different user can neither download nor read it.
  const reg2 = await req('POST', '/auth/register', { body: { name: 'Other', email: `other_${Date.now()}@x.com`, password: 'Test@123' } });
  const dl2 = await fetch(`${BASE}/download/paper/${paperId}`, { headers: { Authorization: `Bearer ${reg2.data.token}` } });
  assert(dl2.status === 403, 'Non-purchaser cannot download the paper');
  const read2 = await req('GET', `/view/paper/${paperId}/meta`, { token: reg2.data.token });
  assert(read2.status === 403, 'Non-purchaser cannot read the paper either');

  // 10. Upload document + PRINT order
  console.log('\n[Order: PRINT with upload]');
  const upFd = new FormData();
  upFd.append('file', makePdfBlob('My assignment'), 'assignment.pdf');
  const up = await fetch(`${BASE}/uploads/document`, { method: 'POST', headers: { Authorization: `Bearer ${userToken}` }, body: upFd });
  const upData = await up.json();
  assert(up.status === 201 && upData.document.id, 'User uploads a PDF document');
  const documentId = upData.document.id;

  const printOrder = await req('POST', '/orders', {
    token: userToken,
    body: { items: [{ mode: 'PRINT', documentId, copies: 3, color: false, doubleSided: false, binding: true, pages: 10 }], shipping },
  });
  assert(printOrder.status === 201, 'Create PRINT order intent');
  // pages 10 * perPageBW 3 = 30, + binding 40 = 70 per copy, * 3 = 210
  assert(printOrder.data.orderPreview.subtotal === 210, `PRINT subtotal computed from pricing model (got ${printOrder.data.orderPreview.subtotal}, expected 210)`);
  const printVerify = await req('POST', '/orders/verify', { token: userToken, body: { token: printOrder.data.draftToken } });
  assert(printVerify.status === 201 && printVerify.data.paid, 'PRINT order payment verified');
  const printPo = printVerify.data.order;

  // 11. Manager view (no pricing) + fulfilment
  console.log('\n[Manager: fulfilment]');
  // Digital buys never reach fulfilment; the PRINT order auto-routes to the
  // single default store, which every manager belongs to.
  const mgrOrders = await req('GET', '/manager/orders', { token: managerToken });
  assert(mgrOrders.status === 200 && mgrOrders.data.data.length >= 1, 'Manager sees print orders for their store');
  assert(mgrOrders.data.data.every((o) => ['PRINT', 'MIXED'].includes(o.type)), 'Manager queue has only print-bearing orders (no digital buys)');
  assert(!mgrOrders.data.data.some((o) => o.id === po.id), 'Digital buy is NOT in the manager queue');
  const sample = mgrOrders.data.data[0];
  assert(sample.total === undefined && sample.subtotal === undefined && sample.items.every((i) => i.unitPrice === undefined), 'Manager order view contains NO pricing');
  assert(sample.shipping && sample.shipping.name, 'Manager sees shipping address');

  const mgrOne = await req('GET', `/manager/orders/${printPo.id}`, { token: managerToken });
  assert(mgrOne.status === 200, 'Manager can open a specific order');
  const printItemId = mgrOne.data.data.items[0].id;
  const mgrDl = await fetch(`${BASE}/download/order-item/${printItemId}`, { headers: { Authorization: `Bearer ${managerToken}` } });
  const mgrDlBuf = Buffer.from(await mgrDl.arrayBuffer());
  assert(mgrDl.status === 200 && mgrDlBuf.slice(0, 5).toString() === '%PDF-', 'Manager downloads the file to print');

  const setStatus = await req('PATCH', `/manager/orders/${printPo.id}/status`, { token: managerToken, body: { status: 'PRINTED' } });
  assert(setStatus.status === 200 && setStatus.data.data.status === 'PRINTED', 'Manager updates order status to PRINTED');

  // Manager cannot access admin
  const mgrForbid = await req('GET', '/admin/stats', { token: managerToken });
  assert(mgrForbid.status === 403, 'Manager is forbidden from admin endpoints');

  // 11b. Primary-manager capabilities: priced print-order record
  console.log('\n[Manager: primary capabilities]');
  const printRecord = await req('GET', '/manager/print-orders', { token: managerToken });
  assert(printRecord.status === 200 && printRecord.data.data.some((o) => o.id === printPo.id), 'Primary manager sees the priced print-order record');
  assert(printRecord.data.data.every((o) => ['PRINT', 'MIXED'].includes(o.type)), 'Print-order record contains only print-bearing orders');
  const recSample = printRecord.data.data.find((o) => o.id === printPo.id);
  assert(recSample.printTotal !== undefined && recSample.items.every((i) => i.unitPrice !== undefined), 'Print-order record INCLUDES print pricing (primary manager)');
  assert(recSample.items.every((i) => i.label && i.label !== undefined) && recSample.pdfCount >= 1, 'Print record hides customer/content identity (neutral labels)');
  const ordRecord = await req('GET', '/manager/print-orders', { token: ordToken });
  assert(ordRecord.status === 403, 'Ordinary manager cannot access the priced print-order record');

  // 11c. Single-order MIXED checkout (buy + print together) + test-series bundle buy
  console.log('\n[Order: MIXED + test series]');
  const catalog = (await req('GET', '/papers?limit=50')).data.data;
  const unowned = catalog.find((p) => p.id !== paperId);
  const mixed = await req('POST', '/orders', {
    token: userToken,
    body: { items: [{ mode: 'BUY', paperId: unowned.id }, { mode: 'PRINT', documentId, copies: 2, binding: false, pages: 5 }], shipping },
  });
  assert(mixed.status === 201, 'Mixed buy+print checkout intent');
  const mixedV = await req('POST', '/orders/verify', { token: userToken, body: { token: mixed.data.draftToken } });
  assert(mixedV.data.order.type === 'MIXED', 'A buy+print bag is ONE order of type MIXED');
  assert(mixedV.data.order.status === 'PLACED', 'Mixed order enters fulfilment (it has printing)');
  const buyItems = mixedV.data.order.items.filter((i) => i.kind === 'PAPER');
  const printItems = mixedV.data.order.items.filter((i) => i.kind === 'PRINT');
  assert(buyItems.length === 1 && printItems.length === 1, 'Mixed order holds both the bought paper and the print item');
  const mq = await req('GET', `/manager/orders?q=${encodeURIComponent(mixedV.data.order.orderNumber)}`, { token: managerToken });
  const mixedInQueue = mq.data.data.find((o) => o.id === mixedV.data.order.id);
  assert(mixedInQueue && mixedInQueue.items.length === 1 && mixedInQueue.items.every((i) => i.kind === 'PRINT'), 'Manager sees ONLY the print item of a mixed order');

  const series = (await req('GET', '/series')).data.data[0];
  const seriesBuy = await req('POST', '/orders', { token: reg2.data.token, body: { items: [{ mode: 'BUY_SERIES', seriesId: series.slug }], shipping } });
  assert(seriesBuy.status === 201, 'Test series is purchasable as a bundle');
  assert(seriesBuy.data.orderPreview.subtotal === series.effectivePrice, `Bundle priced at series effective price (got ${seriesBuy.data.orderPreview.subtotal}, expected ${series.effectivePrice})`);
  const sv = await req('POST', '/orders/verify', { token: reg2.data.token, body: { token: seriesBuy.data.draftToken } });
  assert(sv.data.order.type === 'PURCHASE' && sv.data.order.status === 'BOUGHT', 'Series buy is a digital BOUGHT order');
  const owned2 = await req('GET', '/orders/owned-ids', { token: reg2.data.token });
  assert(owned2.data.ids.length >= series.paperCount, 'Buying a series grants ownership of ALL its papers');

  // Store debt (admin owes the store the print revenue) + manager print-revenue dashboard.
  const debt = await req('GET', '/admin/store-debt', { token: adminToken });
  assert(debt.status === 200 && typeof debt.data.totalDebt === 'number' && debt.data.totalDebt > 0, 'Admin sees store debt (print revenue owed) with a breakdown');
  assert(debt.data.data.every((r) => r.printTotal !== undefined), 'Store-debt rows carry the per-order print total');
  const summary = await req('GET', '/manager/summary', { token: managerToken });
  assert(summary.status === 200 && summary.data.printRevenue > 0, 'Primary manager dashboard shows store print revenue');
  const ordSummary = await req('GET', '/manager/summary', { token: ordToken });
  assert(ordSummary.status === 403, 'Ordinary manager cannot see the revenue dashboard');

  // 11c. Staff management (primary manager owns it; admin has none)
  console.log('\n[Manager: staff management]');
  const staffEmail = `mgr_${Date.now()}@cleverclass.com`;
  const addStaff = await req('POST', '/manager/staff', {
    token: managerToken,
    body: { name: 'Added Manager', email: staffEmail, password: 'Manager@123', isPrimaryManager: false },
  });
  assert(addStaff.status === 201 && addStaff.data.data.isPrimaryManager === false, 'Primary manager adds an ordinary manager');
  const newMgrId = addStaff.data.data.id;
  const staffList = await req('GET', '/manager/staff', { token: managerToken });
  assert(staffList.status === 200 && staffList.data.data.some((m) => m.id === newMgrId), 'New manager appears in the staff list');
  const ordAdd = await req('POST', '/manager/staff', {
    token: ordToken,
    body: { name: 'Nope', email: `nope_${Date.now()}@x.com`, password: 'Manager@123' },
  });
  assert(ordAdd.status === 403, 'Ordinary manager cannot add staff');
  const promote = await req('PATCH', `/manager/staff/${newMgrId}`, { token: managerToken, body: { isPrimaryManager: true } });
  assert(promote.status === 200 && promote.data.data.isPrimaryManager === true, 'Primary manager promotes a manager to primary');
  const del = await req('DELETE', `/manager/staff/${newMgrId}`, { token: managerToken });
  assert(del.status === 200 && del.data.deleted, 'Primary manager removes a manager');
  const demoteSelf = await req('PATCH', `/manager/staff/${managerId}`, { token: managerToken, body: { isPrimaryManager: false } });
  assert(demoteSelf.status === 409, 'Cannot demote the last remaining primary manager (lock-out guard)');

  // 11d. Admin no longer has store or manager authority
  console.log('\n[Admin: store/manager authority removed]');
  const noStores = await req('GET', '/admin/stores', { token: adminToken });
  assert(noStores.status === 404, 'Admin store endpoints are removed (single-store model)');
  const admTouchMgr = await req('PATCH', `/admin/users/${ordId}`, { token: adminToken, body: { isActive: false } });
  assert(admTouchMgr.status === 403, 'Admin cannot change a manager (owned by the primary manager)');

  // 12. Admin dashboards
  console.log('\n[Admin: dashboard]');
  const stats = await req('GET', '/admin/stats', { token: adminToken });
  assert(stats.status === 200 && stats.data.totals.orders >= 2, 'Admin stats returns totals');
  assert(stats.data.totals.revenue > 0, 'Admin stats includes revenue');
  const adminOrders = await req('GET', '/admin/orders', { token: adminToken });
  assert(adminOrders.status === 200 && adminOrders.data.data[0].total !== undefined, 'Admin order list includes full pricing');
  // Pagination envelope: total + page + pageSize + pages.
  assert(
    typeof adminOrders.data.total === 'number' && adminOrders.data.page === 1 && typeof adminOrders.data.pages === 'number',
    'Admin orders returns a pagination envelope (total/page/pages)'
  );
  const pg1 = await req('GET', '/admin/orders?page=1&pageSize=1', { token: adminToken });
  assert(pg1.data.data.length === 1 && pg1.data.pageSize === 1, 'Admin orders respects pageSize');
  assert(pg1.data.pages === pg1.data.total, 'pages = ceil(total/1) with pageSize 1');
  // Server-side search by order number.
  const someOrderNo = adminOrders.data.data[0].orderNumber;
  const searched = await req('GET', `/admin/orders?q=${encodeURIComponent(someOrderNo)}`, { token: adminToken });
  assert(searched.data.data.some((o) => o.orderNumber === someOrderNo), 'Admin orders server-side search by order number works');
  // Fulfilment stage filter returns only paid + in-pipeline orders.
  const stageF = await req('GET', '/admin/orders?stage=fulfilment', { token: adminToken });
  assert(stageF.status === 200 && stageF.data.data.every((o) => ['PAID', 'BYPASSED'].includes(o.paymentStatus)), 'Fulfilment stage filter returns only paid orders');
  // Users list is paginated too.
  const usersPage = await req('GET', '/admin/users?pageSize=2', { token: adminToken });
  assert(usersPage.status === 200 && usersPage.data.data.length <= 2 && typeof usersPage.data.total === 'number', 'Admin users is paginated');
  const userSearch = await req('GET', '/admin/users?q=admin', { token: adminToken });
  assert(userSearch.data.data.some((u) => u.email.includes('admin') || u.name.toLowerCase().includes('admin')), 'Admin users server-side search works');

  // 13. Cancel + refund lifecycle
  console.log('\n[Refund lifecycle]');
  const cancel = await req('PATCH', `/admin/orders/${po.id}/status`, { token: adminToken, body: { status: 'CANCELLED' } });
  assert(cancel.status === 200 && cancel.data.data.status === 'CANCELLED', 'Admin cancels a paid order');
  assert(cancel.data.data.refundStatus === 'INITIATED', 'Cancelling a paid order starts a refund (INITIATED)');
  const relock = await req('PATCH', `/admin/orders/${po.id}/status`, { token: adminToken, body: { status: 'PROCESSING' } });
  assert(relock.status === 409, 'Cancelled order status is locked (409)');
  const refundsList = await req('GET', '/admin/refunds', { token: adminToken });
  assert(refundsList.status === 200 && refundsList.data.data.some((o) => o.id === po.id), 'Refund appears in admin refunds list');
  const complete = await req('PATCH', `/admin/orders/${po.id}/refund`, { token: adminToken, body: { action: 'complete' } });
  assert(complete.status === 200 && complete.data.data.refundStatus === 'COMPLETED' && complete.data.data.paymentStatus === 'REFUNDED', 'Refund completes → payment REFUNDED');

  // Summary
  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed) {
    console.log('Failures:');
    fails.forEach((f) => console.log(`   - ${f}`));
    process.exit(1);
  }
  console.log('All API tests passed ✅\n');
}

main().catch((e) => {
  console.error('Test run crashed:', e);
  process.exit(1);
});
