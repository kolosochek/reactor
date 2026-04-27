import { describe, it, expect } from 'vitest';

describe('package skeleton', () => {
  it('imports index without throwing', async () => {
    // SCENARIO: package can be imported as a module
    // INPUT: import the barrel
    // EXPECTED: import succeeds and module is an object
    const mod = await import('../index.js');
    expect(typeof mod).toBe('object');
  });
});
