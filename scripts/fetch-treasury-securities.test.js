import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidCusip } from '../src/lib/securities.js';
import { refreshTreasurySecurities } from './fetch-treasury-securities.mjs';

const withCheckDigit = (base) => {
  for (let digit = 0; digit <= 9; digit += 1) if (isValidCusip(`${base}${digit}`)) return `${base}${digit}`;
  throw new Error('no check digit');
};

const makeRows = (count, offset) => Array.from({ length: count }, (_, index) => {
  const type = ['Bill', 'Note', 'Bond'][(index + offset) % 3];
  return {
    cusip: withCheckDigit(`9128${String(index + offset).padStart(4, '0')}`),
    security_type: type,
    security_term: '10-Year',
    issue_date: '2026-01-15',
    maturity_date: '2031-01-15',
    int_rate: type === 'Bill' ? 'null' : '4.25',
  };
});

describe('Treasury securities refresh', () => {
  let directory;
  afterEach(async () => {
    vi.unstubAllGlobals();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('follows pagination, filters to outstanding bills/notes/bonds and writes the feed', async () => {
    const fetchMock = vi.fn(async (url) => {
      const page = Number(new URL(url).searchParams.get('page[number]'));
      expect(new URL(url).searchParams.get('filter')).toBe('maturity_date:gt:2026-10-13,security_type:in:(Bill,Note,Bond)');
      return new Response(JSON.stringify({
        data: page === 1 ? makeRows(80, 0) : makeRows(80, 80),
        meta: { 'total-pages': 2 },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    directory = await mkdtemp(join(tmpdir(), 'securities-'));
    const outputPath = join(directory, 'treasury-securities.json');

    const feed = await refreshTreasurySecurities({ outputPath, today: '2026-10-13' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(feed.securities).toHaveLength(160);
    expect(JSON.parse(await readFile(outputPath, 'utf8')).securities).toHaveLength(160);
  });

  it('fails instead of publishing a near-empty feed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: makeRows(3, 0), meta: { 'total-pages': 1 } }))));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    directory = await mkdtemp(join(tmpdir(), 'securities-'));
    await expect(refreshTreasurySecurities({ outputPath: join(directory, 'out.json'), today: '2026-10-13' }))
      .rejects.toThrow('不足');
  });
});
