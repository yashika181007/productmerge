const mysql = require('mysql2/promise');
const { Session } = require('@shopify/shopify-api');

class ShopifyMySQLSessionStorage {
  constructor(pool) {
    this.pool = pool;
  }

  async storeSession(session) {
    const sessionData = JSON.stringify(session);
    const sql = `INSERT INTO shopify_sessions (id, session) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE session = VALUES(session)`;
    await this.pool.execute(sql, [session.id, sessionData]);
    return true;
  }

  async loadSession(id) {
    const [rows] = await this.pool.execute('SELECT session FROM shopify_sessions WHERE id = ?', [id]);
    if (rows.length === 0) return undefined;

    const sessionObj = JSON.parse(rows[0].session);
    return Session.fromPropertyArray(Object.entries(sessionObj));
  }

  async deleteSession(id) {
    await this.pool.execute('DELETE FROM shopify_sessions WHERE id = ?', [id]);
    return true;
  }

  async findSessionsByShop(shop) {
    const [rows] = await this.pool.execute('SELECT session FROM shopify_sessions');
    const sessions = rows.map(row => Session.fromPropertyArray(Object.entries(JSON.parse(row.session))));
    return sessions.filter(session => session.shop === shop);
  }
}

module.exports = ShopifyMySQLSessionStorage;
