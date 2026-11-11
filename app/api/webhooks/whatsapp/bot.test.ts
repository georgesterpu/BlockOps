import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { LocalSql } from "../../../../src/local-sql.ts";
import { Store } from "../../../../src/store.ts";
import { recordWhatsAppReport } from "../../../../src/whatsapp.ts";
import { handleWhatsApp } from "./bot.ts";

test("Chat SDK authenticates WhatsApp messages and returns a durable incident reference", async () => {
  const config = {
    accessToken: "test-token",
    appSecret: "test-app-secret",
    phoneNumberId: "123456789",
    verifyToken: "test-verification-token",
    residentPhones: new Set(["+15551234567"]),
  };
  const url = "https://blockops.example.test/api/webhooks/whatsapp";
  const db = new LocalSql(":memory:");
  const store = new Store(db);
  await store.init();
  await store.setSetting("routing", {
    managerEmail: "manager@example.test",
    contractorEmails: { "water-primary": "plumber@example.test" },
    residentEmails: [],
    automaticOffers: true,
  });
  const scheduled: string[] = [];
  const replies: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    expect(new URL(request.url).hostname).toBe("graph.facebook.com");
    const body = await request.json() as { text?: { body: string }; to?: string };
    if (body.text) replies.push(body.text.body);
    return Response.json({ messages: [{ id: "wamid.reply" }], success: true });
  }) as typeof fetch;
  const handle = (request: Request) => handleWhatsApp(request, config, (sender, id, text) =>
    recordWhatsAppReport(store, async incidentId => { scheduled.push(incidentId); }, sender, id, text));
  const webhook = (id: string, text: string, from = "15551234567", signed = true) => {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [{ field: "messages", value: {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: "15550000001", phone_number_id: config.phoneNumberId },
        contacts: [{ profile: { name: "Resident" }, wa_id: from }],
        messages: [{ id, from, timestamp: "1794355000", type: "text", text: { body: text } }],
      } }] }],
    });
    const signature = createHmac("sha256", config.appSecret).update(body).digest("hex");
    return new Request(url, { method: "POST", body, headers: { "x-hub-signature-256": signed ? `sha256=${signature}` : "invalid" } });
  };
  try {
    const challenge = await handle(new Request(`${url}?hub.mode=subscribe&hub.verify_token=${config.verifyToken}&hub.challenge=123`));
    expect(await challenge.text()).toBe("123");
    const text = "Location: Block B lobby\nWater is leaking under the sink.";
    expect((await handle(webhook("wamid.invalid", text, undefined, false))).status).toBe(401);
    expect((await handle(webhook("wamid.unenrolled", text, "15551234568"))).status).toBe(200);
    expect(replies.pop()).toContain("enrolled");
    expect((await handle(webhook("wamid.incomplete", "Water is leaking under the sink."))).status).toBe(200);
    expect(replies.pop()).toContain("Send the location");
    expect(await store.list()).toHaveLength(0);
    expect((await handle(webhook("wamid.report", text))).status).toBe(200);
    expect((await handle(webhook("wamid.report", text))).status).toBe(200);
    const incidents = await store.list();
    expect(incidents).toHaveLength(1);
    const [incident] = incidents;
    expect(incident).toMatchObject({ category: "water", source: "whatsapp", location: "Block B lobby", reviewRequired: false });
    expect(scheduled).toEqual([incident.id, incident.id]);
    expect(replies.every(reply => reply.includes(incident.reference))).toBe(true);
    expect(replies).toHaveLength(2);
    expect((await handle(webhook("wamid.urgent", "Location: Block B lobby\nSmoke is coming from the fire panel."))).status).toBe(200);
    expect(await store.byReceipt("whatsapp:wamid.urgent")).toMatchObject({ danger: true, reviewRequired: true });
  } finally {
    globalThis.fetch = previousFetch;
    db.db.close();
  }
});
