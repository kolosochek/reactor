// packages/text-tools/src/activity/compose.ts
//
// composeActivity is the crystallization seam: today every text-tools
// Activity uses only `llmFallback`. As patterns emerge, deterministic
// `preCheck` short-circuits and `postValidate` wrappers can be added without
// rewriting the Activity itself.

import type { ActivityContext } from '@kolosochek/reactor-core';

export type CrystallizableActivity<I, O> = (input: I, ctx: ActivityContext) => Promise<O>;

export interface ActivityLayers<I, O> {
  /** Returns a deterministic Solution when the case is crystallized; null to fall through to LLM. */
  preCheck?: (input: I) => O | null;
  /** Required: the LLM-based fallback. Receives full ctx (state, llm, signal, onProgress). */
  llmFallback: CrystallizableActivity<I, O>;
  /** Optional: post-process LLM output (validation, structural checks, augmentation). */
  postValidate?: (input: I, output: O) => O;
}

export function composeActivity<I, O>(layers: ActivityLayers<I, O>): CrystallizableActivity<I, O> {
  return async (input, ctx) => {
    if (layers.preCheck !== undefined) {
      const explicit = layers.preCheck(input);
      if (explicit !== null) return explicit;
    }
    const latent = await layers.llmFallback(input, ctx);
    return layers.postValidate !== undefined ? layers.postValidate(input, latent) : latent;
  };
}
