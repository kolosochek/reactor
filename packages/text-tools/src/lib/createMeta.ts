// packages/text-tools/src/lib/createMeta.ts
//
// Inlined from @kolosochek/reactor-core to remove a runtime dependency.
// Keeps reactor-core as a type-only devDependency, which lets this package
// publish to npm without requiring reactor-core on the registry.
// If reactor-core's createMeta evolves, sync manually.

import type { IdeaMeta } from '@kolosochek/reactor-core';

export function createMeta(
  domain: string,
  path: string,
  options?: {
    version?: string;
    branches?: string[];
    parentRef?: string;
  },
): IdeaMeta {
  return {
    domain,
    path,
    version: options?.version ?? '1.0',
    branches: options?.branches ?? ['main'],
    createdAt: new Date().toISOString(),
    parentRef: options?.parentRef,
  };
}
