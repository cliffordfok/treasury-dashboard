import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './worker.js';

const makeEnv = (overrides = {}) => ({
  ALLOWED_ORIGIN: 'https://cliffordfok.github.io,http://localhost:5173',
  DEEPSEEK_MODEL: 'deepseek-v4-pro',
  AI_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
  ...overrides,
});

const makeRequest = ({ method = 'POST', origin = 'https://cliffordfok.github.io', apiKey = '', body = {} } = {}) => new Request(
  'https://worker.example.com',
  {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}),
      ...(apiKey ? { 'X-DeepSeek-API-Key': apiKey } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  },
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DeepSeek BYOK worker', () => {
  it('rejects browser origins outside the allowlist', async () => {
    const response = await worker.fetch(makeRequest({ origin: 'https://attacker.example' }), makeEnv());
    expect(response.status).toBe(403);
  });

  it('rejects requests without an Origin header', async () => {
    const response = await worker.fetch(makeRequest({ origin: '' }), makeEnv());
    expect(response.status).toBe(403);
  });

  it('does not charge CORS preflight requests against the rate limit', async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const response = await worker.fetch(
      makeRequest({ method: 'OPTIONS' }),
      makeEnv({ AI_RATE_LIMITER: { limit } }),
    );
    expect(response.status).toBe(204);
    expect(limit).not.toHaveBeenCalled();
  });

  it('fails closed when the rate limiter binding is unavailable', async () => {
    const response = await worker.fetch(
      makeRequest({ apiKey: 'user-key', body: { task: 'extractTradeData', rawText: 'trade' } }),
      makeEnv({ AI_RATE_LIMITER: undefined }),
    );
    expect(response.status).toBe(503);
  });

  it('returns a stable retry window when a client exceeds the rate limit', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await worker.fetch(
      makeRequest({ apiKey: 'user-key', body: { task: 'extractTradeData', rawText: 'trade' } }),
      makeEnv({ AI_RATE_LIMITER: { limit: vi.fn(async () => ({ success: false })) } }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    await expect(response.json()).resolves.toEqual({ error: 'Too many requests' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('requires a user-provided API key', async () => {
    const response = await worker.fetch(makeRequest({ body: { task: 'extractTradeData', rawText: 'trade' } }), makeEnv());
    expect(response.status).toBe(401);
  });

  it('rejects an oversized request body even without Content-Length', async () => {
    const response = await worker.fetch(new Request('https://worker.example.com', {
      method: 'POST',
      headers: {
        Origin: 'https://cliffordfok.github.io',
        'X-DeepSeek-API-Key': 'user-key',
      },
      body: JSON.stringify({ task: 'extractTradeData', padding: 'x'.repeat(50001) }),
    }), makeEnv());
    expect(response.status).toBe(413);
  });

  it('rejects oversized trade text before calling DeepSeek', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await worker.fetch(makeRequest({
      apiKey: 'user-key',
      body: { task: 'extractTradeData', rawText: 'x'.repeat(20001) },
    }), makeEnv());
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('forwards only the user key for a valid extraction request', async () => {
    const upstream = vi.fn(async (_url, options) => {
      expect(options.headers.Authorization).toBe('Bearer user-key');
      const payload = JSON.parse(options.body);
      expect(payload.messages[1].content).toContain('stores the settlement date used for calculations');
      expect(payload.messages[1].content).toContain('do not infer T+1');
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"type":"t-note"}' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', upstream);

    const response = await worker.fetch(makeRequest({
      apiKey: 'user-key',
      body: { task: 'extractTradeData', rawText: 'Buy a Treasury note' },
    }), makeEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ trade: { type: 't-note' } });
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('aborts a stalled DeepSeek request with a gateway timeout', async () => {
    const upstream = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }));
    vi.stubGlobal('fetch', upstream);

    const response = await worker.fetch(makeRequest({
      apiKey: 'user-key',
      body: { task: 'extractTradeData', rawText: 'Buy a Treasury note' },
    }), makeEnv({ DEEPSEEK_TIMEOUT_MS: '1000' }));

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({ error: 'DeepSeek request timed out' });
  });

  it('maps an upstream server failure to a bad gateway response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'upstream unavailable' },
    }), { status: 503, headers: { 'Content-Type': 'application/json' } })));

    const response = await worker.fetch(makeRequest({
      apiKey: 'user-key',
      body: { task: 'extractTradeData', rawText: 'Buy a Treasury note' },
    }), makeEnv());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: 'upstream unavailable' });
  });

  it('maps an upstream network failure to a bad gateway response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket failure'); }));

    const response = await worker.fetch(makeRequest({
      apiKey: 'user-key',
      body: { task: 'extractTradeData', rawText: 'Buy a Treasury note' },
    }), makeEnv());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: 'Unable to reach DeepSeek' });
  });
});
