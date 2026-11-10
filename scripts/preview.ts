import { watch } from "node:fs";
import { resolve, sep } from "node:path";
const root = resolve("dist");
let rebuilding = false;
const streams = new Set<ReadableStreamDefaultController>();
watch("src", { recursive: true }, async () => {
  if (rebuilding) return;
  rebuilding = true;
  try {
    const child = Bun.spawn(["bun", "scripts/build.ts"], {
      stdout: "ignore",
      stderr: "inherit",
    });
    if ((await child.exited) === 0)
      for (const stream of streams)
        try {
          stream.enqueue(new TextEncoder().encode("data: reload\n\n"));
        } catch {
          streams.delete(stream);
        }
  } finally {
    rebuilding = false;
  }
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 3000,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/config")
      return Response.json({ demo: true, backend: false, live: false });
    if (url.pathname === "/__preview-events")
      return new Response(
        new ReadableStream({
          start(controller) {
            streams.add(controller);
            controller.enqueue(new TextEncoder().encode(": connected\n\n"));
          },
          cancel() {},
        }),
        {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
          },
        },
      );
    const path = resolve(
      root,
      "." +
        (url.pathname === "/"
          ? "/index.html"
          : decodeURIComponent(url.pathname)),
    );
    if (!path.startsWith(root + sep))
      return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    if (!(await file.exists()))
      return new Response("Not found", { status: 404 });
    if (url.pathname === "/")
      return new Response(
        (await file.text()).replace(
          "</body>",
          '<script>new EventSource("/__preview-events").onmessage=()=>location.reload()</script></body>',
        ),
        {
          headers: {
            "content-type": "text/html",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        },
      );
    return new Response(file, {
      headers: {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  },
});
console.log(
  `Preview ready: ${server.url} — automatically reloads after edits.`,
);
