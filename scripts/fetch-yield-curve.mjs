import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCommonYieldCurve,
  FRED_CURVE_SERIES,
} from '../src/lib/yieldCurve.js';

const FRED_ENDPOINT = 'https://api.stlouisfed.org/fred/series/observations';
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

const wait = (milliseconds) => new Promise((resolveWait) => {
  setTimeout(resolveWait, milliseconds);
});

export const fetchFredSeries = async (seriesId, apiKey) => {
  const url = new URL(FRED_ENDPOINT);
  url.search = new URLSearchParams({
    series_id: seriesId,
    api_key: apiKey,
    file_type: 'json',
    sort_order: 'desc',
    limit: '10',
  });

  let lastError;
  let attemptsUsed = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    attemptsUsed = attempt;
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
      if (!Array.isArray(payload?.observations) || payload.observations.length === 0) {
        const error = new Error('invalid observation payload');
        error.retryable = true;
        throw error;
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (error.retryable === false || attempt === MAX_ATTEMPTS) break;
      console.warn(`FRED ${seriesId} attempt ${attempt}/${MAX_ATTEMPTS} failed; retrying`);
      await wait(2 ** (attempt - 1) * 2_000);
    }
  }

  throw new Error(`FRED ${seriesId} failed after ${attemptsUsed} attempt(s)`, { cause: lastError });
};

export const refreshYieldCurve = async ({
  apiKey = process.env.FRED_API_KEY,
  outputPath = resolve('public/yield-curve.json'),
} = {}) => {
  if (!String(apiKey || '').trim()) {
    throw new Error('Missing FRED_API_KEY');
  }

  const payloadEntries = await Promise.all(FRED_CURVE_SERIES.map(async ({ id }) => [
    id,
    await fetchFredSeries(id, apiKey),
  ]));
  const curve = buildCommonYieldCurve(Object.fromEntries(payloadEntries));

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(curve, null, 2)}\n`, 'utf8');
  return curve;
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  refreshYieldCurve()
    .then((curve) => {
      console.log(`Prepared 11-point FRED curve for ${curve.observationDate}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
