// Server-side PDF page rendering with a per-viewer watermark. Used by the
// in-browser paper viewer so the raw PDF never leaves the server — only
// watermarked page images do.
import path from 'path';
import { fileURLToPath } from 'url';
import { createCanvas, DOMMatrix, Path2D, ImageData, Image } from '@napi-rs/canvas';

// pdfjs needs these DOM globals when running in Node.
globalThis.DOMMatrix ??= DOMMatrix;
globalThis.Path2D ??= Path2D;
globalThis.ImageData ??= ImageData;
globalThis.Image ??= Image;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STD_FONTS = path.join(__dirname, '../../node_modules/pdfjs-dist/standard_fonts/');

let _pdfjs = null;
async function pdfjsLib() {
  if (!_pdfjs) _pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return _pdfjs;
}

class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(cw, width, height) {
    cw.canvas.width = width;
    cw.canvas.height = height;
  }
  destroy(cw) {
    cw.canvas.width = 0;
    cw.canvas.height = 0;
  }
}

async function loadDoc(buffer) {
  const pdfjs = await pdfjsLib();
  return pdfjs.getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: STD_FONTS,
    canvasFactory: new NodeCanvasFactory(),
    verbosity: 0,
  }).promise;
}

function drawWatermark(ctx, w, h, text) {
  // Diagonal, repeating, semi-transparent tiles across the whole page.
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = '#1f47f5';
  ctx.font = `bold ${Math.round(w / 26)}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-Math.PI / 6);
  const step = Math.round(w / 8);
  for (let y = -h; y < h; y += step) {
    ctx.fillText(text, -w, y);
    ctx.fillText(text, 0, y + step / 2);
  }
  ctx.restore();

  // A solid footer line so the identity is always legible.
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = '#111827';
  ctx.font = `${Math.round(w / 46)}px sans-serif`;
  ctx.fillText(text, 24, h - 22);
  ctx.restore();
}

/** Draw a small solid padlock glyph (w wide) with its top-left at (x, y). */
function drawLock(ctx, x, y, w, color) {
  const bodyW = w;
  const bodyH = w * 0.78;
  const bodyY = y + w * 0.42;
  const r = w * 0.16;
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = w * 0.14;
  // shackle
  ctx.beginPath();
  ctx.arc(x + bodyW / 2, bodyY, bodyW * 0.3, Math.PI, 0);
  ctx.stroke();
  // body
  ctx.beginPath();
  ctx.moveTo(x + r, bodyY);
  ctx.lineTo(x + bodyW - r, bodyY);
  ctx.quadraticCurveTo(x + bodyW, bodyY, x + bodyW, bodyY + r);
  ctx.lineTo(x + bodyW, bodyY + bodyH - r);
  ctx.quadraticCurveTo(x + bodyW, bodyY + bodyH, x + bodyW - r, bodyY + bodyH);
  ctx.lineTo(x + r, bodyY + bodyH);
  ctx.quadraticCurveTo(x, bodyY + bodyH, x, bodyY + bodyH - r);
  ctx.lineTo(x, bodyY + r);
  ctx.quadraticCurveTo(x, bodyY, x + r, bodyY);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Render a *sales teaser* of the first page for shoppers who have NOT bought
 * the paper. The top `clearRatio` of the page is shown normally; everything
 * below is heavily blurred and veiled, and the whole thing is watermarked —
 * so a buyer can judge the paper without the content being usable.
 * @returns {Promise<{ png: Buffer, pages: number }>}
 */
export async function renderPreviewPage(buffer, watermarkText, { scale = 2, clearRatio = 0.4, blur = 14 } = {}) {
  const factory = new NodeCanvasFactory();
  const doc = await loadDoc(buffer);
  try {
    const pages = doc.numPages;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale });
    const w = Math.ceil(viewport.width);
    const h = Math.ceil(viewport.height);

    // 1) render the real page onto a base canvas
    const base = createCanvas(w, h);
    const bctx = base.getContext('2d');
    bctx.fillStyle = '#ffffff';
    bctx.fillRect(0, 0, w, h);
    await page.render({ canvasContext: bctx, viewport, canvasFactory: factory }).promise;

    // 2) composite: clear top, blurred bottom
    const out = createCanvas(w, h);
    const ctx = out.getContext('2d');
    ctx.drawImage(base, 0, 0);

    const cutY = Math.round(h * clearRatio);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, cutY, w, h - cutY);
    ctx.clip();
    ctx.filter = `blur(${blur}px)`;
    // draw a couple of times so the blur reads as "frosted", not just soft
    ctx.drawImage(base, 0, 0);
    ctx.drawImage(base, 0, 0);
    ctx.restore();

    // 3) white veil that deepens toward the bottom of the hidden region
    const veil = ctx.createLinearGradient(0, cutY, 0, h);
    veil.addColorStop(0, 'rgba(255,255,255,0)');
    veil.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    veil.addColorStop(1, 'rgba(255,255,255,0.82)');
    ctx.fillStyle = veil;
    ctx.fillRect(0, cutY, w, h - cutY);

    // 4) a crisp divider + lock label at the reveal line
    ctx.save();
    ctx.strokeStyle = 'rgba(91,88,235,0.55)';
    ctx.lineWidth = Math.max(2, Math.round(w / 320));
    ctx.setLineDash([Math.round(w / 60), Math.round(w / 90)]);
    ctx.beginPath();
    ctx.moveTo(0, cutY);
    ctx.lineTo(w, cutY);
    ctx.stroke();
    ctx.restore();

    const labelY = cutY + Math.round(h * 0.14);
    const fs = Math.round(w / 30);
    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = '#4340C4';
    ctx.font = `bold ${fs}px sans-serif`;
    ctx.textAlign = 'left';
    const label = 'Purchase to read the full paper';
    const textW = ctx.measureText(label).width;
    const lockW = fs * 0.9;
    const startX = (w - (lockW + fs * 0.5 + textW)) / 2;
    drawLock(ctx, startX, labelY - fs * 0.72, lockW, '#4340C4');
    ctx.fillText(label, startX + lockW + fs * 0.5, labelY);
    ctx.restore();

    // 5) watermark the whole teaser
    drawWatermark(ctx, w, h, watermarkText);

    const png = await out.encode('png');
    return { png, pages };
  } finally {
    await doc.destroy();
  }
}

/**
 * Render a FULL page (for a verified owner) as a watermarked PNG. The raw PDF
 * never leaves the server — only per-viewer watermarked images do, so the
 * content can be read but not cleanly extracted.
 * @returns {Promise<{ png: Buffer, pages: number }>}
 */
export async function renderOwnerPage(buffer, pageNum, watermarkText, { scale = 2 } = {}) {
  const factory = new NodeCanvasFactory();
  const doc = await loadDoc(buffer);
  try {
    const pages = doc.numPages;
    const n = Math.min(Math.max(1, pageNum || 1), pages);
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale });
    const w = Math.ceil(viewport.width);
    const h = Math.ceil(viewport.height);

    const out = createCanvas(w, h);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    await page.render({ canvasContext: ctx, viewport, canvasFactory: factory }).promise;
    drawWatermark(ctx, w, h, watermarkText);

    const png = await out.encode('png');
    return { png, pages };
  } finally {
    await doc.destroy();
  }
}
