import { sleep } from 'workflow';
import { cloudRuntime } from '../src/cloud.ts';
import { processIncident } from '../src/worker.ts';
import { receiveEmail } from '../src/email.ts';

async function recordEmail(emailId: string) {
  'use step';
  const runtime = await cloudRuntime();
  return receiveEmail(runtime.store, runtime.email, emailId);
}

async function deliverAndAdvance(id: string) {
  'use step';
  const runtime = await cloudRuntime();
  return processIncident(runtime.store, id, runtime.dispatch, runtime.live);
}

async function monitor(id: string) {
  let wake = await deliverAndAdvance(id);
  while (wake !== null) {
    await sleep(new Date(Math.max(wake, Date.now() + 1000)));
    wake = await deliverAndAdvance(id);
  }
}

export async function incidentWorkflow(id: string) {
  'use workflow';
  await monitor(id);
}

export async function emailWorkflow(emailId: string) {
  'use workflow';
  const id = await recordEmail(emailId);
  if (id) await monitor(id);
}
