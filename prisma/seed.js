import bcrypt from 'bcryptjs';
import prisma from '../src/lib/prisma.js';
import env from '../src/config/env.js';
import { saveFile } from '../src/lib/storage.js';
import { slugify } from '../src/utils/slug.js';

/** Build a minimal but valid multi-page PDF with a title on the first page. */
function makePdf(title = 'CleverClass', pages = 3) {
  const esc = (s) => s.replace(/[()\\]/g, (c) => `\\${c}`);
  const objects = [];
  // 1: Catalog, 2: Pages, then per page: Page + Content
  const pageObjNums = [];
  let objNum = 3;
  const pageDefs = [];
  for (let i = 0; i < pages; i++) {
    const pageNum = objNum++;
    const contentNum = objNum++;
    pageObjNums.push(pageNum);
    const text = i === 0 ? title : `${title} — page ${i + 1}`;
    const stream = `BT /F1 20 Tf 72 720 Td (${esc(text)}) Tj ET`;
    pageDefs.push({ pageNum, contentNum, stream });
  }

  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages} >>`;
  for (const p of pageDefs) {
    objects[p.pageNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${p.contentNum} 0 R >>`;
    objects[p.contentNum] = `<< /Length ${p.stream.length} >>\nstream\n${p.stream}\nendstream`;
  }

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  const total = objNum - 1;
  for (let i = 1; i <= total; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= total; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

async function upsertUser({ name, email, password, role, phone, storeId, isPrimaryManager }) {
  const passwordHash = await bcrypt.hash(password, 10);
  const extra = {
    ...(storeId !== undefined ? { storeId } : {}),
    ...(isPrimaryManager !== undefined ? { isPrimaryManager } : {}),
  };
  return prisma.user.upsert({
    where: { email },
    update: { name, role, passwordHash, phone, ...extra },
    create: { name, email, passwordHash, role, phone, ...extra },
  });
}

const SAMPLE_PAPERS = [
  { title: 'CBSE Class 10 Mathematics — Board Exam 2024', subject: 'Mathematics', board: 'CBSE', grade: 'Class 10', year: 2024, price: 49, salePrice: 29, featured: true, pages: 12, desc: 'Full-length solved board paper with marking scheme.' },
  { title: 'CBSE Class 12 Physics — Sample Paper', subject: 'Physics', board: 'CBSE', grade: 'Class 12', year: 2024, price: 59, featured: true, pages: 10, desc: 'Latest pattern sample paper with answer key.' },
  { title: 'ICSE Class 10 English Literature', subject: 'English', board: 'ICSE', grade: 'Class 10', year: 2023, price: 39, pages: 8, desc: 'Comprehensive literature question bank.' },
  { title: 'CBSE Class 12 Chemistry — Previous Year', subject: 'Chemistry', board: 'CBSE', grade: 'Class 12', year: 2023, price: 55, salePrice: 35, pages: 11, desc: 'Previous year solved paper with concepts.' },
  { title: 'State Board Class 10 Science', subject: 'Science', board: 'State Board', grade: 'Class 10', year: 2024, price: 45, featured: true, pages: 9, desc: 'Chapter-wise important questions.' },
  { title: 'CBSE Class 12 Biology — Mock Test', subject: 'Biology', board: 'CBSE', grade: 'Class 12', year: 2024, price: 52, pages: 10, desc: 'NEET-oriented mock test paper.' },
];

async function main() {
  console.log('Seeding CleverClass…');

  // Single default store — every print order is fulfilled here.
  const store = await prisma.store.upsert({
    where: { code: 'MAIN' },
    update: { name: 'CleverClass Store', isActive: true },
    create: { code: 'MAIN', name: 'CleverClass Store', isActive: true },
  });
  // Retire any legacy stores from the old multi-store model.
  await prisma.store.updateMany({ where: { code: { not: 'MAIN' } }, data: { isActive: false } });
  console.log('  ✔ Default store: MAIN (CleverClass Store)');

  const admin = await upsertUser({
    name: 'CleverClass Admin',
    email: env.seed.adminEmail,
    password: env.seed.adminPassword,
    role: 'ADMIN',
    phone: '9000000001',
  });
  const manager = await upsertUser({
    name: 'Primary Manager',
    email: env.seed.managerEmail,
    password: env.seed.managerPassword,
    role: 'MANAGER',
    phone: '9000000002',
    storeId: store.id,
    isPrimaryManager: true,
  });
  await upsertUser({
    name: 'Ordinary Manager',
    email: 'manager2@cleverclass.com',
    password: 'Manager@123',
    role: 'MANAGER',
    phone: '9000000004',
    storeId: store.id,
    isPrimaryManager: false,
  });
  await upsertUser({
    name: 'Demo Student',
    email: 'student@cleverclass.com',
    password: 'Student@123',
    role: 'USER',
    phone: '9000000003',
  });
  console.log(`  ✔ Admin: ${admin.email} / ${env.seed.adminPassword}`);
  console.log(`  ✔ Primary manager: ${manager.email} / ${env.seed.managerPassword}`);
  console.log('  ✔ Ordinary manager: manager2@cleverclass.com / Manager@123');
  console.log('  ✔ Demo user: student@cleverclass.com / Student@123');

  // Consolidate legacy data onto the single default store.
  await prisma.user.updateMany({ where: { role: 'MANAGER', NOT: { storeId: store.id } }, data: { storeId: store.id } });
  await prisma.order.updateMany({ where: { storeId: { not: null }, NOT: { storeId: store.id } }, data: { storeId: store.id } });
  await prisma.order.updateMany({ where: { type: 'PRINT', storeId: null }, data: { storeId: store.id } });

  // Print config
  await prisma.printConfig.upsert({ where: { id: 'default' }, update: {}, create: { id: 'default' } });

  // Papers (only seed if none exist)
  const existing = await prisma.paper.count();
  if (existing === 0) {
    for (const s of SAMPLE_PAPERS) {
      const pdf = makePdf(s.title, s.pages);
      const saved = await saveFile({
        buffer: pdf,
        originalName: `${slugify(s.title)}.pdf`,
        mimetype: 'application/pdf',
        folder: 'papers',
      });
      await prisma.paper.create({
        data: {
          title: s.title,
          slug: slugify(s.title),
          description: s.desc,
          subject: s.subject,
          board: s.board,
          grade: s.grade,
          year: s.year,
          price: s.price,
          salePrice: s.salePrice ?? null,
          saleEndsAt: s.salePrice ? new Date(Date.now() + 14 * 24 * 3600 * 1000) : null,
          previewText: 'This is a preview. Purchase to download the full question paper.',
          storageProvider: saved.provider,
          fileKey: saved.key,
          fileName: saved.fileName,
          fileSize: saved.size,
          pages: s.pages,
          isActive: true,
          isFeatured: !!s.featured,
        },
      });
    }
    console.log(`  ✔ Created ${SAMPLE_PAPERS.length} sample papers`);
  } else {
    console.log(`  • Papers already present (${existing}), skipping paper seed`);
  }

  // Test series (club a few papers into buyable bundles) — only if none exist.
  const seriesCount = await prisma.testSeries.count();
  if (seriesCount === 0) {
    const allPapers = await prisma.paper.findMany({ orderBy: { createdAt: 'asc' } });
    const cbse = allPapers.filter((p) => p.board === 'CBSE');
    const cls10 = allPapers.filter((p) => p.grade === 'Class 10');
    const bundles = [
      { title: 'CBSE Full Board Prep Series', subject: 'Multiple', papers: cbse, price: 149, salePrice: 99, featured: true },
      { title: 'Class 10 Complete Pack', subject: 'Multiple', papers: cls10, price: 129, featured: false },
    ];
    for (const b of bundles) {
      if (b.papers.length < 2) continue;
      const series = await prisma.testSeries.create({
        data: {
          title: b.title,
          slug: slugify(b.title),
          description: `A curated bundle of ${b.papers.length} papers.`,
          subject: b.subject,
          price: b.price,
          salePrice: b.salePrice ?? null,
          isActive: true,
          isFeatured: !!b.featured,
        },
      });
      await prisma.testSeriesPaper.createMany({
        data: b.papers.map((p, i) => ({ seriesId: series.id, paperId: p.id, position: i })),
        skipDuplicates: true,
      });
    }
    console.log(`  ✔ Created ${bundles.length} test series`);
  } else {
    console.log(`  • Test series already present (${seriesCount}), skipping`);
  }

  // Coupons
  const coupons = [
    { code: 'WELCOME10', description: '10% off your first order', type: 'PERCENT', value: 10, maxDiscount: 50 },
    { code: 'FLAT20', description: 'Flat ₹20 off orders above ₹100', type: 'FLAT', value: 20, minOrder: 100 },
    { code: 'STUDENT25', description: '25% off (max ₹100)', type: 'PERCENT', value: 25, maxDiscount: 100, minOrder: 50 },
  ];
  for (const c of coupons) {
    await prisma.coupon.upsert({
      where: { code: c.code },
      update: {},
      create: { ...c, expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000) },
    });
  }
  console.log(`  ✔ Created ${coupons.length} coupons`);

  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
