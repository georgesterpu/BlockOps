import { start } from 'workflow/api';
import { cloudConfigured, cloudRuntime, cloudStorageReady } from '../../../src/cloud.ts';
import { emailWorkflow, incidentWorkflow } from '../../../workflows/incidents.ts';
import { DeskConfigurationError, operatorConfiguration } from '../../../src/runtime.ts';

export const dynamic = 'force-dynamic';

let runtime: ReturnType<typeof cloudRuntime> | undefined;

async function handle(request: Request) {
  const path = new URL(request.url).pathname;
  if (path === '/api/health' && request.method === 'GET') {
    try {
      const ready = await cloudStorageReady();
      let desk = 'demo';
      if (cloudConfigured()) {
        try { operatorConfiguration(); desk = 'configured'; }
        catch { desk = 'setup-required'; }
      }
      return Response.json({ ok: ready, storage: ready ? 'ready' : 'unconfigured', desk }, { status: ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
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
  } catch (error) {
    runtime = undefined;
    if (path === '/api/config') {
      return Response.json({
        demo: false, backend: false, live: false, email: null,
        setupIssue: error instanceof DeskConfigurationError ? error.message : 'The incident desk could not start. Try again shortly.',
      }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return Response.json({ error: 'The desk is temporarily unavailable.' }, { status: 503 });
  }
}

export const GET = handle;
export const POST = handle;
