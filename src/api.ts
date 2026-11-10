import {
  createIncident,
  parseReport,
  acceptIncident,
  resolveIncident,
  emergencyGuidance,
  audit,
} from "./domain.ts";
import { equal, session, validSession, validTwilio } from "./auth.ts";
import { processIncident } from "./worker.ts";
import type { Dispatch } from "./worker.ts";
import type { IncidentStore } from "./store.ts";
import { connectEmail, detectCategory, emailSigningSecret, receiveEmail, verifyEmailEvent } from "./email.ts";
import type { EmailConfig } from "./email.ts";
import { getRouting, parseRouting } from "./routing.ts";
export interface ApiConfig {
  store: IncidentStore;
  dispatch: Dispatch;
  live: boolean;
  demo: boolean;
  publicUrl: string;
  password: string;
  sessionSecret: string;
  residentCode: string;
  twilioToken?: string;
  twilioSid?: string;
  residentPhones?: string[];
  email?: EmailConfig;
  startWorkflow?: (id: string) => Promise<void>;
  startEmailWorkflow?: (id: string) => Promise<void>;
}
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });
const xml = (text: string) =>
  new Response(text, {
    headers: { "content-type": "text/xml", "cache-control": "no-store" },
  });
const escapeXml = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
export function api(config: ApiConfig) {
  const { store } = config;
  async function schedule(id: string) {
    if (config.startWorkflow) await config.startWorkflow(id);
    else await processIncident(store, id, config.dispatch, config.live);
  }
  async function ingest(
    report: ReturnType<typeof parseReport>,
    receipt: string,
  ) {
    if (config.email?.apiKey && config.live) {
      const routing = await getRouting(store);
      report.reviewRequired = !routing.automaticOffers || report.danger;
    }
    const i = await store.create(
      createIncident(report, crypto.randomUUID(), crypto.randomUUID()),
      receipt,
    );
    try {
      await schedule(i.id);
    } catch {
      return { incident: i, workflowPending: true };
    }
    return { incident: await store.get(i.id), workflowPending: false };
  }
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url),
      path = url.pathname,
      method = request.method;
    try {
      if (Number(request.headers.get("content-length") || 0) > 16_384)
        return json({ error: "Request too large." }, 413);
      // Same-origin browser writes. Signed provider and workflow requests have their own verification.
      const origin = request.headers.get("origin");
      if (
        method !== "GET" &&
        method !== "HEAD" &&
        origin &&
        origin !== new URL(config.publicUrl).origin
      )
        return json({ error: "Origin not allowed." }, 403);
      if (path === "/api/config")
        return json({
          demo: config.demo,
          backend: true,
          live: config.live,
          emailKeyConfigured: Boolean(config.email?.apiKey),
          email:
            config.email?.apiKey && await emailSigningSecret(store, config.email)
              ? config.email.inbox
              : null,
        });
      if (path === "/api/health") {
        await store.check();
        return json({ ok: true, mode: config.live ? "live" : "simulation" });
      }
      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
      if (path === "/api/email/resend" && method === "POST") {
        const email = config.email;
        const secret = email?.apiKey ? await emailSigningSecret(store, email) : '';
        if (!email?.apiKey || !secret)
          return json({ error: "Email intake is not configured." }, 503);
        const body = await request.text();
        if (body.length > 16_384)
          return json({ error: "Request too large." }, 413);
        if (!verifyEmailEvent(request, body, secret))
          return json({ error: "Invalid provider signature." }, 401);
        const event = JSON.parse(body) as {
          type?: string;
          data?: { email_id?: string };
        };
        if (event.type !== "email.received") return json({ ignored: true });
        const id = event.data?.email_id;
        if (typeof id !== "string" || !/^[a-z0-9_-]{8,100}$/i.test(id))
          return json({ error: "Invalid email ID." }, 400);
        try {
          if (config.startEmailWorkflow) await config.startEmailWorkflow(id);
          else {
            const incidentId = await receiveEmail(store, email, id);
            if (incidentId) await schedule(incidentId);
          }
        } catch {
          console.error(
            "Email intake could not be queued. Resend can retry this event.",
          );
          return json(
            { error: "Email intake is temporarily unavailable." },
            503,
          );
        }
        console.info("BlockOps accepted a signed Resend event.");
        return json({ received: true }, 202);
      }
      if (path === "/api/login" && method === "POST") {
        if (await store.limited(`login:${ip}`, 10))
          return json(
            { error: "Too many attempts. Try again in 15 minutes." },
            429,
          );
        const body = (await request.json()) as { password?: string };
        if (
          typeof body.password !== "string" ||
          !config.password ||
          !equal(body.password, config.password)
        )
          return json({ error: "Incorrect desk password." }, 401);
        const cookie = `blockops_session=${session(config.sessionSecret)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${config.publicUrl.startsWith("https:") ? "; Secure" : ""}`;
        return Response.json(
          { ok: true },
          { headers: { "set-cookie": cookie, "cache-control": "no-store" } },
        );
      }
      if (path === "/api/logout" && method === "POST")
        return Response.json(
          { ok: true },
          {
            headers: {
              "set-cookie":
                "blockops_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
              "cache-control": "no-store",
            },
          },
        );
      if (path === "/api/reports" && method === "POST") {
        if (await store.limited(`report:${ip}`, 20))
          return json(
            {
              error:
                "Report limit reached. Call the duty contact for urgent follow-up.",
            },
            429,
          );
        const input = (await request.json()) as Record<string, unknown>;
        if (
          !config.residentCode ||
          typeof input.accessCode !== "string" ||
          !equal(input.accessCode, config.residentCode)
        )
          return json({ error: "Enter your resident access code." }, 401);
        const report = parseReport(input);
        const key = request.headers.get("idempotency-key");
        if (!key || !/^[\w-]{8,100}$/.test(key))
          return json({ error: "A valid idempotency key is required." }, 400);
        const result = await ingest(report, `web:${key}`);
        return json(
          {
            reference: result.incident!.reference,
            status: result.incident!.status,
            guidance: emergencyGuidance,
            workflowPending: result.workflowPending,
          },
          201,
        );
      }
      if (path === "/api/accept" && method === "POST") {
        if (await store.limited(`accept:${ip}`, 60))
          return json({ error: "Too many attempts." }, 429);
        const b = (await request.json()) as {
          id: string;
          contractorId: string;
          token: string;
        };
        if (
          typeof b.id !== "string" ||
          typeof b.contractorId !== "string" ||
          typeof b.token !== "string"
        )
          return json({ error: "Invalid offer link." }, 403);
        const i = await store.get(b.id);
        if (!i || !equal(i.acknowledgementToken, b.token))
          return json({ error: "Invalid offer link." }, 403);
        const accepted = await store.update(i.id, (current) => {
          if (!equal(current.acknowledgementToken, b.token))
            throw new Error("This offer has expired.");
          if (
            current.status === "accepted" &&
            current.contractorId === b.contractorId
          )
            return current;
          return acceptIncident(current, b.contractorId);
        });
        if (accepted.reporter) await schedule(accepted.id);
        return json({ ok: true, reference: i.reference });
      }
      if (path.startsWith("/api/twilio/") && method === "POST") {
        const params = new URLSearchParams(await request.text());
        if (
          !validTwilio(
            request,
            params,
            config.publicUrl,
            config.twilioToken || "",
          ) ||
          params.get("AccountSid") !== config.twilioSid
        )
          return json({ error: "Invalid provider signature." }, 403);
        const sender = (params.get("From") || "").replace(/^whatsapp:/, "");
        if (!config.residentPhones?.includes(sender))
          return xml(
            `<Response>${path.endsWith("voice") ? "<Say>Please use your resident report link or contact your property manager. In an emergency call 112 or 999.</Say><Hangup/>" : "<Message>This number is not registered. Please use your resident report link. In an emergency call 112 or 999.</Message>"}</Response>`,
          );
        if (await store.limited(`phone:${sender}`, 20))
          return xml(
            "<Response><Message>Too many reports. Please contact the duty manager directly.</Message></Response>",
          );
        if (path === "/api/twilio/voice" && !params.get("SpeechResult"))
          return xml(
            `<Response><Say>${escapeXml(emergencyGuidance)}</Say><Gather input="speech" action="${escapeXml(config.publicUrl + "/api/twilio/voice")}" method="POST" language="en-IE" speechTimeout="auto"><Say>After the tone, say the issue type, location and what happened. For example: fire alarm, Block B lobby, panel beeping.</Say></Gather><Say>No report was recorded. Please use the resident web form.</Say></Response>`,
          );
        const text = params.get("Body") || params.get("SpeechResult") || "";
        if (text.length < 10)
          return xml(
            "<Response><Message>Please include the issue type, location and a description of at least 10 characters.</Message></Response>",
          );
        const category = detectCategory(text);
        const sid = params.get("MessageSid") || params.get("CallSid");
        if (!sid)
          return json({ error: "Provider message ID is required." }, 400);
        const result = await ingest(
          {
            ...parseReport({
              category,
              location: "Shoreside Commons · location in report",
              description: text,
              danger: false,
            }),
            source: path.endsWith("voice") ? "phone" : "whatsapp",
          },
          `twilio:${sid}`,
        );
        const reply = `Report ${result.incident!.reference} recorded. ${emergencyGuidance} This is not a confirmation of contractor attendance.${result.workflowPending ? " Workflow start is pending. Please contact your duty manager." : ""}`;
        return xml(
          `<Response>${path.endsWith("voice") ? `<Say>${escapeXml(reply)}</Say>` : `<Message>${escapeXml(reply)}</Message>`}</Response>`,
        );
      }
      if (!validSession(request, config.sessionSecret))
        return json({ error: "Sign in to the incident desk." }, 401);
      if (path === "/api/settings" && method === "GET")
        return json(await getRouting(store));
      if (path === "/api/settings/email" && method === "POST") {
        if (!config.email) return json({ error: 'Email is unavailable.' }, 503);
        await connectEmail(store, config.email);
        return json({ email: config.email.inbox });
      }
      if (path === "/api/settings" && method === "POST") {
        const settings = parseRouting(await request.json());
        await store.setSetting("routing", settings);
        return json(settings);
      }
      if (path === "/api/incidents" && method === "GET") {
        const incidents = (await store.list()).map(
          ({ acknowledgementToken, ...i }) => i,
        );
        return json({ incidents });
      }
      const approve = path.match(/^\/api\/incidents\/([\w-]+)\/dispatch$/);
      if (approve && method === "POST") {
        const routing = await getRouting(store);
        const incident = await store.update(approve[1], (current) => {
          if (
            current.status !== "escalated" ||
            !current.reviewRequired ||
            current.category === "other"
          )
            throw new Error("This incident is not awaiting dispatch approval.");
          const prefix =
            current.category === "fire-alarm" ? "fire" : current.category;
          if (config.live && !routing.contractorEmails[`${prefix}-primary`])
            throw new Error("Configure an approved primary contractor first.");
          current.reviewRequired = false;
          current.status = "queued";
          current.dueAt = Date.now();
          audit(
            current,
            "Call-out authorised",
            "Duty manager approved an offer to the configured contractor.",
            current.dueAt,
            "Duty manager",
          );
          return current;
        });
        await schedule(incident.id);
        return json({ ok: true });
      }
      const match = path.match(/^\/api\/incidents\/([\w-]+)\/resolve$/);
      if (match && method === "POST") {
        const b = (await request.json()) as { note: string };
        if (typeof b.note !== "string")
          return json({ error: "A resolution note is required." }, 400);
        const incident = await store.update(match[1], (i) =>
          i.status === "resolved" && i.resolution === b.note.trim()
            ? i
            : resolveIncident(i, b.note),
        );
        if (incident.reporter) await schedule(incident.id);
        return json({ ok: true });
      }
      return json({ error: "Route not found." }, 404);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Request failed.";
      if (/Database|concurrently|fetch|SQLITE|Workflow/i.test(message)) {
        if (method === "POST" && path === "/api/settings")
          return json({ error: "Settings could not be saved. Try saving again." }, 503);
        if (method === "POST" && path === "/api/settings/email")
          return json({
            error: /fetch/i.test(message)
              ? "BlockOps could not reach Resend. Try connecting again."
              : "BlockOps could not save the Resend connection. Try connecting again.",
          }, 503);
        return json(
          {
            error:
              "Service temporarily unavailable. Please retry or contact the duty manager.",
          },
          503,
        );
      }
      return json({ error: message }, 400);
    }
  };
}
