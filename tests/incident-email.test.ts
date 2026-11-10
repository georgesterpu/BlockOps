import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { api } from '../src/api.ts';
import { createIncident, ACK_WINDOW } from '../src/domain.ts';
import { connectEmail, emailDispatch, emailSigningSecret, interpretEmail } from '../src/email.ts';
import type { EmailConfig } from '../src/email.ts';
import { LocalSql } from '../src/local-sql.ts';
import { Store } from '../src/store.ts';
import { processIncident } from '../src/worker.ts';

const url = 'https://blockops.example.test';
const email: EmailConfig = {
  apiKey: 'test-only',
  webhookSecret: `whsec_${Buffer.from('a test signing secret at least 32 bytes').toString('base64')}`,
  inbox: 'reports@example.test', from: 'reports@example.test', accessCode: 'test-resident-code', publicUrl: url, live: true,
};

test('Resend setup creates the webhook once and persists the signing secret', async () => {
  const db = new LocalSql(':memory:');
  const store = new Store(db);
  await store.init();
  const previousFetch = globalThis.fetch;
  let registrations = 0;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'GET' && new URL(request.url).pathname === '/webhooks') return Response.json({ data: [], has_more: false });
    if (request.method === 'POST' && request.url === 'https://api.resend.com/webhooks') {
      expect(await request.json()).toEqual({ endpoint: `${url}/api/email/resend`, events: ['email.received'] });
      registrations++;
      return Response.json({ id: 'test-hook', signing_secret: email.webhookSecret });
    }
    throw new Error('Unexpected network request');
  }) as typeof fetch;
  const config = { ...email, webhookSecret: '' };
  try {
    await connectEmail(store, config);
    await connectEmail(store, config);
    expect(registrations).toBe(1);
    expect(await emailSigningSecret(store, config)).toBe(email.webhookSecret);
  } finally {
    globalThis.fetch = previousFetch;
    db.db.close();
  }
});

function event(id: string, valid = true) {
  const body = JSON.stringify({ type: 'email.received', data: { email_id: id } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', Buffer.from(email.webhookSecret.slice(6), 'base64'))
    .update(`msg_test.${timestamp}.${body}`).digest('base64');
  return new Request(`${url}/api/email/resend`, {
    method: 'POST', body, headers: {
      'svix-id': 'msg_test', 'svix-timestamp': timestamp,
      'svix-signature': `v1,${valid ? signature : 'invalid'}`,
    },
  });
}

test('signed inbound email records one incident, acknowledges it and offers the configured trade', async () => {
  const db = new LocalSql(':memory:');
  const store = new Store(db);
  await store.init();
  const previousFetch = globalThis.fetch;
  const mail: Array<{ to: string[]; text: string; key: string }> = [];
  let fetched = 0;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    if (request.url === 'https://api.resend.com/emails/receiving/email_test_123') {
      fetched++;
      return Response.json({ from: 'Resident <resident@example.test>', to: [email.inbox], subject: 'Fire panel fault', text: 'Location: Block B lobby\nThe panel is beeping.\nCode: test-resident-code', message_id: '<report@example.test>' });
    }
    if (request.url === 'https://api.resend.com/emails' && request.method === 'POST') {
      const body = await request.json() as { to: string[]; text: string };
      mail.push({ ...body, key: request.headers.get('idempotency-key')! });
      return Response.json({ id: `test-${mail.length}` });
    }
    throw new Error('Unexpected network request');
  }) as typeof fetch;
  try {
    const dispatch = emailDispatch(store, email, async () => { throw new Error('No approved email recipient'); });
    const handle = api({ store, email, dispatch, publicUrl: url, live: true, demo: false, password: 'operator-test-password', sessionSecret: 'unit-test-session-secret-long-enough', residentCode: email.accessCode });
    const post = (path: string, body: unknown, cookie?: string) => handle(new Request(`${url}${path}`, {
      method: 'POST', body: JSON.stringify(body), headers: cookie ? { cookie } : undefined,
    }));
    const settings = { managerEmail: 'manager@example.test', residentEmails: ['resident@example.test'], contractorEmails: { 'fire-primary': 'fire@example.test' }, automaticOffers: true };
    expect((await post('/api/settings', settings)).status).toBe(401);
    const login = await post('/api/login', { password: 'operator-test-password' });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    expect((await post('/api/settings', settings, cookie)).status).toBe(200);
    expect((await handle(event('email_test_123', false))).status).toBe(401);
    expect((await handle(event('email_test_123'))).status).toBe(202);
    expect((await handle(event('email_test_123'))).status).toBe(202);
    expect(fetched).toBe(1);
    expect(mail.map(message => message.to[0])).toEqual(['resident@example.test', 'fire@example.test']);
    expect(mail.every(message => !message.text.includes(email.accessCode))).toBe(true);
    expect(mail[0].text).toContain('112 or 999');
    const [incident] = await store.list();
    expect(incident.source).toBe('email');
    expect(incident.status).toBe('offered');
    const acceptance = { id: incident.id, contractorId: incident.contractorId, token: incident.acknowledgementToken };
    expect((await post('/api/accept', acceptance)).status).toBe(200);
    expect((await post('/api/accept', acceptance)).status).toBe(200);
    expect(mail).toHaveLength(3);
    expect((await store.get(incident.id))?.status).toBe('accepted');
  } finally {
    globalThis.fetch = previousFetch;
    db.db.close();
  }
});

test('unclear or hazardous emails are routed for human review even with an access code', () => {
  const sender = { from: 'resident@example.test', to: [email.inbox] };
  expect(interpretEmail({ ...sender, text: 'Smoke in Block B lobby.\nCode: test-resident-code' }, email, true).reviewRequired).toBe(true);
  expect(interpretEmail({ ...sender, text: 'Fire panel keeps beeping.\nCode: test-resident-code' }, email, true).reviewRequired).toBe(true);
});

test('expiry rotates the acceptance token, offers the backup and escalates without a response', async () => {
  const db = new LocalSql(':memory:');
  const store = new Store(db);
  try {
    await store.init();
    const i = await store.create(createIncident({ category: 'fire-alarm', location: 'Block B lobby', description: 'The fire panel is showing a fault.', danger: false, source: 'web' }, 'test-incident', 'initial', 1000), 'test-receipt');
    const deliveries: string[] = [];
    const dispatch = async (_incident: typeof i, delivery: typeof i.outbox[number]) => { deliveries.push(delivery.contractorId ?? delivery.kind); };
    await processIncident(store, i.id, dispatch, false, 1000);
    const primary = await store.get(i.id);
    await processIncident(store, i.id, dispatch, false, 1000 + ACK_WINDOW);
    expect((await store.get(i.id))?.acknowledgementToken).not.toBe(primary?.acknowledgementToken);
    await processIncident(store, i.id, dispatch, false, 1000 + 2 * ACK_WINDOW);
    expect((await store.get(i.id))?.status).toBe('escalated');
    expect(deliveries).toEqual(['fire-primary', 'fire-backup', 'manager']);
  } finally { db.db.close(); }
});
