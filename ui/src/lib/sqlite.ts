import Database from "better-sqlite3";
import path from "path";
import { ResourceType } from "@/models/integrate";

// Use environment variable if provided, otherwise default to parent directory
// This ensures UI and backend share the same database in local mode
// Backend runs from project root, UI runs from ui/ subdirectory
const DB_PATH = process.env.SQLITE_DB_PATH ||
  path.join(process.cwd(), "..", "traceroot-local.db");

/**
 * SQLite database helper for local mode token storage
 * Provides the same interface as MongoDB for consistent UX
 */
export class LocalTokenStorage {
  private db: Database.Database;

  constructor(dbPath: string = DB_PATH) {
    this.db = new Database(dbPath);
    this.initDB();
  }

  /**
   * Initialize database tables (same schema as backend SQLite)
   */
  private initDB() {
    // Connection tokens table (GitHub, Slack, Notion, OpenAI, Anthropic)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connection_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        token_type TEXT NOT NULL,
        token TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_email, token_type)
      )
    `);

    // TraceRoot tokens table (includes AWS credentials)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS traceroot_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL,
        user_email TEXT NOT NULL UNIQUE,
        user_sub TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  /**
   * Store a connection token (upsert)
   */
  storeConnectionToken(
    userEmail: string,
    tokenType: ResourceType,
    token: string,
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO connection_tokens (user_email, token_type, token)
      VALUES (?, ?, ?)
      ON CONFLICT(user_email, token_type)
      DO UPDATE SET token = excluded.token, created_at = CURRENT_TIMESTAMP
    `);
    stmt.run(userEmail, tokenType, token);
  }

  /**
   * Get a connection token
   */
  getConnectionToken(
    userEmail: string,
    tokenType: ResourceType,
  ): string | null {
    const stmt = this.db.prepare(`
      SELECT token FROM connection_tokens
      WHERE user_email = ? AND token_type = ?
    `);
    const row = stmt.get(userEmail, tokenType) as { token: string } | undefined;
    return row?.token || null;
  }

  /**
   * Store a TraceRoot token
   */
  storeTracerootToken(
    userEmail: string,
    userSub: string,
    token: string,
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO traceroot_tokens (user_email, user_sub, token)
      VALUES (?, ?, ?)
      ON CONFLICT(user_email)
      DO UPDATE SET token = excluded.token, user_sub = excluded.user_sub, created_at = CURRENT_TIMESTAMP
    `);
    stmt.run(userEmail, userSub, token);
  }

  /**
   * Get a TraceRoot token
   */
  getTracerootToken(userEmail: string): string | null {
    const stmt = this.db.prepare(`
      SELECT token FROM traceroot_tokens
      WHERE user_email = ?
    `);
    const row = stmt.get(userEmail) as { token: string } | undefined;
    return row?.token || null;
  }

  /**
   * Delete a connection token
   */
  deleteConnectionToken(userEmail: string, tokenType: ResourceType): void {
    const stmt = this.db.prepare(`
      DELETE FROM connection_tokens
      WHERE user_email = ? AND token_type = ?
    `);
    stmt.run(userEmail, tokenType);
  }

  /**
   * Delete a TraceRoot token
   */
  deleteTracerootToken(userEmail: string): void {
    const stmt = this.db.prepare(`
      DELETE FROM traceroot_tokens
      WHERE user_email = ?
    `);
    stmt.run(userEmail);
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}

// Singleton instance
let storage: LocalTokenStorage | null = null;

export function getLocalTokenStorage(): LocalTokenStorage {
  if (!storage) {
    storage = new LocalTokenStorage();
  }
  return storage;
}
