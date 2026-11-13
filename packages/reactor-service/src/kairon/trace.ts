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
