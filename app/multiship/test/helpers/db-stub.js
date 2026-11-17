// Stand-in for app/db.server.js in tests. The real Prisma client is never created.
export default new Proxy({}, {
  get(_target, prop) {
    const db = globalThis.__multishipTestDb;
    if (!db) throw new Error('No test database: call useTestDb() first');
    return db[prop];
  },
});
