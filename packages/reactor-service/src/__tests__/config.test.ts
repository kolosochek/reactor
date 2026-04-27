import { describe, it, expect } from 'vitest';
import { loadConfig } from '../config.js';

describe('loadConfig', () => {
  it('returns parsed config from a valid env shape', () => {
    // SCENARIO: all required env present
    // INPUT: full env record
    // EXPECTED: typed config returned
    const cfg = loadConfig({
      REACTOR_HTTP_HOST: '127.0.0.1',
      REACTOR_HTTP_PORT: '3030',
      REACTOR_LOG_LEVEL: 'info',
      REACTOR_DATABASE_URL: 'postgres://reactor:reactor@localhost:5433/reactor',
    });
    expect(cfg.httpHost).toBe('127.0.0.1');
    expect(cfg.httpPort).toBe(3030);
    expect(cfg.logLevel).toBe('info');
    expect(cfg.databaseUrl).toBe('postgres://reactor:reactor@localhost:5433/reactor');
  });

  it('throws when REACTOR_DATABASE_URL is missing', () => {
    // SCENARIO: required field absent
    // EXPECTED: throws with field name in message
    expect(() =>
      loadConfig({
        REACTOR_HTTP_HOST: '127.0.0.1',
        REACTOR_HTTP_PORT: '3030',
      }),
    ).toThrow(/REACTOR_DATABASE_URL/);
  });

  it('throws when REACTOR_HTTP_PORT is not a number', () => {
    expect(() =>
      loadConfig({
        REACTOR_HTTP_HOST: '127.0.0.1',
        REACTOR_HTTP_PORT: 'abc',
        REACTOR_DATABASE_URL: 'postgres://x',
      }),
    ).toThrow();
  });

  it('rejects log level outside enum', () => {
    expect(() =>
      loadConfig({
        REACTOR_HTTP_HOST: '127.0.0.1',
        REACTOR_HTTP_PORT: '3030',
        REACTOR_LOG_LEVEL: 'verbose',
        REACTOR_DATABASE_URL: 'postgres://x',
      }),
    ).toThrow();
  });

  it('defaults host, port, log level when omitted', () => {
    // SCENARIO: minimal env (only DATABASE_URL required)
    // EXPECTED: defaults applied
    const cfg = loadConfig({
      REACTOR_DATABASE_URL: 'postgres://x',
    });
    expect(cfg.httpHost).toBe('127.0.0.1');
    expect(cfg.httpPort).toBe(3030);
    expect(cfg.logLevel).toBe('info');
  });
});
