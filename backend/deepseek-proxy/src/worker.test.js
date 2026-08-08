import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './worker.js';

const env = {
  ALLOWED_ORIGIN: 'https://cliffordfok.github.io,http://localhost:5173',
  DEEPSEEK_MODEL: 'deepseek-v4-pro',
};

const makeRequest = ({ origin = 'https://cliffordfok.github.io', apiKey = '', body = {} } = {}) => new Request(
  'https://worker.example.com',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}),
      ...(apiKey ? { 'X-DeepSeek-API-Key': apiKey } : {}),
    },
    body: JSON.stringify(body),
  },
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DeepSeek BYOK worker', () => {
  it('rejects browser origins outside the allowlist', async () => {
    const response = await worker.fetch(makeRequest({ origin: 'https://attacker.example' }), env);
    expect(response.status).toBe(403);
  });

  it('requires a user-provided API key', async () => {
    const response = await worker.fetch(makeRequest({ body: { task: 'extractTradeData', rawText: 'trade' } }), env);
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
    }), env);
    expect(response.status).toBe(413);
  });

  it('rejects oversized trade text before calling DeepSeek', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await worker.fetch(makeRequest({
      apiKey: 'user-key',
      body: { task: 'extractTradeData', rawText: 'x'.repeat(20001) },
    }), env);
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('forwards only the user key for a valid extraction request', async () => {
    const upstream = vi.fn(async (_url, options) => {
      expect(options.headers.Authorization).toBe('Bearer user-key');
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"type":"t-note"}' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', upstream);

    const response = await worker.fetch(makeRequest({
      apiKey: 'user-key',
      body: { task: 'extractTradeData', rawText: 'Buy a Treasury note' },
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ trade: { type: 't-note' } });
    expect(upstream).toHaveBeenCalledOnce();
  });
});
