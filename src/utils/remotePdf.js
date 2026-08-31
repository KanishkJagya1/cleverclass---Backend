/**
 * Download a file from a public URL (Google Drive / Dropbox / any direct link).
 * Used by the CSV bulk paper importer, where each row carries a cloud PDF link.
 * Best-effort: throws a clear Error on failure so the caller can flag that row.
 */
const MAX_BYTES = 25 * 1024 * 1024; // matches the multipart upload cap
const TIMEOUT_MS = 30000;
const UA = 'Mozilla/5.0 (compatible; CleverClass/1.0)';

/** Rewrite common share links to a direct-download URL. */
export function normalizeDownloadUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(String(url).trim());
    if (u.hostname.includes('drive.google.com')) {
      const m = u.pathname.match(/\/file\/d\/([^/]+)/);
      const id = m ? m[1] : u.searchParams.get('id');
      if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
    }
    if (u.hostname.includes('dropbox.com')) {
      u.searchParams.set('dl', '1');
      return u.toString();
    }
    return u.toString();
  } catch {
    return url;
  }
}

const isPdf = (buf) => buf && buf.length > 4 && buf.subarray(0, 5).toString('latin1').startsWith('%PDF');
const isImage = (mimetype) => typeof mimetype === 'string' && mimetype.startsWith('image/');

async function fetchBuffer(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { buf, contentType: res.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch a PDF by URL, returning a Buffer. Handles the Google-Drive large-file confirm page. */
export async function fetchRemotePdf(rawUrl) {
  const url = normalizeDownloadUrl(rawUrl);
  try {
    let { buf } = await fetchBuffer(url);
    // Google Drive returns an HTML confirm interstitial for large files.
    if (!isPdf(buf) && buf.subarray(0, 1024).toString('latin1').toLowerCase().includes('<html')) {
      const html = buf.toString('latin1');
      const cm = html.match(/confirm=([0-9A-Za-z_-]+)/) || html.match(/name="confirm"\s+value="([^"]+)"/);
      const idm = url.match(/[?&]id=([^&]+)/);
      if (cm && idm) {
        buf = (await fetchBuffer(`https://drive.google.com/uc?export=download&confirm=${cm[1]}&id=${idm[1]}`)).buf;
      }
    }
    if (buf.length > MAX_BYTES) throw new Error('File exceeds the 25 MB limit');
    if (!isPdf(buf)) throw new Error('Link did not return a PDF (check the file is shared publicly)');
    return buf;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Download timed out');
    throw new Error(e.message || 'Download failed');
  }
}

/** Fetch a cover image by URL, returning { buffer, mimetype }. Best-effort. */
export async function fetchRemoteImage(rawUrl) {
  const url = normalizeDownloadUrl(rawUrl);
  const { buf, contentType } = await fetchBuffer(url);
  if (buf.length > MAX_BYTES) throw new Error('Image exceeds the 25 MB limit');
  const mimetype = isImage(contentType) ? contentType : 'image/jpeg';
  if (!isImage(contentType) && buf.subarray(0, 1024).toString('latin1').toLowerCase().includes('<html')) {
    throw new Error('Link did not return an image');
  }
  return { buffer: buf, mimetype };
}
