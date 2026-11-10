import { start } from 'workflow/api';
import { cloudConfigured, cloudRuntime, cloudStorageReady } from '../../../src/cloud.ts';
import { emailWorkflow, incidentWorkflow } from '../../../workflows/incidents.ts';

export const dynamic = 'force-dynamic';

let runtime: ReturnType<typeof cloudRuntime> | undefined;

async function handle(request: Request) {
  const path = new URL(request.url).pathname;
  if (path === '/api/health' && request.method === 'GET') {
    try {
      const ready = await cloudStorageReady();
      return Response.json({ ok: ready, storage: ready ? 'ready' : 'unconfigured', desk: cloudConfigured() ? 'configured' : 'demo' }, { status: ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
    } catch {
      return Response.json({ ok: false, storage: 'unavailable' }, { status: 503 });
    }
  }
  if (!cloudConfigured()) {
    if (path === '/api/config') return Response.json({ demo: true, backend: false, live: false, email: null });
    return Response.json({ error: 'The server is awaiting configuration.' }, { status: 503 });
  }
  try {
    runtime ??= cloudRuntime({
      startEmail: async id => { await start(emailWorkflow, [id]); },
      startIncident: async id => { await start(incidentWorkflow, [id]); },
    });
    return await (await runtime).handler(request);
  } catch {
    runtime = undefined;
    return Response.json({ error: 'The desk is temporarily unavailable.' }, { status: 503 });
  }
}

export const GET = handle;
export const POST = handle;
