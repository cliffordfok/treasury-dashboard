const BASE_URL = "https://api.stlouisfed.org/fred/series/observations";
const API_KEY = import.meta.env.VITE_FRED_API_KEY;

async function fetchFred(series) {
  const res = await fetch(
    `${BASE_URL}?series_id=${series}&api_key=${API_KEY}&file_type=json`
  );
  const data = await res.json();
  return data.observations.at(-1);
}

export async function get10Y() {
  return fetchFred("DGS10");
}

export async function get2Y() {
  return fetchFred("DGS2");
}
