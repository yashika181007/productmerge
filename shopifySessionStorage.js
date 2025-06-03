const mysql = require('mysql2/promise');
const { Session } = require('@shopify/shopify-api');

class MySQLSessionStorage {
  constructor(db) {
    this.db = db;
  }

  async storeSession(session) {
    const sessionId = session.id;
    const sessionString = JSON.stringify(session);
    await this.db.execute(
      `INSERT INTO shopify_sessions (id, session) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE session = ?, updated_at = CURRENT_TIMESTAMP`,
      [sessionId, sessionString, sessionString]
    );
  }

  async loadSession(id) {
    const [rows] = await this.db.execute(
      `SELECT session FROM shopify_sessions WHERE id = ? LIMIT 1`,
      [id]
    );
    if (rows.length === 0) return undefined;
    const sessionData = JSON.parse(rows[0].session);
    return Session.validateSession(sessionData);
  }

  async deleteSession(id) {
    await this.db.execute(`DELETE FROM shopify_sessions WHERE id = ?`, [id]);
  }

  async deleteSessions(ids) {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    await this.db.execute(
      `DELETE FROM shopify_sessions WHERE id IN (${placeholders})`,
      ids
    );
  }
}

async function createSessionsTable(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS shopify_sessions (
      id VARCHAR(255) PRIMARY KEY,
      session TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
}

module.exports = { MySQLSessionStorage, createSessionsTable };
