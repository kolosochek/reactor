import { afterEach, describe, it, expect } from 'vitest';
import { buildServer } from '../server.js';
import { DEMO_PHRASES } from '../kairon/sampleLlm.js';
import type { RepositoriesProvider } from '@kolosochek/reactor-core';
import { writeStubWidgetsDist } from './_helpers/widgetsStub.js';

const stubRepos: RepositoriesProvider = {
  experience: { append: async () => {}, list: async () => [] },
  lessons: { list: async () => [], upsert: async () => {}, remove: async () => {} },
  ideas: { save: async () => 'stub', load: async () => null, list: async () => [] },
  predictions: { save: async () => {}, list: async () => [] },
  tools: { list: async () => [], get: async () => null, upsert: async () => {} },
};

describe('GET /kairon', () => {
  it('serves the forecast prototype chat page from the service origin', async () => {
    // SCENARIO: DEV-1364 page is served next to /reactor/execute, so the page posts same-origin
    // INPUT: GET /kairon
    // EXPECTED: status 200, text/html, the page title "Kairon forecast agent"
    const app = await buildServer({ repositories: stubRepos, logLevel: 'warn' });

    const res = await app.inject({ method: 'GET', url: '/kairon' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('<title>Kairon forecast agent</title>');

    await app.close();
  });

  it('serves the demo phrases the sample model answers', async () => {
    // SCENARIO: the page offers the demo phrases as chips and checks a typed phrase before a sample run (Task 16 ruling)
    // INPUT: GET /kairon/demo-phrases
    // EXPECTED: status 200, { phrases: DEMO_PHRASES }
    const app = await buildServer({ repositories: stubRepos, logLevel: 'warn' });

    const res = await app.inject({ method: 'GET', url: '/kairon/demo-phrases' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ phrases: [...DEMO_PHRASES] });

    await app.close();
  });

  it('serves the card renderer module next to the page', async () => {
    // SCENARIO: DEV-1376, the page imports its renderers as an ES module from the service origin
    // INPUT: GET /kairon/assets/kairon-render.mjs
    // EXPECTED: status 200, text/javascript, the module exports renderVerdict
    const app = await buildServer({ repositories: stubRepos, logLevel: 'warn' });

    const res = await app.inject({ method: 'GET', url: '/kairon/assets/kairon-render.mjs' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(res.body).toContain('export function renderVerdict(');

    await app.close();
  });
});

describe('GET /kairon/assets/widgets/browser.mjs (DEV-1380)', () => {
  const before = process.env.KAIRON_WIDGETS_DIST;
  afterEach(() => {
    if (before === undefined) delete process.env.KAIRON_WIDGETS_DIST;
    else process.env.KAIRON_WIDGETS_DIST = before;
  });

  it('serves the widgets bundle from the directory KAIRON_WIDGETS_DIST names', async () => {
    // SCENARIO: the page imports the forecast widgets bundle from the service origin
    // INPUT: KAIRON_WIDGETS_DIST = a directory with browser.mjs; GET /kairon/assets/widgets/browser.mjs
    // EXPECTED: status 200, text/javascript, no-store, the file's content
    const dist = writeStubWidgetsDist();
    process.env.KAIRON_WIDGETS_DIST = dist.dir;
    const app = await buildServer({ repositories: stubRepos, logLevel: 'warn' });

    const res = await app.inject({ method: 'GET', url: '/kairon/assets/widgets/browser.mjs' });
    expect([res.statusCode, res.headers['content-type'], res.headers['cache-control'], res.body]).toEqual([
      200,
      'text/javascript; charset=utf-8',
      'no-store',
      'export const buildId = "stub-build-1";\nexport function mount() { return () => {}; }\n',
    ]);

    await app.close();
    dist.remove();
  });

  it('answers 404 without the variable, so the page keeps its own renderers', async () => {
    // SCENARIO: the service runs with no widgets build, as before DEV-1380
    // INPUT: no KAIRON_WIDGETS_DIST; GET /kairon/assets/widgets/browser.mjs
    // EXPECTED: status 404 and a message naming the variable
    delete process.env.KAIRON_WIDGETS_DIST;
    const app = await buildServer({ repositories: stubRepos, logLevel: 'warn' });

    const res = await app.inject({ method: 'GET', url: '/kairon/assets/widgets/browser.mjs' });
    expect([res.statusCode, res.json()]).toEqual([404, { error: 'No widgets bundle: KAIRON_WIDGETS_DIST is not set' }]);

    await app.close();
  });

  it('answers 404 when the directory holds no browser.mjs', async () => {
    // SCENARIO: the variable points at a directory with the core build only
    // INPUT: KAIRON_WIDGETS_DIST = a directory without browser.mjs
    // EXPECTED: status 404 and a message naming the file
    const dist = writeStubWidgetsDist({ omit: 'browser.mjs' });
    process.env.KAIRON_WIDGETS_DIST = dist.dir;
    const app = await buildServer({ repositories: stubRepos, logLevel: 'warn' });

    const res = await app.inject({ method: 'GET', url: '/kairon/assets/widgets/browser.mjs' });
    expect([res.statusCode, res.json()]).toEqual([404, { error: 'No widgets bundle: KAIRON_WIDGETS_DIST has no browser.mjs' }]);

    await app.close();
    dist.remove();
  });
});

describe('GET /kairon/widgets (DEV-1380)', () => {
  const before = process.env.KAIRON_WIDGETS_DIST;
  afterEach(() => {
    if (before === undefined) delete process.env.KAIRON_WIDGETS_DIST;
    else process.env.KAIRON_WIDGETS_DIST = before;
  });

  async function widgetsInfo(): Promise<unknown> {
    const app = await buildServer({ repositories: stubRepos, logLevel: 'warn' });
    const res = await app.inject({ method: 'GET', url: '/kairon/widgets' });
    await app.close();
    return [res.statusCode, res.json()];
  }

  it('names the bundle and its build when one is configured', async () => {
    // SCENARIO: the page asks whether a widgets bundle exists before it imports one, so a missing bundle costs no 404
    // INPUT: KAIRON_WIDGETS_DIST = the stub directory
    // EXPECTED: 200 with the bundle path and the manifest's build id
    const dist = writeStubWidgetsDist();
    process.env.KAIRON_WIDGETS_DIST = dist.dir;
    expect(await widgetsInfo()).toEqual([200, { bundle: '/kairon/assets/widgets/browser.mjs', buildId: 'stub-build-1' }]);
    dist.remove();
  });

  it('names no bundle without the variable', async () => {
    // SCENARIO: the service runs with no widgets build
    // INPUT: no KAIRON_WIDGETS_DIST
    // EXPECTED: 200 with bundle null and buildId null
    delete process.env.KAIRON_WIDGETS_DIST;
    expect(await widgetsInfo()).toEqual([200, { bundle: null, buildId: null }]);
  });

  it('names no bundle when the directory holds no browser.mjs', async () => {
    // SCENARIO: a build without the browser entry cannot draw on the page
    // INPUT: KAIRON_WIDGETS_DIST = a directory without browser.mjs
    // EXPECTED: 200 with bundle null and buildId null
    const dist = writeStubWidgetsDist({ omit: 'browser.mjs' });
    process.env.KAIRON_WIDGETS_DIST = dist.dir;
    expect(await widgetsInfo()).toEqual([200, { bundle: null, buildId: null }]);
    dist.remove();
  });

  it('names no bundle when the build does not load as a catalog', async () => {
    // SCENARIO: a run on a broken build goes on with no catalog, so the page must not mount a bundle for it
    //           (review I4, minor 7: a manifest cut short used to answer 500)
    // INPUT: KAIRON_WIDGETS_DIST = (a) a manifest.json cut mid-object; (b) a manifest.json holding null;
    //        (c) no core.mjs; (d) a manifest of another build than the core
    // EXPECTED: 200 with bundle null and buildId null for all four
    const faults = [{ manifestText: '{"buildId": "stub-bu' }, { manifestText: 'null' }, { omit: 'core.mjs' as const }, { manifestBuildId: 'other-build' }];
    const answers: unknown[] = [];
    for (const fault of faults) {
      const dist = writeStubWidgetsDist(fault);
      process.env.KAIRON_WIDGETS_DIST = dist.dir;
      answers.push(await widgetsInfo());
      dist.remove();
    }
    const none = [200, { bundle: null, buildId: null }];
    expect(answers).toEqual([none, none, none, none]);
  });
});
