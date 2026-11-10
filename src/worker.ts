import {
  advanceIncident,
  audit,
  contractors,
  emergencyGuidance,
} from "./domain.ts";
import type { Contractor, Delivery, Incident } from "./domain.ts";
import { createHmac } from "node:crypto";
import type { IncidentStore } from "./store.ts";
export interface DispatchConfig {
  live: boolean;
  publicUrl: string;
  webhookUrl?: string;
  webhookSecret?: string;
  contacts: Contractor[];
  managerPhone?: string;
}
export type Dispatch = (
  incident: Incident,
  delivery: Delivery,
) => Promise<void>;
export function webhookDispatch(config: DispatchConfig): Dispatch {
  return async (i, d) => {
    if (!config.live) return;
    const contact =
      d.kind === "manager"
        ? config.managerPhone
        : config.contacts.find((c) => c.id === d.contractorId)?.phone;
    if (!contact || !config.webhookUrl || !config.webhookSecret)
      throw new Error(
        "Approved recipient or dispatch gateway is not configured.",
      );
    const body = JSON.stringify({
      id: d.id,
      kind: d.kind,
      to: contact,
      incident: {
        reference: i.reference,
        category: i.category,
        location: i.location,
        description: i.description,
        priority: i.priority,
      },
      acknowledgementUrl:
        d.kind === "offer"
          ? `${config.publicUrl}/?accept=${encodeURIComponent(i.id)}&contractor=${encodeURIComponent(d.contractorId!)}&token=${encodeURIComponent(i.acknowledgementToken)}`
          : undefined,
      emergencyGuidance,
      notice:
        "An offer requires explicit contractor acceptance. Never reset or disable a fire panel on automated instruction.",
    });
    const timestamp = String(Date.now());
    const response = await fetch(config.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": d.id,
        "x-blockops-timestamp": timestamp,
        "x-blockops-signature": createHmac("sha256", config.webhookSecret)
          .update(`${timestamp}.${body}`)
          .digest("hex"),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`Dispatch gateway returned ${response.status}.`);
  };
}
function currentDelivery(incident: Incident, delivery: Delivery): boolean {
  if (delivery.kind === "offer")
    return (
      incident.status === "offered" &&
      incident.contractorId === delivery.contractorId
    );
  if (delivery.kind === "manager") return incident.status === "escalated";
  return true;
}

function nextAction(incident: Incident | null): number | null {
  if (!incident) return null;
  const deliveries = incident.outbox.filter(
    (d) =>
      d.state !== "delivered" && d.attempts < 5 && currentDelivery(incident, d),
  );
  const times = deliveries.map((d) => d.nextAttempt);
  if (incident.dueAt !== null) times.push(incident.dueAt);
  return times.length ? Math.min(...times) : null;
}

export async function processIncident(
  store: IncidentStore,
  id: string,
  dispatch: Dispatch,
  live: boolean,
  now = Date.now(),
): Promise<number | null> {
  const due = nextAction(await store.get(id));
  if (due === null || due > now) return due;
  if (!(await store.lease(id, now))) return now + 5_000;
  try {
    let incident = await store.update(id, (current) => {
      const next = advanceIncident(current, now);
      if (next.stage > current.stage)
        next.acknowledgementToken = crypto.randomUUID();
      return next;
    });
    for (const delivery of incident.outbox) {
      // An expired offer must never be sent after a newer offer has been prepared.
      if (!currentDelivery(incident, delivery)) continue;
      if (
        delivery.state === "delivered" ||
        delivery.nextAttempt > now ||
        delivery.attempts >= 5
      )
        continue;
      try {
        await dispatch(incident, delivery);
        incident = await store.update(id, (i) => {
          const d = i.outbox.find((v) => v.id === delivery.id)!;
          d.state = "delivered";
          d.attempts++;
          const resident = d.kind === "receipt" || d.kind === "status";
          audit(
            i,
            live || resident
              ? "Notification accepted by provider"
              : "Demo notification simulated",
            resident
              ? "Resident email queued by Resend."
              : live
                ? "Provider accepted the request. Contractor acknowledgement is still required."
                : "No external message sent. Sample contacts only.",
            now,
          );
          return i;
        });
      } catch {
        incident = await store.update(id, (i) => {
          const d = i.outbox.find((v) => v.id === delivery.id)!;
          d.state = "failed";
          d.attempts++;
          d.lastError =
            "Delivery failed. Check gateway and approved contact configuration.";
          d.nextAttempt = now + Math.min(60_000, 2 ** d.attempts * 1000);
          audit(
            i,
            "Notification delivery failed",
            `${d.lastError} Attempt ${d.attempts}/5.`,
            now,
          );
          return i;
        });
      }
    }
    return nextAction(incident);
  } finally {
    await store.release(id, now);
  }
}
export async function tick(
  store: IncidentStore,
  dispatch: Dispatch,
  live: boolean,
  now = Date.now(),
) {
  const incidents = await store.list();
  for (const incident of incidents)
    if (nextAction(incident) !== null)
      await processIncident(store, incident.id, dispatch, live, now);
}
export function validateContacts(raw: string | undefined): Contractor[] {
  if (!raw) return [];
  const input: unknown = JSON.parse(raw);
  if (!Array.isArray(input))
    throw new Error("CONTRACTORS_JSON must be an array.");
  return input.map((c) => {
    const approved = contractors.find((x) => x.id === c.id);
    if (
      !approved ||
      typeof c.phone !== "string" ||
      !/^\+[1-9]\d{7,14}$/.test(c.phone)
    )
      throw new Error("Contractor IDs and E.164 phone numbers must be valid.");
    return { ...approved, phone: c.phone };
  });
}
