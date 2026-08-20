import dotenv from 'dotenv';
dotenv.config();

const bool = (v, def = false) => {
  if (v === undefined || v === null || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  port: parseInt(process.env.PORT || '5000', 10),
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  databaseUrl: process.env.DATABASE_URL,

  jwtSecret: process.env.JWT_SECRET || 'dev-secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    get enabled() {
      return Boolean(this.clientId);
    },
  },

  payment: {
    bypass: bool(process.env.PAYMENT_BYPASS, true),
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
    razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
    get enabled() {
      return Boolean(this.razorpayKeyId && this.razorpayKeySecret);
    },
  },

  storage: {
    localDir: process.env.STORAGE_LOCAL_DIR || 'uploads',
    s3: {
      bucket: process.env.S3_BUCKET || '',
      region: process.env.S3_REGION || '',
      accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
      endpoint: process.env.S3_ENDPOINT || '',
      get configured() {
        return Boolean(this.bucket && this.region && this.accessKeyId && this.secretAccessKey);
      },
    },
    gcp: {
      bucket: process.env.GCP_BUCKET || '',
      projectId: process.env.GCP_PROJECT_ID || '',
      credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
      get configured() {
        return Boolean(this.bucket);
      },
    },
  },

  seed: {
    adminEmail: process.env.ADMIN_EMAIL || 'admin@cleverclass.com',
    adminPassword: process.env.ADMIN_PASSWORD || 'Admin@123',
    managerEmail: process.env.MANAGER_EMAIL || 'manager@cleverclass.com',
    managerPassword: process.env.MANAGER_PASSWORD || 'Manager@123',
  },
};

/** Which storage provider is active based on env. */
export function activeStorageProvider() {
  if (env.storage.s3.configured) return 'S3';
  if (env.storage.gcp.configured) return 'GCP';
  return 'LOCAL';
}

export default env;
