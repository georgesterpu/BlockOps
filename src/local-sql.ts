import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Row, Sql, Value } from './store.ts';

export class LocalSql implements Sql {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  }

  async query(sql: string, args: Value[] = []): Promise<Row[]> {
    return this.db.query(sql).all(...args) as Row[];
  }
}
