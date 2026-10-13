import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeAuctionRows, validateSecuritiesFeed } from '../src/lib/securities.js';

const ENDPOINT = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query';
const PAGE_SIZE = 10_000;
const MAX_PAGES = 10;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;

const wait = (milliseconds) => new Promise((resolveWait) => { setTimeout(resolveWait, milliseconds); });

const fetchPage = async (pageNumber, today) => {
  const url = new URL(ENDPOINT);
  url.searchParams.set('filter', `maturity_date:gt:${today},security_type:in:(Bill,Note,Bond)`);
  url.searchParams.set('page[size]', String(PAGE_SIZE));
  url.searchParams.set('page[number]', String(pageNumber));

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      const payload = await response.json();
      if (!Array.isArray(payload?.data)) throw new Error('response has no data array');
      return payload;
    } catch (error) {
      lastError = error;
      if (error.retryable === false || attempt === MAX_ATTEMPTS) break;
      console.warn(`Fiscal Data page ${pageNumber} attempt ${attempt}/${MAX_ATTEMPTS} failed; retrying`);
      await wait(2 ** (attempt - 1) * 2_000);
    }
  }
  throw new Error(`Fiscal Data page ${pageNumber} failed: ${lastError?.message}`, { cause: lastError });
};

export const refreshTreasurySecurities = async ({
  outputPath = resolve('public/treasury-securities.json'),
  today = new Date().toISOString().slice(0, 10),
} = {}) => {
  const rows = [];
  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
    const payload = await fetchPage(pageNumber, today);
    rows.push(...payload.data);
    const totalPages = Number(payload.meta?.['total-pages']) || 1;
    if (pageNumber >= totalPages) break;
  }

  const sampleNote = rows.find((row) => row.security_type === 'Note') ?? {};
  console.log(`Fiscal Data returned ${rows.length} auction rows; note fields: ${Object.keys(sampleNote).join(', ')}`);

  const feed = validateSecuritiesFeed({
    generatedAt: today,
    source: 'U.S. Treasury Fiscal Data — Treasury Securities Auctions Data',
    securities: normalizeAuctionRows(rows),
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(feed)}\n`, 'utf8');
  return feed;
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const outputIndex = process.argv.indexOf('--output');
  const outputPath = outputIndex > 0 ? resolve(process.argv[outputIndex + 1]) : undefined;
  refreshTreasurySecurities({ outputPath })
    .then((feed) => {
      const counts = Object.groupBy(feed.securities, (security) => security.type);
      console.log(`Prepared ${feed.securities.length} outstanding securities (${Object.entries(counts).map(([type, list]) => `${type}: ${list.length}`).join(', ')})`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
