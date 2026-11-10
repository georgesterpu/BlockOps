import type { IncidentStore } from "./store.ts";
import { api } from "./api.ts";
import { validateContacts, webhookDispatch } from "./worker.ts";
import { emailDispatch } from "./email.ts";
import type { EmailConfig } from "./email.ts";
import { emailAddress } from "./routing.ts";

export class DeskConfigurationError extends Error {}

export function operatorConfiguration(env = process.env) {
  const { OPERATOR_PASSWORD: password, SESSION_SECRET: sessionSecret, RESIDENT_ACCESS_CODE: residentCode } = env;
  if (!password || password.length < 16) throw new DeskConfigurationError('Set OPERATOR_PASSWORD to at least 16 characters in Vercel.');
  if (!sessionSecret || sessionSecret.length < 32) throw new DeskConfigurationError('Set SESSION_SECRET to at least 32 characters in Vercel.');
  if (!residentCode) throw new DeskConfigurationError('Set RESIDENT_ACCESS_CODE in Vercel.');
  return { password, sessionSecret, residentCode };
}

export async function createRuntime(
  store: IncidentStore,
  workflow: {
    startIncident?: (id: string) => Promise<void>;
    startEmail?: (id: string) => Promise<void>;
  } = {},
) {
  const e = process.env,
    live = e.LIVE_DISPATCH === "true";
  const operator = operatorConfiguration(e);
  await store.init();
  const publicUrl = (
    e.PUBLIC_URL ||
    (e.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${e.VERCEL_PROJECT_PRODUCTION_URL}`
      : `http://localhost:${e.PORT || 3000}`)
  ).replace(/\/$/, "");
  const contacts = validateContacts(e.CONTRACTORS_JSON);
  const email: EmailConfig = {
    apiKey: e.RESEND_API_KEY || "",
    webhookSecret: e.RESEND_WEBHOOK_SECRET || "",
    inbox: emailAddress(e.EMAIL_INBOX || "reports@blockops.january.ie"),
    from: emailAddress(e.EMAIL_FROM || "reports@blockops.january.ie"),
    accessCode: operator.residentCode,
    publicUrl,
    live,
  };
  if (
    live &&
    !email.apiKey &&
    (!e.DISPATCH_WEBHOOK_URL?.startsWith("https://") ||
      !e.DISPATCH_WEBHOOK_SECRET ||
      !e.MANAGER_PHONE ||
      !contacts.length)
  )
    throw new Error(
      "Live dispatch requires Resend or an HTTPS gateway with approved contacts.",
    );
  const fallback = webhookDispatch({
    live,
    publicUrl,
    contacts,
    webhookUrl: e.DISPATCH_WEBHOOK_URL,
    webhookSecret: e.DISPATCH_WEBHOOK_SECRET,
    managerPhone: e.MANAGER_PHONE,
  });
  const dispatch =
    email.apiKey && email.from
      ? emailDispatch(store, email, fallback)
      : fallback;
  const handler = api({
    store,
    dispatch,
    live,
    demo: e.DEMO_MODE !== "false",
    publicUrl,
    ...operator,
    twilioToken: e.TWILIO_AUTH_TOKEN,
    twilioSid: e.TWILIO_ACCOUNT_SID,
    residentPhones: e.RESIDENT_PHONES?.split(",").map((x) => x.trim()),
    email,
    startWorkflow: workflow.startIncident,
    startEmailWorkflow: workflow.startEmail,
  });
  return { store, dispatch, handler, live, email };
}
