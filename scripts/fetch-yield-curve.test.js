import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchFredSeries,
  refreshYieldCurve,
} from './fetch-yield-curve.mjs';

describe('FRED fetch command', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails before making a request when the API key is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshYieldCurve({ apiKey: '' })).rejects.toThrow('Missing FRED_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not retry an authentication failure or expose the API key', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal('fetch', fetchMock);

    const request = fetchFredSeries('DGS10', 'private-test-key');
    await expect(request).rejects.toThrow('failed after 1 attempt');
    await expect(request).rejects.not.toThrow('private-test-key');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
