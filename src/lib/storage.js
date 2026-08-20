import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import env, { activeStorageProvider } from '../config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// backend/uploads
const LOCAL_ROOT = path.resolve(__dirname, '../../', env.storage.localDir);

function ensureLocalRoot() {
  if (!fs.existsSync(LOCAL_ROOT)) fs.mkdirSync(LOCAL_ROOT, { recursive: true });
}

function safeName(originalName = 'file') {
  const ext = path.extname(originalName) || '';
  const base = path
    .basename(originalName, ext)
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .slice(0, 40);
  const rand = crypto.randomBytes(8).toString('hex');
  return `${Date.now()}-${rand}-${base}${ext}`;
}

// ---------------- S3 ----------------
let _s3;
async function getS3() {
  if (_s3) return _s3;
  const { S3Client } = await import('@aws-sdk/client-s3');
  const cfg = env.storage.s3;
  _s3 = new S3Client({
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
  });
  return _s3;
}

// ---------------- GCP ----------------
let _gcs;
async function getGcsBucket() {
  if (_gcs) return _gcs;
  const { Storage } = await import('@google-cloud/storage');
  const cfg = env.storage.gcp;
  const opts = {};
  if (cfg.projectId) opts.projectId = cfg.projectId;
  if (cfg.credentials && cfg.credentials.trim().startsWith('{')) {
    opts.credentials = JSON.parse(cfg.credentials);
  } else if (cfg.credentials) {
    opts.keyFilename = cfg.credentials;
  }
  const storage = new Storage(opts);
  _gcs = storage.bucket(cfg.bucket);
  return _gcs;
}

/**
 * Save a buffer to the active storage provider.
 * @returns {Promise<{provider:'LOCAL'|'S3'|'GCP', key:string, fileName:string, size:number}>}
 */
export async function saveFile({ buffer, originalName, mimetype = 'application/octet-stream', folder = 'misc' }) {
  const provider = activeStorageProvider();
  const fileName = originalName || 'file';
  const key = `${folder}/${safeName(fileName)}`;
  const size = buffer.length;

  if (provider === 'S3') {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const s3 = await getS3();
    await s3.send(
      new PutObjectCommand({
        Bucket: env.storage.s3.bucket,
        Key: key,
        Body: buffer,
        ContentType: mimetype,
      })
    );
    return { provider, key, fileName, size };
  }

  if (provider === 'GCP') {
    const bucket = await getGcsBucket();
    await bucket.file(key).save(buffer, { contentType: mimetype, resumable: false });
    return { provider, key, fileName, size };
  }

  // LOCAL
  ensureLocalRoot();
  const full = path.join(LOCAL_ROOT, key);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buffer);
  return { provider, key, fileName, size };
}

/**
 * Fetch a stored object as a buffer (works across providers).
 * @returns {Promise<{buffer:Buffer, contentType:string}>}
 */
export async function getFile({ provider, key }) {
  if (provider === 'S3') {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const s3 = await getS3();
    const res = await s3.send(new GetObjectCommand({ Bucket: env.storage.s3.bucket, Key: key }));
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return { buffer: Buffer.concat(chunks), contentType: res.ContentType || 'application/octet-stream' };
  }

  if (provider === 'GCP') {
    const bucket = await getGcsBucket();
    const [buffer] = await bucket.file(key).download();
    const [meta] = await bucket.file(key).getMetadata().catch(() => [{}]);
    return { buffer, contentType: meta.contentType || 'application/octet-stream' };
  }

  const full = path.join(LOCAL_ROOT, key);
  if (!fs.existsSync(full)) throw Object.assign(new Error('File not found'), { status: 404 });
  return { buffer: fs.readFileSync(full), contentType: 'application/octet-stream' };
}

export async function deleteFile({ provider, key }) {
  try {
    if (provider === 'S3') {
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      const s3 = await getS3();
      await s3.send(new DeleteObjectCommand({ Bucket: env.storage.s3.bucket, Key: key }));
    } else if (provider === 'GCP') {
      const bucket = await getGcsBucket();
      await bucket.file(key).delete();
    } else {
      const full = path.join(LOCAL_ROOT, key);
      if (fs.existsSync(full)) fs.unlinkSync(full);
    }
  } catch (e) {
    // best-effort delete
  }
}

export { LOCAL_ROOT };
