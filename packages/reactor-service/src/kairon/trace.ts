// packages/reactor-service/src/kairon/trace.ts
//
// Trace wrappers for the forecast prototype (DEV-1364 stage 3). Tool calls
// report their input schema, arguments, output and duration; Kairon API calls
// report method, path, status, duration, request body and reply. Events go to
// the activity's onProgress, which /kairon/run streams to the page.

import type { Activity, ProgressEvent } from '@kolosochek/reactor-core';
import type { KaironApi } from './client.js';

type Emit = (event: ProgressEvent) => void;

export function traceActivity(
  tool: string,
  kind: 'explicit' | 'latent',
  inputSchema: unknown,
  activity: Activity,
  now: () => number = Date.now,
): Activity {
  return async (input, ctx) => {
    ctx.onProgress?.({ type: 'tool.start', payload: { tool, kind, inputSchema, args: input } });
    const started = now();
    try {
      const output = await activity(input, ctx);
      ctx.onProgress?.({ type: 'tool.end', payload: { tool, ms: now() - started, output } });
      return output;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.onProgress?.({ type: 'tool.error', payload: { tool, ms: now() - started, message } });
      throw err;
    }
  };
}

export function traceKaironApi(api: KaironApi, emit: Emit | undefined, now: () => number = Date.now): KaironApi {
  if (emit === undefined) return api;
  const projectPath = () => `/api/v1/project-cost/projects/${api.projectId}`;

  async function get<T>(op: string, path: string, call: () => Promise<T>, summary: (r: T) => unknown): Promise<T> {
    const started = now();
    try {
      const result = await call();
      emit?.({ type: 'kairon.call', payload: { op, method: 'GET', path, status: 200, ms: now() - started, response: summary(result) } });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit?.({ type: 'kairon.call', payload: { op, method: 'GET', path, status: null, ms: now() - started, error: message } });
      throw err;
    }
  }

  return {
    get projectId() {
      return api.projectId;
    },
    get pinnedVersionId() {
      return api.pinnedVersionId;
    },
    getProject: () => get('getProject', projectPath(), () => api.getProject(), (r) => r),
    listVersions: () =>
      get('listVersions', `${projectPath()}/forecast-versions`, () => api.listVersions(), (r) =>
        r.map((v) => ({ id: v.id, name: v.name, role: v.role, isActive: v.isActive, lines: v.payload.lines.length })),
      ),
    getMilestones: (versionId) =>
      get('getMilestones', `${projectPath()}/forecast-versions/${versionId}/milestones`, () => api.getMilestones(versionId), (r) => r),
    async evaluate(versionId, body) {
      const started = now();
      const result = await api.evaluate(versionId, body);
      emit({
        type: 'kairon.call',
        payload: {
          op: 'evaluate',
          method: 'POST',
          path: `${projectPath()}/forecast-versions/${versionId}/evaluate`,
          status: result.status,
          ms: now() - started,
          requestBody: body,
          response: result.json,
        },
      });
      return result;
    },
    // The save route writes outside a run, so its two calls are passed through untraced.
    createVersion: (input) => api.createVersion(input),
    putFunding: (versionId, body) => api.putFunding(versionId, body),
  };
}

// ---------- recording size (DEV-1381) ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** UTF-8 bytes of a value as compact JSON. */
function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

function instanceSummary(instance: unknown): unknown {
  if (!isRecord(instance)) return instance;
  return { widget: instance.widget, version: instance.version, buildId: instance.buildId, bytes: bytesOf(instance) };
}

/** A copy of `value` with widget data replaced by byte counts and, unless kept, instances by their ids and byte counts. */
function slim(value: unknown, keepInstances: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => slim(item, keepInstances));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'widgetData' && isRecord(child)) {
      out.widgetDataBytes = Object.fromEntries(Object.entries(child).map(([id, data]) => [id, bytesOf(data)]));
    } else if (key === 'instances' && isRecord(child) && 'widgets' in value) {
      // The output of kairon.planWidgets: { widgets, instances }.
      out.instances = keepInstances
        ? child
        : Object.fromEntries(Object.entries(child).map(([draft, list]) => [draft, Array.isArray(list) ? list.map(instanceSummary) : list]));
    } else {
      out[key] = slim(child, keepInstances);
    }
  }
  return out;
}

/**
 * The payload of a trace event as /kairon/run writes it. A run's state repeats in its events: the
 * scoring's output is the argument of the two steps after it and sits in run.done again, so the
 * widget data of a draft (about 90 KB with 14 widgets) was written six times and its instances
 * twice. The trace keeps one copy of what the page draws: the instances, in the output of
 * run.done. Widget data becomes `widgetDataBytes` (bytes per widget) everywhere, and the widgets
 * step's own event lists each instance by widget, version, build id and bytes. Nothing reads
 * widget data back from a recording: a follow-up request carries drafts' lineages, the save
 * carries one lineage, and a replay draws from run.done. The payload itself is not changed; the
 * run's state keeps the data the widgets step reads.
 */
export function slimTraceEvent(type: string, payload: unknown): unknown {
  if (type === 'tool.start' || type === 'tool.end') return slim(payload, false);
  if (type !== 'run.done' || !isRecord(payload) || !isRecord(payload.solution)) return payload;
  const { output, ...rest } = payload.solution;
  return { ...payload, solution: { ...(slim(rest, false) as Record<string, unknown>), output: slim(output, true) } };
}
