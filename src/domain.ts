export type Category =
  "fire-alarm" | "water" | "access" | "electrical" | "other";
export type Status =
  "queued" | "offered" | "accepted" | "escalated" | "resolved";
export type Priority = "critical" | "urgent" | "routine";
export interface Report {
  category: Category;
  location: string;
  description: string;
  danger: boolean;
  source: "web" | "whatsapp" | "phone" | "email";
  reviewRequired?: boolean;
  reporter?: { email: string; messageId?: string };
}
export interface Audit {
  id: string;
  at: number;
  title: string;
  detail: string;
  actor: string;
}
export interface Delivery {
  id: string;
  kind: "offer" | "manager" | "receipt" | "status";
  contractorId?: string;
  state: "pending" | "delivered" | "failed";
  attempts: number;
  nextAttempt: number;
  lastError?: string;
  message?: string;
}
export interface Incident extends Report {
  id: string;
  reference: string;
  createdAt: number;
  updatedAt: number;
  priority: Priority;
  status: Status;
  stage: number;
  dueAt: number | null;
  contractorId?: string;
  acknowledgementToken: string;
  resolution?: string;
  events: Audit[];
  outbox: Delivery[];
}
export interface Contractor {
  id: string;
  name: string;
  trade: string;
  initials: string;
  color: string;
  phone?: string;
}
export const contractors: Contractor[] = [
  {
    id: "fire-primary",
    name: "Harbour Fire Systems",
    trade: "Fire & life safety",
    initials: "HF",
    color: "orange",
  },
  {
    id: "fire-backup",
    name: "Wicklow Alarm Services",
    trade: "Fire & life safety · backup",
    initials: "WA",
    color: "purple",
  },
  {
    id: "water-primary",
    name: "Coastal Plumbing",
    trade: "Plumbing & drainage",
    initials: "CP",
    color: "blue",
  },
  {
    id: "water-backup",
    name: "Bray Emergency Plumbing",
    trade: "Plumbing · backup",
    initials: "BP",
    color: "blue",
  },
  {
    id: "access-primary",
    name: "Seaview Access",
    trade: "Doors & access control",
    initials: "SA",
    color: "green",
  },
  {
    id: "access-backup",
    name: "Wicklow Locksmiths",
    trade: "Access · backup",
    initials: "WL",
    color: "green",
  },
  {
    id: "electrical-primary",
    name: "East Coast Electrical",
    trade: "Electrical services",
    initials: "EC",
    color: "purple",
  },
  {
    id: "electrical-backup",
    name: "Bray Electrical Response",
    trade: "Electrical · backup",
    initials: "BE",
    color: "purple",
  },
];
export const categoryNames: Record<Category, string> = {
  "fire-alarm": "Fire alarm",
  water: "Water & plumbing",
  access: "Doors & access",
  electrical: "Electrical",
  other: "General maintenance",
};
export const emergencyGuidance =
  "If there is fire, smoke, immediate danger, or uncertainty about an alarm, follow the building emergency plan and call 112 or 999. Do not wait for BlockOps. Do not silence, reset, or disable the fire panel.";
export const ACK_WINDOW = 5 * 60_000;
export function triage(report: Report): { priority: Priority; reason: string } {
  // Text can raise urgency; it can never remove a resident's danger flag.
  const hazard =
    /\b(smoke|fire|flames?|burning|trapped|sparks?|gas|injur\w*|electrocut\w*)\b/i.test(
      report.description,
    );
  if (report.danger || hazard || report.category === "fire-alarm")
    return {
      priority: "critical",
      reason: "Potential life-safety issue. Urgent human assessment required.",
    };
  if (
    report.category === "water" ||
    report.category === "electrical" ||
    report.category === "access"
  )
    return {
      priority: "urgent",
      reason:
        "Essential building service affected. Route to the approved on-call trade.",
    };
  return {
    priority: "routine",
    reason: "Manager review required before any contractor call-out.",
  };
}
export function audit(
  i: Incident,
  title: string,
  detail: string,
  at: number,
  actor = "BlockOps agent",
) {
  i.events.push({ id: `${i.id}-${i.events.length}`, at, title, detail, actor });
  i.updatedAt = at;
}
export function createIncident(
  report: Report,
  id: string,
  token: string,
  now = Date.now(),
): Incident {
  const assessment = triage(report);
  const i: Incident = {
    ...report,
    id,
    reference: `BO-${id.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    acknowledgementToken: token,
    createdAt: now,
    updatedAt: now,
    priority: assessment.priority,
    status: "queued",
    stage: 0,
    dueAt: now,
    events: [],
    outbox: [],
  };
  audit(
    i,
    "Report received",
    `Via ${report.source} · ${report.location}`,
    now,
    "Resident",
  );
  audit(i, "Triage completed", assessment.reason, now);
  if (assessment.priority === "critical")
    audit(i, "Emergency guidance", emergencyGuidance, now);
  if (report.reporter) {
    const receipt = `Your report ${i.reference} was recorded for ${i.location}. ${report.reviewRequired ? "It is awaiting a duty manager review. " : ""}This receipt does not confirm that a contractor is attending.\n\n${emergencyGuidance}`;
    i.outbox.push({
      id: `${id}-receipt`,
      kind: "receipt",
      message: receipt,
      state: "pending",
      attempts: 0,
      nextAttempt: now,
    });
  }
  return i;
}
export function advanceIncident(
  original: Incident,
  now = Date.now(),
): Incident {
  const i = structuredClone(original);
  if (
    i.dueAt === null ||
    i.dueAt > now ||
    i.status === "accepted" ||
    i.status === "resolved" ||
    i.status === "escalated"
  )
    return i;
  if (i.reviewRequired || i.category === "other" || i.stage >= 2) {
    i.status = "escalated";
    i.dueAt = null;
    audit(
      i,
      "Escalated to duty manager",
      i.category === "other" || i.reviewRequired
        ? "Manager review is required before a call-out."
        : "Neither contractor acknowledged within the response window. Human follow-up required.",
      now,
    );
    i.outbox.push({
      id: `${i.id}-manager-${i.stage}`,
      kind: "manager",
      state: "pending",
      attempts: 0,
      nextAttempt: now,
    });
    return i;
  }
  const prefix = i.category === "fire-alarm" ? "fire" : i.category;
  const contractorId = `${prefix}-${i.stage === 0 ? "primary" : "backup"}`;
  const name =
    contractors.find((c) => c.id === contractorId)?.name || contractorId;
  if (i.stage > 0)
    audit(
      i,
      "Acknowledgement deadline missed",
      "Primary offer expired; proceeding to the backup contractor.",
      now,
    );
  i.contractorId = contractorId;
  i.stage += 1;
  i.status = "offered";
  i.dueAt = now + ACK_WINDOW;
  audit(
    i,
    "Contractor offer prepared",
    `${name} · acknowledgement required within 5 minutes. An offer is not an attendance confirmation.`,
    now,
  );
  i.outbox.push({
    id: `${i.id}-offer-${i.stage}`,
    kind: "offer",
    contractorId,
    state: "pending",
    attempts: 0,
    nextAttempt: now,
  });
  return i;
}
export function acceptIncident(
  original: Incident,
  contractorId: string,
  now = Date.now(),
): Incident {
  if (
    original.status !== "offered" ||
    original.contractorId !== contractorId ||
    !original.dueAt ||
    original.dueAt <= now
  )
    throw new Error("This offer has expired or is no longer available.");
  const i = structuredClone(original);
  i.status = "accepted";
  i.dueAt = null;
  audit(
    i,
    "Contractor accepted",
    "Call-out acknowledged. Attendance and ETA must be confirmed by the contractor.",
    now,
    contractors.find((c) => c.id === contractorId)?.name || contractorId,
  );
  if (i.reporter)
    i.outbox.push({
      id: `${i.id}-accepted`,
      kind: "status",
      message:
        "A contractor has accepted the call-out. The duty manager will confirm attendance and an ETA.",
      state: "pending",
      attempts: 0,
      nextAttempt: now,
    });
  return i;
}
export function resolveIncident(
  original: Incident,
  note: string,
  now = Date.now(),
): Incident {
  if (original.status === "resolved")
    throw new Error("Incident already resolved.");
  if (note.trim().length < 10 || note.length > 2000)
    throw new Error("Add a resolution note of 10–2,000 characters.");
  const i = structuredClone(original);
  i.status = "resolved";
  i.dueAt = null;
  i.resolution = note.trim();
  audit(i, "Incident resolved", i.resolution, now, "Duty manager");
  if (i.reporter)
    i.outbox.push({
      id: `${i.id}-resolved`,
      kind: "status",
      message: `The duty manager recorded a resolution for ${i.reference}. If the issue recurs, send a new report.`,
      state: "pending",
      attempts: 0,
      nextAttempt: now,
    });
  return i;
}
export function parseReport(input: unknown): Report {
  if (!input || typeof input !== "object")
    throw new Error("A report is required.");
  const r = input as Record<string, unknown>;
  if (
    typeof r.category !== "string" ||
    !Object.hasOwn(categoryNames, r.category)
  )
    throw new Error("Choose an issue type.");
  if (
    typeof r.location !== "string" ||
    r.location.trim().length < 2 ||
    r.location.length > 160
  )
    throw new Error("Enter a location of 2–160 characters.");
  if (
    typeof r.description !== "string" ||
    r.description.trim().length < 10 ||
    r.description.length > 3000
  )
    throw new Error("Describe the issue in 10–3,000 characters.");
  if (typeof r.danger !== "boolean")
    throw new Error("Confirm whether there is immediate danger.");
  return {
    category: r.category as Category,
    location: r.location.trim(),
    description: r.description.trim(),
    danger: r.danger,
    source: "web",
  };
}
