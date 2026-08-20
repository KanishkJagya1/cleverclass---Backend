import app from './app.js';
import env from './config/env.js';
import prisma from './lib/prisma.js';
import { activeStorageProvider } from './config/env.js';

async function start() {
  try {
    await prisma.$connect();
    // eslint-disable-next-line no-console
    console.log('✔ Database connected');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('✖ Failed to connect to database:', err.message);
    process.exit(1);
  }

  app.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`\n🚀 CleverClass API running on http://localhost:${env.port}`);
    console.log(`   Env: ${env.nodeEnv}`);
    console.log(`   Storage provider: ${activeStorageProvider()}`);
    console.log(`   Payment bypass: ${env.payment.bypass || !env.payment.enabled}`);
  });
}

start();

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
