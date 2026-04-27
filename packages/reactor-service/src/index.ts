// packages/reactor-service/src/index.ts
//
// Public exports for @reactor/service. Used by E2E tests and any embedding
// that wants to construct the server programmatically.

export { buildServer } from './server.js';
export type { BuildServerOptions } from './server.js';
export { loadConfig } from './config.js';
export type { ReactorConfig } from './config.js';
export { createDbClient } from './db/client.js';
export type { ReactorDb } from './db/client.js';
export { createRepositoriesProvider } from './db/repositories/index.js';
export { buildLLMProvider, ProviderNotImplementedError } from './reactor/llmFromConfig.js';
export type { ProviderConfig } from './reactor/llmFromConfig.js';
export { buildReactor } from './reactor/buildReactor.js';
