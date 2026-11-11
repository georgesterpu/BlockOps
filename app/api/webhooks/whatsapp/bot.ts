import { createMemoryState } from "@chat-adapter/state-memory";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import { Chat, ConsoleLogger } from "chat";
import { emergencyGuidance } from "../../../../src/domain.ts";

export async function handleWhatsApp(
  request: Request,
  config: {
    accessToken: string;
    appSecret: string;
    phoneNumberId: string;
    verifyToken: string;
    residentPhones: ReadonlySet<string>;
  },
  report: (sender: string, id: string, text: string) => Promise<string>,
): Promise<Response> {
  const tasks: Promise<unknown>[] = [];
  let failed = false;
  // A DM is a complete report. Only the incident store persists across requests.
  const bot = new Chat({
    userName: "BlockOps",
    adapters: { whatsapp: createWhatsAppAdapter({ ...config, logger: new ConsoleLogger("silent") }) },
    state: createMemoryState(),
    concurrency: "concurrent",
    logger: "silent",
  });
  bot.onDirectMessage(async (thread, message) => {
    if (!thread.id.startsWith(`whatsapp:${config.phoneNumberId}:`)) return;
    try {
      const sender = `+${message.author.userId}`;
      const reply = config.residentPhones.has(sender)
        ? await report(sender, message.id, message.text)
        : `This number needs to be enrolled by your property manager. Use the resident web form to report a fault.\n\n${emergencyGuidance}`;
      await thread.post(reply);
    } catch {
      failed = true;
    }
  });
  const response = await bot.webhooks.whatsapp(request, {
    waitUntil: task => { tasks.push(task); },
  });
  // Acknowledge the webhook after the report is stored and the workflow is queued.
  await Promise.all(tasks);
  if (failed) {
    console.error("BlockOps could not process a WhatsApp message.");
    return new Response("WhatsApp processing unavailable", { status: 503 });
  }
  return response;
}
