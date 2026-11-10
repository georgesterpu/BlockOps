import { createHmac } from 'node:crypto';
import { equal } from './auth.ts';
import { createIncident, emergencyGuidance, categoryNames } from './domain.ts';
import type { Category, Report } from './domain.ts';
import { emailAddress, getRouting } from './routing.ts';
import type { IncidentStore } from './store.ts';
import type { Dispatch } from './worker.ts';

export interface EmailConfig {
  apiKey: string;
  webhookSecret: string;
  inbox: string;
  from: string;
  accessCode: string;
  publicUrl: string;
  live: boolean;
}

interface ReceivedEmail {
  from: string;
  to: string[];
  subject?: string;
  text?: string | null;
  message_id?: string;
  headers?: Record<string, string>;
}

interface ResendWebhook {
  id: string;
  endpoint: string;
  status: string;
  events: string[];
  signing_secret?: string;
}

export function emailSigningSecret(store: IncidentStore, config: EmailConfig) {
  return config.webhookSecret ? Promise.resolve(config.webhookSecret) : store.getSetting('resend-signing-secret', '');
}

export async function connectEmail(store: IncidentStore, config: EmailConfig): Promise<void> {
  if (!config.apiKey) throw new Error('Add the Resend API key in the project settings.');
  if (await emailSigningSecret(store, config)) return;
  const endpoint = new URL('/api/email/resend', config.publicUrl);
  if (endpoint.protocol !== 'https:') throw new Error('Email setup requires a deployed HTTPS URL.');

  const call = async <T>(path: string, body?: object): Promise<T> => {
    const response = await fetch(`https://api.resend.com${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) throw new Error('Resend rejected the key. Use a key with Full access.');
    if (!response.ok) throw new Error(`Resend setup failed (${response.status}). Try again.`);
    return response.json() as Promise<T>;
  };
  let existing: ResendWebhook | undefined;
  let after = '';
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (after) query.set('after', after);
    const list = await call<{ data: ResendWebhook[]; has_more: boolean }>(`/webhooks?${query}`);
    existing = list.data.find(hook => hook.endpoint === endpoint.href && hook.events.includes('email.received'));
    after = list.has_more ? list.data.at(-1)?.id ?? '' : '';
  } while (!existing && after);
  if (existing && existing.status !== 'enabled') throw new Error('Enable the existing BlockOps webhook in Resend, then retry.');
  const webhook = existing
    ? await call<ResendWebhook>(`/webhooks/${encodeURIComponent(existing.id)}`)
    : await call<ResendWebhook>('/webhooks', { endpoint: endpoint.href, events: ['email.received'] });
  if (!webhook.signing_secret?.startsWith('whsec_')) throw new Error('Resend did not return a webhook signing secret.');
  await store.setSetting('resend-signing-secret', webhook.signing_secret);
}

export function verifyEmailEvent(request: Request, body: string, secret: string, now = Date.now()): boolean {
  const id = request.headers.get('svix-id');
  const timestamp = request.headers.get('svix-timestamp');
  const signature = request.headers.get('svix-signature');
  if (!secret.startsWith('whsec_') || !id || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.slice(6), 'base64');
  if (key.length < 16) return false;
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return signature.split(' ').some(item => item.startsWith('v1,') && equal(item.slice(3), expected));
}

export function detectCategory(text: string): Category {
  if (/\b(fire|smoke|alarm|panel)\b/i.test(text)) return 'fire-alarm';
  if (/\b(leak\w*|water|flood\w*|plumb\w*)\b/i.test(text)) return 'water';
  if (/\b(door\w*|lock\w*|gate\w*|access)\b/i.test(text)) return 'access';
  if (/\b(power|electric\w*|light\w*|spark\w*)\b/i.test(text)) return 'electrical';
  return 'other';
}

export function interpretEmail(email: ReceivedEmail, config: EmailConfig, automaticOffers: boolean): Report {
  const raw = email.text?.trim() ?? '';
  const code = raw.match(/^\s*Code:\s*([^\r\n]+)$/im)?.[1]?.trim() ?? '';
  const text = raw.replace(/^\s*Code:[^\r\n]*/gim, '').trim();
  const subject = (email.subject || '').replace(/[\r\n]/g, ' ').slice(0, 200);
  const description = [subject, text].filter(Boolean).join('\n\n').slice(0, 3000);
  const category = detectCategory(description);
  const location = (text.match(/^\s*Location:\s*([^\r\n]+)/im)?.[1] ?? description.match(/\bBlock\s+[a-z0-9]+(?:[ ,·-]+(?:ground floor|basement|lobby|entrance|car park|landing|level\s+\d+))*/i)?.[0] ?? '').trim().slice(0, 160);
  const danger = /\b(smoke|flames?|burning|trapped|sparks?|gas|injur\w*)\b/i.test(description);
  const messageId = email.message_id?.trim();
  return {
    category,
    location: location || 'Shoreside Commons · location to confirm',
    description: description || 'The email did not contain a plain-text description.',
    danger,
    source: 'email',
    reviewRequired: !automaticOffers || !location || danger || !config.accessCode || !equal(code, config.accessCode),
    reporter: {
      email: emailAddress(email.from),
      messageId: messageId && /^<?[^<>\s]+@[^<>\s]+>?$/.test(messageId) ? `<${messageId.replace(/^<|>$/g, '')}>` : undefined,
    },
  };
}

export async function receiveEmail(store: IncidentStore, config: EmailConfig, id: string): Promise<string | null> {
  const receipt = `resend:${id}`;
  const existing = await store.byReceipt(receipt);
  if (existing) return existing.id;
  const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Resend inbound retrieval failed (${response.status}).`);
  const email = await response.json() as ReceivedEmail;
  const sender = emailAddress(email.from || '');
  const routing = await getRouting(store);
  if (!sender || sender === config.from || !email.to?.some(address => emailAddress(address) === config.inbox)) return null;
  if (!routing.residentEmails.includes(sender)) {
    console.info('BlockOps ignored a report from an unenrolled sender.');
    return null;
  }
  const autoSubmitted = Object.entries(email.headers || {}).find(([key]) => key.toLowerCase() === 'auto-submitted')?.[1];
  if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') return null;
  const report = interpretEmail(email, config, routing.automaticOffers);
  const incident = await store.create(createIncident(report, crypto.randomUUID(), crypto.randomUUID()), receipt);
  console.info('BlockOps recorded an email report.');
  return incident.id;
}

export function emailDispatch(store: IncidentStore, config: EmailConfig, fallback: Dispatch): Dispatch {
  return async (incident, delivery) => {
    const resident = delivery.kind === 'receipt' || delivery.kind === 'status';
    if (!resident && !config.live) return;
    const routing = await getRouting(store);
    const to = resident ? incident.reporter?.email : delivery.kind === 'manager' ? routing.managerEmail : routing.contractorEmails[delivery.contractorId ?? ''];
    if (resident && (!to || !routing.residentEmails.includes(to))) throw new Error('Resident is not enrolled for email.');
    if (!resident && !to) return fallback(incident, delivery);
    if (!to || !config.apiKey || !config.from) throw new Error('Email delivery is not configured.');

    const subject = resident ? `BlockOps [${incident.reference}]` : `${delivery.kind === 'offer' ? 'Call-out offer' : 'Duty manager review'} [${incident.reference}]`;
    const accept = new URL('/', config.publicUrl);
    accept.hash = new URLSearchParams({ accept: incident.id, contractor: delivery.contractorId || '', token: incident.acknowledgementToken }).toString();
    const text = resident ? delivery.message : [
      `Shoreside Commons, Sea Gardens, Bray`,
      `${categoryNames[incident.category]} · ${incident.location} · ${incident.priority}`,
      incident.description,
      delivery.kind === 'offer' ? `Accept before ${new Date(incident.dueAt!).toISOString()}: ${accept.href}` : 'Human follow-up is required.',
      emergencyGuidance,
    ].join('\n\n');
    const headers: Record<string, string> = { 'Auto-Submitted': 'auto-replied' };
    if (resident && incident.reporter?.messageId) {
      headers['In-Reply-To'] = incident.reporter.messageId;
      headers.References = incident.reporter.messageId;
    }
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json', 'idempotency-key': delivery.id },
      body: JSON.stringify({ from: `BlockOps <${config.from}>`, to: [to], subject, text, reply_to: config.inbox, headers }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.warn('Resend declined a BlockOps notification.', { kind: delivery.kind, status: response.status });
      throw new Error(`Resend delivery failed (${response.status}).`);
    }
    console.info('Resend accepted a BlockOps notification.', { kind: delivery.kind });
  };
}
