import { createIncident, advanceIncident, acceptIncident, resolveIncident, audit } from './domain.ts';
import type { Incident } from './domain.ts';
export function sampleIncidents(now = Date.now()): Incident[] {
  const report = (category: Incident['category'], location: string, description: string, minutes: number, id: string) => createIncident({category, location, description, danger: false, source: 'email'}, id, 'demo-only', now - minutes * 60_000);
  const fire = advanceIncident(report('fire-alarm', 'Block B · Ground floor lobby', 'Fire panel beeping again. Fault indicator showing in the lobby.', 3, 'sc-1042'), now - 2 * 60_000);
  audit(fire, 'Demo offer simulated', 'Sample contractor only. No message or call-out has been sent.', now - 2 * 60_000);
  const water = advanceIncident(report('water', 'Block A · Basement car park', 'Water leaking from the pipe near parking bay 12.', 26, 'sc-1041'), now - 25 * 60_000);
  const accepted = acceptIncident(water, 'water-primary', now - 24 * 60_000);
  const door = advanceIncident(advanceIncident(advanceIncident(report('access', 'Block C · Main entrance', 'Communal entrance door will not latch securely.', 49, 'sc-1040'), now - 48 * 60_000), now - 42 * 60_000), now - 36 * 60_000);
  const light = resolveIncident(report('electrical', 'Block A · Second floor landing', 'The communal landing light is flickering.', 180, 'sc-1039'), 'Sample resolution: electrician replaced the faulty light fitting and checked operation.', now - 80 * 60_000);
  return [fire, accepted, door, light];
}
