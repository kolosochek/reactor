// packages/reactor-service/scripts/rerecord-demo-session.mts
//
// Re-records a saved demo session on the current code (DEV-1380). A session file holds, per run,
// the request the page posted (run.start). This script posts each request again to a running
// service and writes the events it streams back, keeping the session.run lines as they are.
// Only sample-model runs are accepted: the sample model makes no LLM call, and every Kairon call
// behind it is a read (GET, or POST .../evaluate). Run from reactor-service:
//   node --import tsx scripts/rerecord-demo-session.mts <service url> <session.ndjson> <out.ndjson>
// The service must run with KAIRON_WIDGETS_DIST for the output to carry widget instances.

import { readFileSync, writeFileSync } from 'node:fs';
import { SAMPLE_MODEL } from '../src/kairon/sampleLlm.js';

interface SessionEvent {
  t: number;
  type: string;
  payload: { request?: { idea: unknown; providerConfig: { model: string } } };
}

const [base, input, output] = process.argv.slice(2);
if (base === undefined || input === undefined || output === undefined) {
  throw new Error('usage: rerecord-demo-session.mts <service url> <session.ndjson> <out.ndjson>');
}

const lines = readFileSync(input, 'utf8').split('\n').filter((line) => line.trim() !== '');
const out: string[] = [];
let runs = 0;

for (const [index, line] of lines.entries()) {
  const event = JSON.parse(line) as SessionEvent;
  if (event.type === 'session.run') {
    out.push(line);
    continue;
  }
  if (event.type !== 'run.start') continue;
  const request = event.payload.request;
  if (request === undefined) throw new Error(`line ${index + 1}: run.start has no request`);
  if (request.providerConfig.model !== SAMPLE_MODEL) {
    throw new Error(`line ${index + 1}: model ${request.providerConfig.model} is not the sample model; a live LLM run is not re-recorded`);
  }
  const response = await fetch(`${base}/kairon/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idea: request.idea, providerConfig: { model: SAMPLE_MODEL, apiKey: '' } }),
  });
  if (!response.ok) throw new Error(`line ${index + 1}: POST /kairon/run answered ${response.status}`);
  const events = (await response.text()).split('\n').filter((l) => l.trim() !== '');
  const last = JSON.parse(events.at(-1) ?? '{}') as { type?: string };
  if (last.type !== 'run.done') throw new Error(`line ${index + 1}: the run ended with ${last.type ?? 'nothing'}`);
  out.push(...events);
  runs += 1;
  console.log(`run ${runs}: ${events.length} events`);
}

writeFileSync(output, `${out.join('\n')}\n`);
console.log(`written ${output}: ${runs} runs, ${out.length} lines`);
