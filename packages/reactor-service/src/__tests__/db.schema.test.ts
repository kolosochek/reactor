import { describe, it, expect } from 'vitest';
import { experience, lessons, ideas, predictions, tools } from '../db/schema.js';

describe('Drizzle schema', () => {
  it('experience table has expected columns', () => {
    // SCENARIO: schema export shape stable
    // EXPECTED: column names match SPI
    const cols = Object.keys(experience).filter((k) => !k.startsWith('_'));
    expect(cols.sort()).toContain('id');
    expect(cols.sort()).toContain('toolName');
    expect(cols.sort()).toContain('domain');
    expect(cols.sort()).toContain('input');
    expect(cols.sort()).toContain('output');
    expect(cols.sort()).toContain('outcome');
    expect(cols.sort()).toContain('errorMessage');
    expect(cols.sort()).toContain('errorClass');
    expect(cols.sort()).toContain('durationMs');
    expect(cols.sort()).toContain('ideaMeta');
    expect(cols.sort()).toContain('createdAt');
  });

  it('lessons table has expected columns', () => {
    const cols = Object.keys(lessons).filter((k) => !k.startsWith('_'));
    expect(cols.sort()).toEqual(
      ['content', 'createdAt', 'domain', 'evidence', 'id', 'title', 'type'].sort(),
    );
  });

  it('ideas table has expected columns', () => {
    const cols = Object.keys(ideas).filter((k) => !k.startsWith('_'));
    expect(cols.sort()).toEqual(
      ['context', 'createdAt', 'domain', 'id', 'parentRef', 'path', 'schema', 'solution', 'version'].sort(),
    );
  });

  it('predictions table has expected columns', () => {
    const cols = Object.keys(predictions).filter((k) => !k.startsWith('_'));
    expect(cols.sort()).toEqual(['activity', 'actual', 'confidence', 'createdAt', 'expected', 'id'].sort());
  });

  it('tools table has expected columns', () => {
    const cols = Object.keys(tools).filter((k) => !k.startsWith('_'));
    expect(cols.sort()).toEqual(['classification', 'metrics', 'name', 'updatedAt'].sort());
  });
});
