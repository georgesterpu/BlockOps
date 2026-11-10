import type { Incident } from "./domain.ts";
export type Value = string | number | null;
export type Row = Record<string, string | number | null>;
export interface Sql {
  query(sql: string, args?: Value[]): Promise<Row[]>;
}
export interface IncidentStore {
  init(): Promise<void>;
  check(): Promise<void>;
  getSetting<T>(key: string, fallback: T): Promise<T>;
  setSetting(key: string, value: unknown): Promise<void>;
  byReceipt(receipt: string): Promise<Incident | null>;
  create(incident: Incident, receipt: string): Promise<Incident>;
  get(id: string): Promise<Incident | null>;
  list(): Promise<Incident[]>;
  update(
    id: string,
    transform: (incident: Incident) => Incident,
  ): Promise<Incident>;
  lease(id: string, now: number): Promise<boolean>;
  release(id: string, now: number): Promise<void>;
  limited(key: string, max: number, now?: number): Promise<boolean>;
}
export class Store implements IncidentStore {
  constructor(readonly sql: Sql) {}
  async check() {
    await this.sql.query("SELECT 1");
  }
  async init() {
    await this.sql.query(
      "CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, receipt TEXT UNIQUE NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
    );
    await this.sql.query(
      "CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
    );
    await this.sql.query(
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }
  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const [row] = await this.sql.query(
      "SELECT value FROM settings WHERE key=?",
      [key],
    );
    return row ? (JSON.parse(String(row.value)) as T) : fallback;
  }
  async setSetting(key: string, value: unknown): Promise<void> {
    await this.sql.query(
      "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [key, JSON.stringify(value)],
    );
  }
  async byReceipt(receipt: string): Promise<Incident | null> {
    const [row] = await this.sql.query(
      "SELECT body FROM incidents WHERE receipt=?",
      [receipt],
    );
    return row ? (JSON.parse(String(row.body)) as Incident) : null;
  }
  async create(i: Incident, receipt: string): Promise<Incident> {
    await this.sql.query(
      "INSERT INTO incidents(id,receipt,body,created_at) VALUES (?,?,?,?) ON CONFLICT(receipt) DO NOTHING",
      [i.id, receipt, JSON.stringify(i), i.createdAt],
    );
    const rows = await this.sql.query(
      "SELECT body FROM incidents WHERE receipt=?",
      [receipt],
    );
    return JSON.parse(rows[0].body as string);
  }
  async get(id: string): Promise<Incident | null> {
    const rows = await this.sql.query("SELECT body FROM incidents WHERE id=?", [
      id,
    ]);
    return rows[0] ? JSON.parse(rows[0].body as string) : null;
  }
  async list(): Promise<Incident[]> {
    return (
      await this.sql.query(
        "SELECT body FROM incidents ORDER BY created_at DESC LIMIT 500",
      )
    ).map((r) => JSON.parse(r.body as string));
  }
  async update(
    id: string,
    transform: (incident: Incident) => Incident,
  ): Promise<Incident> {
    for (let retry = 0; retry < 5; retry++) {
      const rows = await this.sql.query(
        "SELECT body,version FROM incidents WHERE id=?",
        [id],
      );
      if (!rows[0]) throw new Error("Incident not found.");
      const next = transform(JSON.parse(rows[0].body as string));
      const updated = await this.sql.query(
        "UPDATE incidents SET body=?,version=version+1 WHERE id=? AND version=? RETURNING id",
        [JSON.stringify(next), id, rows[0].version],
      );
      if (updated.length) return next;
    }
    throw new Error("Incident changed concurrently. Please retry.");
  }
  async lease(id: string, now: number): Promise<boolean> {
    return (
      (
        await this.sql.query(
          "UPDATE incidents SET lease_until=? WHERE id=? AND lease_until<=? RETURNING id",
          [now + 60_000, id, now],
        )
      ).length > 0
    );
  }
  async release(id: string, now: number) {
    await this.sql.query(
      "UPDATE incidents SET lease_until=0 WHERE id=? AND lease_until=?",
      [id, now + 60_000],
    );
  }
  async limited(key: string, max: number, now = Date.now()): Promise<boolean> {
    const rows = await this.sql.query(
      "INSERT INTO limits(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END, expires_at=CASE WHEN expires_at<=? THEN ? ELSE expires_at END RETURNING count",
      [key, now + 15 * 60_000, now, now, now + 15 * 60_000],
    );
    return Number(rows[0].count) > max;
  }
}
