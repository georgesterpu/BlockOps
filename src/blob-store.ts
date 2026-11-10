import type { Incident } from "./domain.ts";
import type { IncidentStore } from "./store.ts";

interface Entry {
  incident: Incident;
  receipt: string;
  leaseUntil: number;
}

interface DeskData {
  incidents: Entry[];
  settings: Record<string, unknown>;
  limits: Record<string, { count: number; expiresAt: number }>;
}

export interface BlobDocument {
  read(): Promise<{ content: string; etag: string } | null>;
  write(content: string, etag?: string): Promise<boolean>;
}

const empty = (): DeskData => ({ incidents: [], settings: {}, limits: {} });

// One private document is sufficient for a building pilot. All mutations use its ETag.
export class BlobStore implements IncidentStore {
  constructor(private readonly document: BlobDocument) {}

  async init() {}

  async check() {
    await this.read();
  }

  private async read() {
    const current = await this.document.read();
    return {
      data: current ? (JSON.parse(current.content) as DeskData) : empty(),
      etag: current?.etag,
    };
  }

  private async mutate<T>(
    change: (data: DeskData) => { result: T; changed: boolean },
  ): Promise<T> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { data, etag } = await this.read();
      const { result, changed } = change(data);
      if (!changed) return result;
      const content = JSON.stringify(data);
      if (Buffer.byteLength(content) > 2_000_000)
        throw new Error(
          "Database pilot capacity reached. Export incidents and contact the operator.",
        );
      if (await this.document.write(content, etag)) return result;
    }
    throw new Error("Database changed concurrently. Please retry.");
  }

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const { data } = await this.read();
    return Object.hasOwn(data.settings, key)
      ? (data.settings[key] as T)
      : fallback;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.mutate((data) => {
      data.settings[key] = value;
      return { result: undefined, changed: true };
    });
  }

  async byReceipt(receipt: string): Promise<Incident | null> {
    const { data } = await this.read();
    return (
      data.incidents.find((entry) => entry.receipt === receipt)?.incident ??
      null
    );
  }

  async create(incident: Incident, receipt: string): Promise<Incident> {
    return this.mutate((data) => {
      const existing = data.incidents.find(
        (entry) => entry.receipt === receipt,
      );
      if (existing) return { result: existing.incident, changed: false };
      data.incidents.push({ incident, receipt, leaseUntil: 0 });
      return { result: incident, changed: true };
    });
  }

  async get(id: string): Promise<Incident | null> {
    const { data } = await this.read();
    return (
      data.incidents.find((entry) => entry.incident.id === id)?.incident ?? null
    );
  }

  async list(): Promise<Incident[]> {
    const { data } = await this.read();
    return data.incidents
      .map((entry) => entry.incident)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 500);
  }

  async update(
    id: string,
    transform: (incident: Incident) => Incident,
  ): Promise<Incident> {
    return this.mutate((data) => {
      const entry = data.incidents.find((item) => item.incident.id === id);
      if (!entry) throw new Error("Incident not found.");
      entry.incident = transform(entry.incident);
      return { result: entry.incident, changed: true };
    });
  }

  async lease(id: string, now: number): Promise<boolean> {
    return this.mutate((data) => {
      const entry = data.incidents.find((item) => item.incident.id === id);
      if (!entry || entry.leaseUntil > now)
        return { result: false, changed: false };
      entry.leaseUntil = now + 60_000;
      return { result: true, changed: true };
    });
  }

  async release(id: string, now: number): Promise<void> {
    await this.mutate((data) => {
      const entry = data.incidents.find((item) => item.incident.id === id);
      const changed = entry?.leaseUntil === now + 60_000;
      if (changed) entry.leaseUntil = 0;
      return { result: undefined, changed };
    });
  }

  async limited(key: string, max: number, now = Date.now()): Promise<boolean> {
    return this.mutate((data) => {
      for (const [key, limit] of Object.entries(data.limits)) {
        if (limit.expiresAt <= now) delete data.limits[key];
      }
      const limit = data.limits[key] ?? {
        count: 0,
        expiresAt: now + 15 * 60_000,
      };
      limit.count++;
      data.limits[key] = limit;
      return { result: limit.count > max, changed: true };
    });
  }
}
