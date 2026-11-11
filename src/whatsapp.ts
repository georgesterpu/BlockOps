import { createIncident, emergencyGuidance, triage } from "./domain.ts";
import type { Report } from "./domain.ts";
import { detectCategory } from "./email.ts";
import { getRouting } from "./routing.ts";
import type { IncidentStore } from "./store.ts";

export async function recordWhatsAppReport(
  store: IncidentStore,
  schedule: (id: string) => Promise<void>,
  sender: string,
  messageId: string,
  text: string,
): Promise<string> {
  const receipt = `whatsapp:${messageId}`;
  let incident = await store.byReceipt(receipt);
  if (!incident) {
    const locationLine = text.match(/^Location:[ \t]*(.+)$/im);
    const location = locationLine?.[1].trim() ?? "";
    const description = text.replace(locationLine?.[0] ?? "", "").trim();
    if (location.length < 2 || location.length > 160 ||
        description.length < 10 || description.length > 3000) {
      return "Send the location and fault in one message. For example:\nLocation: Block B lobby\nWater is leaking under the sink.\n\n" + emergencyGuidance;
    }
    if (await store.limited(`whatsapp:${sender}`, 20)) {
      return "Report limit reached. Contact your duty manager directly.\n\n" + emergencyGuidance;
    }
    const report: Report = {
      category: detectCategory(description),
      location,
      description,
      source: "whatsapp",
      danger: false,
    };
    report.danger = triage(report).priority === "critical";
    const routing = await getRouting(store);
    report.reviewRequired =
      report.danger || !routing.automaticOffers ||
      !routing.contractorEmails[`${report.category}-primary`];
    incident = await store.create(
      createIncident(report, crypto.randomUUID(), crypto.randomUUID()),
      receipt,
    );
  }
  // Provider retries reuse the ticket. The incident worker leases each delivery.
  await schedule(incident.id);
  return `Report ${incident.reference} recorded for ${incident.location}. Contractor attendance is pending confirmation.\n\n${emergencyGuidance}`;
}
