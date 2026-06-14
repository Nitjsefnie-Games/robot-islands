import { describe, it, expect } from 'vitest';
import { loadConfig, assertTestDatabase, DEFAULT_ALLOWED_WS_ORIGINS } from './config.js';

describe('loadConfig', () => {
  it('parses a full env', () => {
    const c = loadConfig({ DATABASE_URL: 'postgresql:///robot_islands', PORT: '5180', COOKIE_SECURE: '1' });
    expect(c.databaseUrl).toBe('postgresql:///robot_islands');
    expect(c.port).toBe(5180);
    expect(c.cookieSecure).toBe(true);
    expect(c.allowedWsOrigins).toEqual(DEFAULT_ALLOWED_WS_ORIGINS);
  });

  it('applies defaults', () => {
    const c = loadConfig({ DATABASE_URL: 'postgresql:///robot_islands' });
    expect(c.port).toBe(5180);
    expect(c.cookieSecure).toBe(true);
    expect(c.allowedWsOrigins).toEqual(DEFAULT_ALLOWED_WS_ORIGINS);
  });

  it('parses ALLOWED_WS_ORIGINS from env', () => {
    const c = loadConfig({ DATABASE_URL: 'x', ALLOWED_WS_ORIGINS: 'https://a.eu, https://b.eu' });
    expect(c.allowedWsOrigins).toEqual(['https://a.eu', 'https://b.eu']);
  });

  it('throws when DATABASE_URL missing', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('cookieSecure=false when COOKIE_SECURE=0', () => {
    expect(loadConfig({ DATABASE_URL: 'x', COOKIE_SECURE: '0' }).cookieSecure).toBe(false);
  });
});

describe('assertTestDatabase', () => {
  it('passes for a _test db', () => {
    expect(() => assertTestDatabase('postgresql:///robot_islands_test')).not.toThrow();
  });
  it('throws for a non-_test db', () => {
    expect(() => assertTestDatabase('postgresql:///robot_islands')).toThrow(/_test/);
  });
});
