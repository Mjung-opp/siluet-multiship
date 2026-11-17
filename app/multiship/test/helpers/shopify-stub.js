// Stand-in for app/shopify.server.js in tests: unauthenticated.admin(shop) returns the test's fake Admin client.
export const unauthenticated = {
  async admin(shop) {
    const admin = globalThis.__multishipTestShopify?.[shop];
    if (!admin) throw new Error('No offline session');
    return { admin };
  },
};
export const authenticate = {};
