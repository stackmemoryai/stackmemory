import BetterSqlite3 from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcryptjs';
import { logger } from '../core/monitoring/logger.js';

type Database = BetterSqlite3.Database;

export interface User {
  id: string;
  sub: string; // Subject identifier from auth provider
  email: string;
  name?: string;
  avatar?: string;
  tier: 'free' | 'pro' | 'enterprise';
  permissions: string[];
  organizations: Array<{
    id: string;
    name: string;
    role: string;
  }>;
  apiKeys?: string[];
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date;
  metadata?: Record<string, any>;
}

export interface UserSession {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
  metadata?: Record<string, any>;
}

export class UserModel {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.initialize();
  }

  private initialize(): void {
    // Create users table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        sub TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        avatar TEXT,
        tier TEXT DEFAULT 'free',
        permissions TEXT DEFAULT '["read", "write"]',
        organizations TEXT DEFAULT '[]',
        api_keys TEXT DEFAULT '[]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login_at DATETIME,
        metadata TEXT DEFAULT '{}'
      )
    `);

    // Create sessions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        metadata TEXT DEFAULT '{}',
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Create api_keys table for efficient lookup
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        key_hash TEXT UNIQUE NOT NULL,
        name TEXT,
        last_used_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        metadata TEXT DEFAULT '{}',
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_users_sub ON users(sub);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON user_sessions(token);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON user_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
      CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
    `);

    logger.info('User database schema initialized');
  }

  async createUser(userData: Partial<User>): Promise<User> {
    const user: User = {
      id: userData.id || uuidv4(),
      sub: userData.sub!,
      email: userData.email!,
      name: userData.name,
      avatar: userData.avatar,
      tier: userData.tier || 'free',
      permissions: userData.permissions || ['read', 'write'],
      organizations: userData.organizations || [],
      apiKeys: userData.apiKeys || [],
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: userData.metadata || {},
    };

    const stmt = this.db.prepare(`
      INSERT INTO users (
        id, sub, email, name, avatar, tier, permissions, 
        organizations, api_keys, created_at, updated_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      user.id,
      user.sub,
      user.email,
      user.name,
      user.avatar,
      user.tier,
      JSON.stringify(user.permissions),
      JSON.stringify(user.organizations),
      JSON.stringify(user.apiKeys),
      user.createdAt.toISOString(),
      user.updatedAt.toISOString(),
      JSON.stringify(user.metadata)
    );

    logger.info('User created', { userId: user.id, email: user.email });
    return user;
  }

  async findUserBySub(sub: string): Promise<User | null> {
    const stmt = this.db.prepare('SELECT * FROM users WHERE sub = ?');
    const row = stmt.get(sub) as any;

    if (!row) {
      return null;
    }

    return this.rowToUser(row);
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const stmt = this.db.prepare('SELECT * FROM users WHERE email = ?');
    const row = stmt.get(email) as any;

    if (!row) {
      return null;
    }

    return this.rowToUser(row);
  }

  async findUserById(id: string): Promise<User | null> {
    const stmt = this.db.prepare('SELECT * FROM users WHERE id = ?');
    const row = stmt.get(id) as any;

    if (!row) {
      return null;
    }

    return this.rowToUser(row);
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User | null> {
    const user = await this.findUserById(id);
    if (!user) {
      return null;
    }

    const updatedUser = {
      ...user,
      ...updates,
      updatedAt: new Date(),
    };

    const stmt = this.db.prepare(`
      UPDATE users SET
        email = ?, name = ?, avatar = ?, tier = ?, 
        permissions = ?, organizations = ?, api_keys = ?,
        updated_at = ?, last_login_at = ?, metadata = ?
      WHERE id = ?
    `);

    stmt.run(
      updatedUser.email,
      updatedUser.name,
      updatedUser.avatar,
      updatedUser.tier,
      JSON.stringify(updatedUser.permissions),
      JSON.stringify(updatedUser.organizations),
      JSON.stringify(updatedUser.apiKeys),
      updatedUser.updatedAt.toISOString(),
      updatedUser.lastLoginAt?.toISOString(),
      JSON.stringify(updatedUser.metadata),
      id
    );

    logger.info('User updated', { userId: id });
    return updatedUser;
  }

  async deleteUser(id: string): Promise<boolean> {
    const stmt = this.db.prepare('DELETE FROM users WHERE id = ?');
    const result = stmt.run(id);

    if (result.changes > 0) {
      logger.info('User deleted', { userId: id });
      return true;
    }

    return false;
  }

  async updateLastLogin(id: string): Promise<void> {
    const stmt = this.db.prepare(
      'UPDATE users SET last_login_at = ? WHERE id = ?'
    );
    stmt.run(new Date().toISOString(), id);
  }

  // Session management
  async createSession(userId: string, expiresIn = 86400): Promise<UserSession> {
    const session: UserSession = {
      id: uuidv4(),
      userId,
      token: this.generateSessionToken(),
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      createdAt: new Date(),
      metadata: {},
    };

    const stmt = this.db.prepare(`
      INSERT INTO user_sessions (id, user_id, token, expires_at, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      session.id,
      session.userId,
      session.token,
      session.expiresAt.toISOString(),
      session.createdAt.toISOString(),
      JSON.stringify(session.metadata)
    );

    logger.info('Session created', { sessionId: session.id, userId });
    return session;
  }

  async findSessionByToken(token: string): Promise<UserSession | null> {
    const stmt = this.db.prepare('SELECT * FROM user_sessions WHERE token = ?');
    const row = stmt.get(token) as any;

    if (!row) {
      return null;
    }

    return this.rowToSession(row);
  }

  async validateSession(token: string): Promise<User | null> {
    const session = await this.findSessionByToken(token);

    if (!session) {
      return null;
    }

    // Check if session is expired
    if (new Date(session.expiresAt) < new Date()) {
      await this.deleteSession(session.id);
      return null;
    }

    // Get the user
    return await this.findUserById(session.userId);
  }

  async deleteSession(id: string): Promise<boolean> {
    const stmt = this.db.prepare('DELETE FROM user_sessions WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  async deleteExpiredSessions(): Promise<number> {
    const stmt = this.db.prepare(
      'DELETE FROM user_sessions WHERE expires_at < ?'
    );
    const result = stmt.run(new Date().toISOString());

    if (result.changes > 0) {
      logger.info('Expired sessions deleted', { count: result.changes });
    }

    return result.changes;
  }

  // API Key management
  async generateApiKey(userId: string, name?: string): Promise<string> {
    const user = await this.findUserById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    const apiKey = `sk-${this.generateToken(32)}`;
    const hashedKey = await bcrypt.hash(apiKey, 10);

    // Store in dedicated api_keys table
    const stmt = this.db.prepare(`
      INSERT INTO api_keys (id, user_id, key_hash, name, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const apiKeyId = uuidv4();
    stmt.run(
      apiKeyId,
      userId,
      hashedKey,
      name || 'API Key',
      new Date().toISOString()
    );

    logger.info('API key generated', { userId, apiKeyId });
    return apiKey;
  }

  async validateApiKey(apiKey: string): Promise<User | null> {
    // Efficient lookup using indexed api_keys table
    const stmt = this.db.prepare(`
      SELECT u.*, ak.id as api_key_id, ak.key_hash
      FROM api_keys ak
      JOIN users u ON ak.user_id = u.id
      WHERE (ak.expires_at IS NULL OR ak.expires_at > datetime('now'))
    `);

    const rows = stmt.all() as any[];

    for (const row of rows) {
      if (await bcrypt.compare(apiKey, row.key_hash)) {
        // Update last used timestamp
        const updateStmt = this.db.prepare(
          'UPDATE api_keys SET last_used_at = ? WHERE id = ?'
        );
        updateStmt.run(new Date().toISOString(), row.api_key_id);

        return this.rowToUser(row);
      }
    }

    return null;
  }

  async revokeApiKey(userId: string, apiKeyId: string): Promise<boolean> {
    const stmt = this.db.prepare(
      'DELETE FROM api_keys WHERE id = ? AND user_id = ?'
    );
    const result = stmt.run(apiKeyId, userId);

    if (result.changes > 0) {
      logger.info('API key revoked', { userId, apiKeyId });
      return true;
    }

    return false;
  }

  async listApiKeys(
    userId: string
  ): Promise<
    Array<{ id: string; name: string; lastUsed?: Date; createdAt: Date }>
  > {
    const stmt = this.db.prepare(`
      SELECT id, name, last_used_at, created_at
      FROM api_keys
      WHERE user_id = ?
      ORDER BY created_at DESC
    `);

    const rows = stmt.all(userId) as any[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      lastUsed: row.last_used_at ? new Date(row.last_used_at) : undefined,
      createdAt: new Date(row.created_at),
    }));
  }

  // Helper methods
  private rowToUser(row: any): User {
    return {
      id: row.id,
      sub: row.sub,
      email: row.email,
      name: row.name,
      avatar: row.avatar,
      tier: row.tier,
      permissions: JSON.parse(row.permissions),
      organizations: JSON.parse(row.organizations),
      apiKeys: JSON.parse(row.api_keys || '[]'),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      lastLoginAt: row.last_login_at ? new Date(row.last_login_at) : undefined,
      metadata: JSON.parse(row.metadata || '{}'),
    };
  }

  private rowToSession(row: any): UserSession {
    return {
      id: row.id,
      userId: row.user_id,
      token: row.token,
      expiresAt: new Date(row.expires_at),
      createdAt: new Date(row.created_at),
      metadata: JSON.parse(row.metadata || '{}'),
    };
  }

  private generateSessionToken(): string {
    return this.generateToken(48);
  }

  private generateToken(length: number): string {
    const chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let token = '';
    for (let i = 0; i < length; i++) {
      token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token;
  }
}

// Singleton instance management
let userModelInstance: UserModel | null = null;

export function getUserModel(db: BetterSqlite3.Database): UserModel {
  if (!userModelInstance) {
    userModelInstance = new UserModel(db);
  }
  return userModelInstance;
}
