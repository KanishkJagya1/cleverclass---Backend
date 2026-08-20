import prisma from './prisma.js';

const DEFAULT_STORE_CODE = 'MAIN';

/**
 * The system runs a single default store. Every PRINT order is fulfilled by it.
 * Returns the active default store, creating it on first use if missing so the
 * app never has "nowhere to route an order".
 */
export async function getDefaultStore() {
  let store = await prisma.store.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
  if (!store) {
    store = await prisma.store.upsert({
      where: { code: DEFAULT_STORE_CODE },
      update: { isActive: true },
      create: { code: DEFAULT_STORE_CODE, name: 'CleverClass Store', isActive: true },
    });
  }
  return store;
}

/** Convenience: the id of the single default store (used to route PRINT orders). */
export async function getDefaultStoreId() {
  return (await getDefaultStore()).id;
}
