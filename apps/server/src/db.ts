import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ItemData } from '@horda/shared';

// SQLite integrado en Node (sin dependencias nativas). Un solo archivo junto al servidor.
// Para escalar se puede cambiar esta capa por Postgres sin tocar el resto.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  xp      INTEGER NOT NULL DEFAULT 0,
  cash    INTEGER NOT NULL DEFAULT 0,
  loadout TEXT    NOT NULL DEFAULT '[]',
  games   INTEGER NOT NULL DEFAULT 0,
  wins    INTEGER NOT NULL DEFAULT 0,
  kills   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS items (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weapon     TEXT    NOT NULL,
  rarity     TEXT    NOT NULL,
  level      INTEGER NOT NULL DEFAULT 0,
  roll       REAL    NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS items_user ON items(user_id);
CREATE TABLE IF NOT EXISTS skills (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id TEXT    NOT NULL,
  skill_id TEXT    NOT NULL,
  rank     INTEGER NOT NULL,
  PRIMARY KEY (user_id, class_id, skill_id)
);
`;

export interface UserRow {
  id: number;
  username: string;
  pass_hash: string;
}

export interface ProfileRow {
  user_id: number;
  xp: number;
  cash: number;
  loadout: string;
  games: number;
  wins: number;
  kills: number;
  class: string;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Migraciones sencillas para bases de datos creadas por versiones anteriores. */
  private migrate(): void {
    const cols = this.db.prepare('PRAGMA table_info(profiles)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'class')) {
      this.db.exec("ALTER TABLE profiles ADD COLUMN class TEXT NOT NULL DEFAULT 'assault'");
    }
  }

  /** Ejecuta varias escrituras de forma atómica. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ───────────── Usuarios y sesiones ─────────────

  createUser(username: string, passHash: string): number {
    const r = this.db.prepare('INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)').run(username, passHash, Date.now());
    const id = Number(r.lastInsertRowid);
    this.db.prepare('INSERT INTO profiles (user_id) VALUES (?)').run(id);
    return id;
  }

  userByName(username: string): UserRow | undefined {
    return this.db.prepare('SELECT id, username, pass_hash FROM users WHERE username = ?').get(username) as UserRow | undefined;
  }

  userById(id: number): UserRow | undefined {
    return this.db.prepare('SELECT id, username, pass_hash FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  createSession(token: string, userId: number): void {
    const now = Date.now();
    this.db.prepare('INSERT INTO sessions (token, user_id, created_at, last_used) VALUES (?, ?, ?, ?)').run(token, userId, now, now);
  }

  sessionUser(token: string): number | undefined {
    const row = this.db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token) as { user_id: number } | undefined;
    if (row) this.db.prepare('UPDATE sessions SET last_used = ? WHERE token = ?').run(Date.now(), token);
    return row?.user_id;
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  // ───────────── Perfil e inventario ─────────────

  profile(userId: number): ProfileRow {
    return this.db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId) as unknown as ProfileRow;
  }

  setLoadout(userId: number, loadout: number[]): void {
    this.db.prepare('UPDATE profiles SET loadout = ? WHERE user_id = ?').run(JSON.stringify(loadout), userId);
  }

  addCash(userId: number, delta: number): void {
    this.db.prepare('UPDATE profiles SET cash = cash + ? WHERE user_id = ?').run(delta, userId);
  }

  addMatch(userId: number, xp: number, cash: number, won: boolean, kills: number): void {
    this.db
      .prepare('UPDATE profiles SET xp = xp + ?, cash = cash + ?, games = games + 1, wins = wins + ?, kills = kills + ? WHERE user_id = ?')
      .run(xp, cash, won ? 1 : 0, kills, userId);
  }

  items(userId: number): ItemData[] {
    return this.db
      .prepare('SELECT id, weapon AS base, rarity, level, roll FROM items WHERE user_id = ? ORDER BY id')
      .all(userId)
      .map((r) => ({ ...(r as unknown as ItemData) }));
  }

  item(userId: number, itemId: number): ItemData | undefined {
    const r = this.db.prepare('SELECT id, weapon AS base, rarity, level, roll FROM items WHERE user_id = ? AND id = ?').get(userId, itemId);
    return r ? { ...(r as unknown as ItemData) } : undefined;
  }

  addItem(userId: number, item: Omit<ItemData, 'id'>): ItemData {
    const r = this.db
      .prepare('INSERT INTO items (user_id, weapon, rarity, level, roll, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, item.base, item.rarity, item.level, item.roll, Date.now());
    return { ...item, id: Number(r.lastInsertRowid) };
  }

  setItemLevel(userId: number, itemId: number, level: number): void {
    this.db.prepare('UPDATE items SET level = ? WHERE user_id = ? AND id = ?').run(level, userId, itemId);
  }

  deleteItem(userId: number, itemId: number): void {
    this.db.prepare('DELETE FROM items WHERE user_id = ? AND id = ?').run(userId, itemId);
  }

  setClass(userId: number, classId: string): void {
    this.db.prepare('UPDATE profiles SET class = ? WHERE user_id = ?').run(classId, userId);
  }

  // ───────────── Habilidades ─────────────

  skills(userId: number): Record<string, Record<string, number>> {
    const rows = this.db.prepare('SELECT class_id, skill_id, rank FROM skills WHERE user_id = ?').all(userId) as {
      class_id: string;
      skill_id: string;
      rank: number;
    }[];
    const out: Record<string, Record<string, number>> = {};
    for (const r of rows) (out[r.class_id] ??= {})[r.skill_id] = r.rank;
    return out;
  }

  setSkillRank(userId: number, classId: string, skillId: string, rank: number): void {
    this.db
      .prepare('INSERT INTO skills (user_id, class_id, skill_id, rank) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, class_id, skill_id) DO UPDATE SET rank = excluded.rank')
      .run(userId, classId, skillId, rank);
  }

  resetSkills(userId: number, classId: string): void {
    this.db.prepare('DELETE FROM skills WHERE user_id = ? AND class_id = ?').run(userId, classId);
  }
}
