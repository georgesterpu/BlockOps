import { createRuntime } from "./runtime.ts";
import { tick } from "./worker.ts";
import { resolve, sep } from "node:path";
import { LocalSql } from "./local-sql.ts";
import { Store } from "./store.ts";
const port = Number(process.env.PORT || 3000);
const runtime = await createRuntime(
  new Store(new LocalSql(process.env.DATABASE_PATH || "data/blockops.sqlite")),
);
const root = resolve("dist");
const server = Bun.serve({
  port,
  hostname: process.env.HOST || "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return runtime.handler(request);
    const filePath = resolve(
      root,
      "." +
        decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname),
    );
    if (!filePath.startsWith(root + sep))
      return new Response("Not found", { status: 404 });
    const file = Bun.file(filePath);
    if (!(await file.exists()))
      return new Response("Not found", { status: 404 });
    return new Response(file, {
      headers: {
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy":
          "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      },
    });
  },
});
let running = false;
const timer = setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await tick(runtime.store, runtime.dispatch, runtime.live);
  } catch {
    console.error("Worker tick failed; retrying on next interval.");
  } finally {
    running = false;
  }
}, 5_000);
console.log(
  `BlockOps listening at ${server.url} (${runtime.live ? "live dispatch" : "simulation"})`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    clearInterval(timer);
    server.stop();
    process.exit(0);
  });
