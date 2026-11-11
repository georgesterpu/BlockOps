import { start } from "workflow/api";
import { cloudRuntime } from "../../../../src/cloud.ts";
import { recordWhatsAppReport } from "../../../../src/whatsapp.ts";
import { incidentWorkflow } from "../../../../workflows/incidents.ts";
import { handleWhatsApp } from "./bot.ts";

export const dynamic = "force-dynamic";

async function handle(request: Request) {
  const {
    WHATSAPP_ACCESS_TOKEN: accessToken,
    WHATSAPP_APP_SECRET: appSecret,
    WHATSAPP_PHONE_NUMBER_ID: phoneNumberId,
    WHATSAPP_VERIFY_TOKEN: verifyToken,
    WHATSAPP_RESIDENT_PHONES,
  } = process.env;
  const residentPhones = new Set(
    WHATSAPP_RESIDENT_PHONES?.split(",").map(phone => phone.trim()).filter(Boolean),
  );
  if (!accessToken || !appSecret || !phoneNumberId || !verifyToken || !residentPhones.size) {
    return new Response("WhatsApp is awaiting configuration", { status: 503 });
  }
  return handleWhatsApp(request, { accessToken, appSecret, phoneNumberId, verifyToken, residentPhones },
    async (sender, id, text) => {
      const { store } = await cloudRuntime();
      return recordWhatsAppReport(store, async incidentId => {
        await start(incidentWorkflow, [incidentId]);
      }, sender, id, text);
    },
  );
}

export const GET = handle;
export const POST = handle;
