// Prompt rules added after the live run of 13.11 (DEV-1364): running costs move
// with a delay, revenue is never extended, v1 is the scenario alone, and the
// goal is the IRR closest to the promise without falling below it.

import { describe, expect, it } from 'vitest';
import { readBaseline } from '../kairon/baseline.js';
import { explainSystemPrompt, explainUserPrompt, proposeSystemPrompt } from '../kairon/prompts.js';
import { baselineEvaluate, fakeKaironApi } from './_helpers/kaironFake.js';

describe('kairon proposeSystemPrompt', () => {
  it('lists the running costs of the baseline and the rules learned from the live run', async () => {
    // SCENARIO: the system prompt for Rivergate, 3 variants
    // INPUT: the baseline read through the fake API
    // EXPECTED: the overhead rule names O3, O5; the hint names D5, D8, F1, each with amount and last month; the interest rule names F2, F3;
    //           the revenue rule, the v1 rule and the goal sentence are present word for word
    const b = await readBaseline(fakeKaironApi(baselineEvaluate));
    const prompt = proposeSystemPrompt(b, 3);
    expect(prompt).toContain(
      '- Running overheads (group O, the same amount every month, minor units): O3 -4953630 through 2028-03, O5 -84174990 through 2028-03. When the plan ends later, each of them must end later too: extend it or shift it. The server refuses a delay that leaves one ending where it did.',
    );
    expect(prompt).toContain(
      '- Other steady costs: D5 -2832327959 through 2028-07, D8 -28747000 through 2028-07, F1 -352920 through 2028-07. Move them only when the scenario delays that work: stretch construction that takes longer, extend fees that run longer.',
    );
    expect(prompt).toContain(
      '- Typed interest lines F2, F3 run until the loans are repaid at the exit. When the plan ends later, extend them. The server refuses a delay that leaves one ending where it did.',
    );
    expect(prompt).toContain('- Never extend a revenue line: extend repeats the last sale and invents income. Move revenue with shift.');
    expect(prompt).toContain(
      '- v1 is the scenario alone: only the mechanical change, levers [] and shareTarget null. It shows what the scenario costs before any lever.',
    );
    expect(prompt).toContain(
      "- The goal: every partner's IRR at or above the approved budget (the promise made to investors) and as close to it as possible. Below the promise is the problem. Far above it is no better: the lever then asks buyers or partners for more than the scenario costs.",
    );
  });
});

describe('kairon explain prompts', () => {
  it('tells the model to recommend the top-ranked variant or give a reason', () => {
    // SCENARIO: the server ranks v3 first; the model must follow or explain
    // INPUT: ranking v3 > v2 > v1, top-ranked v3
    // EXPECTED: the system prompt carries the recommendation rule; the user prompt names v3 as top-ranked
    expect(explainSystemPrompt()).toContain(
      'Recommend the top-ranked variant. If you recommend another one, write the reason in departureReason; otherwise departureReason is null.',
    );
    const user = explainUserPrompt({ scenario: 's', facts: {}, variants: [], ranking: ['v3', 'v2', 'v1'], topRanked: 'v3' });
    expect(user).toContain('TOP-RANKED VARIANT: v3');
  });
});
