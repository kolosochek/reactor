// packages/reactor-service/src/kairon/client.ts
//
// Minimal Kairon API client for the forecast prototype (DEV-1364). Credentials
// come from the service's git-ignored .env and never leave this module: the
// token is not returned to activities, so reactor's experience log (which
// stores every call's args and output) never sees it. The token is cached for
// 14 minutes (the access JWT lives 15) because every login writes an audit row
// and a session in Kairon.

import { z } from 'zod';
import type { ForecastPlan } from './patch.js';

const KaironEnvSchema = z.object({
  KAIRON_BASE_URL: z.string().url(),
  KAIRON_EMAIL: z.string().min(1),
  KAIRON_PASSWORD: z.string().min(1),
  KAIRON_PROJECT_ID: z.string().min(1),
  KAIRON_VERSION_ID: z.string().min(1).optional(),
});

export interface KaironEnv {
  baseUrl: string;
  email: string;
  password: string;
  projectId: string;
  versionId?: string;
}

export function readKaironEnv(env: Record<string, string | undefined>): KaironEnv {
  const e = KaironEnvSchema.parse(env);
  return {
    baseUrl: e.KAIRON_BASE_URL,
    email: e.KAIRON_EMAIL,
    password: e.KAIRON_PASSWORD,
    projectId: e.KAIRON_PROJECT_ID,
    versionId: e.KAIRON_VERSION_ID,
  };
}

export class KaironHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    detail: string,
  ) {
    super(`Kairon ${status} on ${path}: ${detail}`);
    this.name = 'KaironHttpError';
  }
}

const ProjectShape = z.object({
  id: z.string(),
  name: z.string(),
  currentApprovedVersionId: z.string().nullable(),
  currency: z.object({ code: z.string(), decimals: z.number().int() }),
  settings: z
    .object({
      funding: z
        .object({
          partners: z.array(z.object({ id: z.string(), name: z.string(), sharePct: z.number() })).optional(),
        })
        .optional(),
    })
    .optional(),
});

const VersionShape = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  isActive: z.boolean(),
  payload: z.object({
    lines: z.array(
      z
        .object({ code: z.string(), name: z.string(), monthlyForecast: z.record(z.string()) })
        .passthrough(),
    ),
    monthRange: z.object({ from: z.string(), to: z.string() }),
  }).passthrough(),
});

const MilestonesShape = z.object({
  entries: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      dueDate: z.string().nullable(),
      completedAt: z.string().nullable().optional(),
    }),
  ),
});

export type KaironProject = z.infer<typeof ProjectShape>;
export type KaironVersion = z.infer<typeof VersionShape>;
export type KaironMilestone = z.infer<typeof MilestonesShape>['entries'][number];

export interface HttpResult {
  status: number;
  json: unknown;
}

export interface KaironApi {
  projectId: string;
  pinnedVersionId: string | undefined;
  getProject(): Promise<KaironProject>;
  listVersions(): Promise<KaironVersion[]>;
  getMilestones(versionId: string): Promise<KaironMilestone[]>;
  evaluate(versionId: string, body: unknown): Promise<HttpResult>;
}

const TOKEN_TTL_MS = 14 * 60 * 1000;

export function createKaironClient(env: KaironEnv, fetchImpl: typeof fetch = fetch): KaironApi {
  let cached: { token: string; expiresAt: number } | null = null;

  async function login(): Promise<string> {
    const resp = await fetchImpl(`${env.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: env.email, password: env.password }),
    });
    if (!resp.ok) throw new KaironHttpError(resp.status, '/api/v1/auth/login', 'login refused');
    const json = z.object({ accessToken: z.string() }).parse(await resp.json());
    cached = { token: json.accessToken, expiresAt: Date.now() + TOKEN_TTL_MS };
    return json.accessToken;
  }

  async function token(): Promise<string> {
    if (cached !== null && cached.expiresAt > Date.now()) return cached.token;
    return login();
  }

  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<HttpResult> {
    const send = async (bearer: string) =>
      fetchImpl(`${env.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    let resp = await send(await token());
    if (resp.status === 401) {
      cached = null;
      resp = await send(await login());
    }
    const text = await resp.text();
    return { status: resp.status, json: text.length > 0 ? JSON.parse(text) : null };
  }

  async function getOk(path: string): Promise<unknown> {
    const r = await call('GET', path);
    if (r.status !== 200) throw new KaironHttpError(r.status, path, JSON.stringify(r.json).slice(0, 300));
    return r.json;
  }

  const projectPath = `/api/v1/project-cost/projects/${env.projectId}`;

  return {
    projectId: env.projectId,
    pinnedVersionId: env.versionId,
    async getProject() {
      return ProjectShape.parse(await getOk(projectPath));
    },
    async listVersions() {
      return z.array(VersionShape).parse(await getOk(`${projectPath}/forecast-versions`));
    },
    async getMilestones(versionId) {
      return MilestonesShape.parse(await getOk(`${projectPath}/forecast-versions/${versionId}/milestones`)).entries;
    },
    async evaluate(versionId, body) {
      return call('POST', `${projectPath}/forecast-versions/${versionId}/evaluate`, body);
    },
  };
}

/** The version's plan as an evaluate body expects it: server-owned keys dropped. */
export function planOf(version: KaironVersion): ForecastPlan {
  return {
    lines: version.payload.lines.map(({ forecastTotalMinor: _serverOwned, ...line }) => line),
    monthRange: { from: version.payload.monthRange.from, to: version.payload.monthRange.to },
  };
}

let shared: KaironApi | null = null;

/** One client per process so the token cache survives across requests. */
export function sharedKaironClient(): KaironApi {
  if (shared === null) shared = createKaironClient(readKaironEnv(process.env));
  return shared;
}
