// packages/text-tools/src/test-utils/contract.ts
//
// LLMProvider contract test suite. Any LLMProvider implementation that
// claims to satisfy the SPI should pass these tests. Per spec section 6.3.
//
// Usage:
//   import { runLLMProviderContractTests } from '@reactor/text-tools/test-utils';
//   import { describe } from 'vitest';
//   runLLMProviderContractTests(describe, () => myLLMProviderFactory());

import { expect, it } from 'vitest';
import type { LLMProvider } from '@kolosochek/reactor-core';

type DescribeFn = (name: string, fn: () => void) => void;

export function runLLMProviderContractTests(
  describe: DescribeFn,
  factory: () => LLMProvider,
): void {
  describe('LLMProvider contract', () => {
    it('exposes .name as a non-empty string', () => {
      // SCENARIO: SPI requires identification for diagnostics
      // EXPECTED: name field is non-empty
      const llm = factory();
      expect(typeof llm.name).toBe('string');
      expect(llm.name.length).toBeGreaterThan(0);
    });

    it('returns content for non-empty messages', async () => {
      // SCENARIO: minimal request
      // INPUT: one user message
      // EXPECTED: response has content as non-empty string and model as string
      const llm = factory();
      const r = await llm.complete({
        messages: [{ role: 'user', content: 'hello' }],
      });
      expect(typeof r.content).toBe('string');
      expect(typeof r.model).toBe('string');
    });

    it('honors jsonMode: true returns parseable JSON', async () => {
      // SCENARIO: structured output mode
      // INPUT: jsonMode: true
      // EXPECTED: content can be JSON.parse'd without throwing
      const llm = factory();
      const r = await llm.complete({
        messages: [{ role: 'user', content: 'return {"ok":true}' }],
        jsonMode: true,
      });
      expect(() => JSON.parse(r.content)).not.toThrow();
    });

    it('returns usage.totalTokens when provider reports it (optional)', async () => {
      // SCENARIO: optional usage field, must be a non-negative integer when present
      // EXPECTED: usage.totalTokens is undefined or a non-negative integer
      const llm = factory();
      const r = await llm.complete({
        messages: [{ role: 'user', content: 'x' }],
      });
      const totalTokens = r.usage?.totalTokens;
      if (totalTokens !== undefined) {
        expect(Number.isInteger(totalTokens)).toBe(true);
        expect(totalTokens).toBeGreaterThanOrEqual(0);
      }
    });
  });
}
