// packages/reactor-service/src/config.ts
//
// Pure env loader + Zod validation. Decoupled from process.env so it's
// testable. The boot script (start.ts) is responsible for reading process.env
// and passing it here.

import { z } from 'zod';

const ConfigSchema = z.object({
  REACTOR_HTTP_HOST: z.string().default('127.0.0.1'),
  REACTOR_HTTP_PORT: z.coerce.number().int().positive().default(3030),
  REACTOR_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  REACTOR_DATABASE_URL: z.string().min(1),
});

export interface ReactorConfig {
  httpHost: string;
  httpPort: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  databaseUrl: string;
}

export function loadConfig(env: Record<string, string | undefined>): ReactorConfig {
  const parsed = ConfigSchema.parse(env);
  return {
    httpHost: parsed.REACTOR_HTTP_HOST,
    httpPort: parsed.REACTOR_HTTP_PORT,
    logLevel: parsed.REACTOR_LOG_LEVEL,
    databaseUrl: parsed.REACTOR_DATABASE_URL,
  };
}
