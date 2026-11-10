import type { IncidentStore } from "./store.ts";
import { api } from "./api.ts";
import { validateContacts, webhookDispatch } from "./worker.ts";
import { emailDispatch } from "./email.ts";
import type { EmailConfig } from "./email.ts";
import { emailAddress } from "./routing.ts";

export async function createRuntime(
  store: IncidentStore,
  workflow: {
    startIncident?: (id: string) => Promise<void>;
    startEmail?: (id: string) => Promise<void>;
  } = {},
) {
  const e = process.env,
    live = e.LIVE_DISPATCH === "true";
  if (
    !e.OPERATOR_PASSWORD ||
    e.OPERATOR_PASSWORD.length < 16 ||
    !e.SESSION_SECRET ||
    e.SESSION_SECRET.length < 32 ||
    !e.RESIDENT_ACCESS_CODE
  )
    throw new Error(
      "Set OPERATOR_PASSWORD (16+ chars), SESSION_SECRET (32+ chars) and RESIDENT_ACCESS_CODE. See .env.example.",
    );
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
    accessCode: e.RESIDENT_ACCESS_CODE,
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
    password: e.OPERATOR_PASSWORD,
    sessionSecret: e.SESSION_SECRET,
    residentCode: e.RESIDENT_ACCESS_CODE,
    twilioToken: e.TWILIO_AUTH_TOKEN,
    twilioSid: e.TWILIO_ACCOUNT_SID,
    residentPhones: e.RESIDENT_PHONES?.split(",").map((x) => x.trim()),
    email,
    startWorkflow: workflow.startIncident,
    startEmailWorkflow: workflow.startEmail,
  });
  return { store, dispatch, handler, live, email };
}
