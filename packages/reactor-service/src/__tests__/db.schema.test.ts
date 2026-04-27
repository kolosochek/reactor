import { describe, it, expect } from 'vitest';
import { experience, lessons, ideas, predictions, tools } from '../db/schema.js';

describe('Drizzle schema (aligned with reactor-core 0.2.0 SPI)', () => {
  it('experience table has SPI-aligned columns', () => {
    // SCENARIO: schema mirrors ExperienceRecord SPI; extensions live in metadata jsonb
    // INPUT: drizzle table object
    // EXPECTED: columns id, toolName, input, output, outcome, durationMs, createdAt, metadata
    const cols = Object.keys(experience).filter((k) => !k.startsWith('_'));
    expect(cols.sort()).toEqual(
      ['createdAt', 'durationMs', 'id', 'input', 'metadata', 'outcome', 'output', 'toolName'].sort(),
    );
  });

  it('lessons table has SPI-aligned columns', () => {
    // SCENARIO: schema mirrors Lesson SPI (topic/description, optional source)
    // INPUT: drizzle table object
    // EXPECTED: columns id, topic, description, source, createdAt, metadata
    const cols = Object.keys(lessons).filter((k) => !k.startsWith('_'));
    expect(cols.sort()).toEqual(
      ['createdAt', 'description', 'id', 'metadata', 'source', 'topic'].sort(),
    );
  });

  it('ideas table has SPI-aligned columns', () => {
    // SCENARIO: schema stores Idea triplet (schema/context/solution); id is service-generated serial
    // INPUT: drizzle table object
    // EXPECTED: columns id, schema, context, solution, createdAt, metadata
    const cols = Object.keys(ideas).filter((k) => !k.startsWith('_'));
    expect(cols.sort()).toEqual(
      ['context', 'createdAt', 'id', 'metadata', 'schema', 'solution'].sort(),
    );
  });

  it('predictions table has SPI-aligned columns', () => {
    // SCENARIO: schema mirrors Prediction SPI (toolName, expectedOutcome, confidence as 0..1 real)
    // INPUT: drizzle table object
    // EXPECTED: columns id, ideaId, toolName, expectedOutcome, confidence, rationale, createdAt, metadata
    const cols = Object.keys(predictions).filter((k) => !k.startsWith('_'));
    expect(cols.sort()).toEqual(
      ['confidence', 'createdAt', 'expectedOutcome', 'id', 'ideaId', 'metadata', 'rationale', 'toolName'].sort(),
    );
  });

  it('tools table has SPI-aligned columns', () => {
    // SCENARIO: schema PK is toolRef per SPI; ToolMetrics blob in metrics jsonb
    // INPUT: drizzle table object
    // EXPECTED: columns toolRef, classification, metrics, updatedAt
    const cols = Object.keys(tools).filter((k) => !k.startsWith('_'));
    expect(cols.sort()).toEqual(['classification', 'metrics', 'toolRef', 'updatedAt'].sort());
  });
});
