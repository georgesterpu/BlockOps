import { contractors } from './domain.ts';
import type { IncidentStore } from './store.ts';

export interface RoutingSettings {
  managerEmail: string;
  residentEmails: string[];
  contractorEmails: Record<string, string>;
  automaticOffers: boolean;
}

const defaults: RoutingSettings = { managerEmail: '', residentEmails: [], contractorEmails: {}, automaticOffers: false };

export function emailAddress(input: string): string {
  const candidate = (input.match(/<([^<>]+)>\s*$/)?.[1] ?? input).trim().toLowerCase();
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(candidate) && candidate.length <= 254 ? candidate : '';
}

export function getRouting(store: IncidentStore) {
  return store.getSetting('routing', defaults);
}

export function parseRouting(input: unknown): RoutingSettings {
  if (!input || typeof input !== 'object') throw new Error('Enter routing settings.');
  const value = input as Partial<RoutingSettings>;
  if (typeof value.managerEmail !== 'string' || !Array.isArray(value.residentEmails) || value.residentEmails.length > 100 || !value.contractorEmails || typeof value.contractorEmails !== 'object' || typeof value.automaticOffers !== 'boolean') {
    throw new Error('Invalid routing settings.');
  }
  const address = (raw: unknown) => {
    if (typeof raw !== 'string' || (raw.trim() && !emailAddress(raw))) throw new Error('Enter valid email addresses.');
    return emailAddress(raw);
  };
  const managerEmail = address(value.managerEmail);
  const residentEmails = [...new Set(value.residentEmails.map(address).filter(Boolean))];
  const contractorEmails: Record<string, string> = {};
  for (const contractor of contractors) {
    const email = address(value.contractorEmails[contractor.id] ?? '');
    if (email) contractorEmails[contractor.id] = email;
  }
  if (value.automaticOffers && (!managerEmail || !Object.keys(contractorEmails).length)) {
    throw new Error('Set a duty manager and an approved contractor before enabling automatic offers.');
  }
  return { managerEmail, residentEmails, contractorEmails, automaticOffers: value.automaticOffers };
}
