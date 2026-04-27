import { describe, it, expect } from 'vitest';

describe('package skeleton', () => {
  it('imports index without throwing', async () => {
    // SCENARIO: package can be imported as a module
    // INPUT: dynamic import of ../index.js
    // EXPECTED: import resolves to an object value (typeof === 'object')
    const mod = await import('../index.js');
    expect(typeof mod).toBe('object');
  });
});
