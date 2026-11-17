// Lets node --test import the *.server.js modules without a database or a .env file.
// - `../db.server` resolves to a stub whose default export forwards to globalThis.__multishipTestDb.
// - settings.server.js only loads .env when DHL_API_KEY is unset, so a placeholder is set first.
//   Tests never call DHL or Shopify: every client is a fake passed in by the test.
import { registerHooks } from 'node:module';

process.env.DHL_API_KEY ||= 'test-placeholder-not-a-key';

const stubUrl = new URL('./db-stub.js', import.meta.url).href;
const shopifyStubUrl = new URL('./shopify-stub.js', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '../db.server' || specifier === '../../db.server') return { url: stubUrl, shortCircuit: true };
    if (specifier === '../shopify.server') return { url: shopifyStubUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  // Route modules are .jsx; the parcel route has no JSX, so it loads as a plain ES module.
  load(url, context, nextLoad) {
    if (url.endsWith('.jsx')) return { ...nextLoad(url, { ...context, format: 'module' }), format: 'module', shortCircuit: true };
    return nextLoad(url, context);
  },
});

export function useTestDb(db) {
  globalThis.__multishipTestDb = db;
  return db;
}
