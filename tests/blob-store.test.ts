import { expect, test } from 'bun:test';
import { BlobStore } from '../src/blob-store.ts';
import type { BlobDocument } from '../src/blob-store.ts';
import { createIncident } from '../src/domain.ts';

test('concurrent Blob writes preserve incident receipt uniqueness and settings', async () => {
  let stored: { content: string; etag: string } | null = null;
  let version = 0;
  const document: BlobDocument = {
    async read() { return stored; },
    async write(content, etag) {
      if (etag !== stored?.etag) return false;
      stored = { content, etag: String(++version) };
      return true;
    },
  };
  const store = new BlobStore(document);
  const report = { category: 'fire-alarm', location: 'Block B lobby', description: 'Fault shown on panel', source: 'email', danger: false } as const;
  const [first, second] = await Promise.all([
    store.create(createIncident(report, 'first', 'token-1'), 'email-1'),
    store.create(createIncident(report, 'second', 'token-2'), 'email-1'),
    store.setSetting('routing', { managerEmail: 'manager@example.test' }),
  ]);
  expect(first.id).toBe(second.id);
  expect(await store.list()).toHaveLength(1);
  expect(await store.getSetting('routing', { managerEmail: '' })).toEqual({ managerEmail: 'manager@example.test' });
  expect(await Promise.all([store.lease(first.id, 100), store.lease(first.id, 100)])).toEqual([true, false]);
  expect(await store.lease(first.id, 60_200)).toBe(true);
  await store.release(first.id, 100);
  expect(await store.lease(first.id, 60_300)).toBe(false);
});
