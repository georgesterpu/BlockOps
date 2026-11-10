# BlockOps

BlockOps is a residential incident desk for Shoreside Commons in Bray. Residents can report a fault by email or a web form. The desk records triage, offers, acceptance deadlines and manager follow-up.

The browser preview uses sample incidents and responders. The hosted pilot accepts reports from enrolled residents. Contractor offers require approved contacts and explicit activation. If there is fire, smoke or immediate danger, follow the building emergency plan and call 112 or 999. BlockOps is a maintenance coordination prototype.

## Local preview

Use Bun and TypeScript 7.

```sh
bun install
bun run preview
```

Open `http://localhost:3000`. Try **Report an issue** and use **Agent workflow → Advance 5 minutes** to see the next escalation. The preview saves changes in your browser.

For the local server with SQLite, copy `.env.example` to `.env`, choose a desk password, session secret and resident access code, then run `bun run dev`. Use **Settings & setup** to sign in and set routing. `bun run verify` runs TypeScript checks, the incident tests and the browser asset build.

## Vercel email pilot

Import the repository as a Vercel project. The project builds with Bun and uses the Next.js adapter for Vercel Workflow. The same incident rules run locally and in Vercel steps. Vercel suspends the workflow between acknowledgement deadlines and resumes it when a deadline or delivery retry is due.

1. Connect a private Vercel Blob store in the project’s Storage tab. Vercel adds `BLOB_READ_WRITE_TOKEN` automatically. The pilot stores its incident data in a private JSON document with consistent reads and conditional updates. Local development uses SQLite.
2. Set `PUBLIC_URL` to your production origin, `DEMO_MODE=false`, and `LIVE_DISPATCH=false`. Set `OPERATOR_PASSWORD` (at least 16 characters), `SESSION_SECRET` (at least 32 random characters), and `RESIDENT_ACCESS_CODE` as private environment variables.
3. Create a Resend key with access to retrieve incoming messages and send replies. Save it as `RESEND_API_KEY` in the project. `EMAIL_INBOX` and `EMAIL_FROM` default to `reports@blockops.january.ie`. Use an address on your verified sending and receiving domain for other deployments.
4. Redeploy after saving the variables. Sign into BlockOps, open **Settings**, and choose **Connect Resend**. BlockOps registers the `email.received` webhook and stores its signing secret in private storage. A manually configured `RESEND_WEBHOOK_SECRET` is also supported.
5. Enrol your own sender address in **Email routing**. Send a sample report from that address to the inbox. You should receive a reference and see the incident in the desk. This test keeps contractor and manager notifications simulated.

The webhook checks the provider signature and uses the received email ID to prevent duplicate incidents. Resend replies are queued with stable idempotency keys. The desk distinguishes a provider accepting a message from a contractor accepting a call-out.

An email with `Location: Block B lobby` is sufficient for location extraction. Include `Code: <resident access code>` on its own line if the building enables automatic offers. The code is removed from the incident text. Without an enrolled sender, the app ignores the message. With a missing code, ambiguous location or signs of danger, the report waits for manager review. The manager can approve a maintenance offer from the incident detail.

Agree the overnight roster and call-out authority before setting `LIVE_DISPATCH=true`. Email offers have a five-minute acceptance window. The workflow tries the backup and then the duty manager. Email delivery alone cannot guarantee an immediate response. Use the optional signed dispatch webhook for an agreed SMS or phone notification channel.

The optional Twilio handlers accept verified direct messages and phone reports at `/api/twilio/whatsapp` and `/api/twilio/voice`. These require a configured provider account and enrolled numbers. They are independent of the email pilot.
