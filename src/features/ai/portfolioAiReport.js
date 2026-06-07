import { AI_MODE_LABELS } from './portfolioAiPrompts.js';
import { STOCK_QUOTES_ANALYSIS_LIMITATION } from './portfolioAiSnapshot.js';

export const AI_REPORT_SECTIONS = [
  '數據摘要',
  '主要觀察',
  '股票風險訊號',
  '估值觀察',
  '集中度 / 風險',
  '現金流 / 收益',
  '資料限制',
  '待確認事項',
];

const SECTION_ALIASES = new Map([
  ['數據摘要', '數據摘要'],
  ['主要觀察', '主要觀察'],
  ['股票風險訊號', '股票風險訊號'],
  ['股票風險信號', '股票風險訊號'],
  ['風險訊號', '股票風險訊號'],
  ['風險信號', '股票風險訊號'],
  ['估值觀察', '估值觀察'],
  ['估值 / 觀察', '估值觀察'],
  ['估值/觀察', '估值觀察'],
  ['集中度/風險', '集中度 / 風險'],
  ['集中度 / 風險', '集中度 / 風險'],
  ['現金流/收益', '現金流 / 收益'],
  ['現金流 / 收益', '現金流 / 收益'],
  ['資料限制', '資料限制'],
  ['待確認事項', '待確認事項'],
]);

const SENSITIVE_KEY_PATTERN = /(api[_-]?key|token|secret|password|authorization|credential)/i;

export const normalizeAiSectionTitle = (value = '') => {
  const cleaned = String(value)
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\s*(?:[-*]\s*)?\*{0,2}/, '')
    .replace(/\*{0,2}\s*[:：]?\s*$/, '')
    .replace(/^\s*\d+\.\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return SECTION_ALIASES.get(cleaned.replace(/\s*\/\s*/g, '/')) || SECTION_ALIASES.get(cleaned) || '';
};

const parseHeadingLine = (line = '') => {
  const trimmed = String(line).trim();
  if (!trimmed) return null;

  const directTitle = normalizeAiSectionTitle(trimmed);
  if (directTitle) return { title: directTitle, rest: '' };

  const colonMatch = trimmed.match(/^(?:#{1,6}\s*)?(?:\d+\.\s*)?(?:\*\*)?(.+?)(?:\*\*)?\s*[:：]\s*(.*)$/);
  if (!colonMatch) return null;

  const title = normalizeAiSectionTitle(colonMatch[1]);
  if (!title) return null;
  return { title, rest: colonMatch[2] || '' };
};

export const parseAiReportSections = (text = '') => {
  const raw = String(text || '').trim();
  if (!raw) return [];

  const sections = [];
  let current = null;
  const pushCurrent = () => {
    if (!current) return;
    sections.push({ title: current.title, content: current.lines.join('\n').trim() });
  };

  raw.split(/\r?\n/).forEach((line) => {
    const heading = parseHeadingLine(line);
    if (heading) {
      pushCurrent();
      current = { title: heading.title, lines: heading.rest ? [heading.rest] : [] };
      return;
    }
    if (!current) current = { title: 'AI 回應', lines: [] };
    current.lines.push(line);
  });
  pushCurrent();

  return sections.length > 0 ? sections : [{ title: 'AI 回應', content: raw }];
};

export const detectForbiddenAdvice = (text = '') => {
  const value = String(text || '');
  const patterns = [
    /(?:建議|應該|可以|適合|值得)\s*(?:買入|賣出|持有|加倉|減倉)/,
    /(?:買入|賣出|持有|加倉|減倉)\s*(?:建議|策略|時機)/,
    /目標價|target\s*price/i,
    /股價預測|預測股價|price\s*forecast/i,
    /回報預測|預測回報|return\s*forecast/i,
    /利率預測|預測利率|rate\s*forecast/i,
    /止賺|止盈|止蝕|止損|take\s*profit|stop\s*loss/i,
  ];
  return patterns.some((pattern) => pattern.test(value));
};

const sanitizeValue = (value) => {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!value || typeof value !== 'object') return value;
  return Object.entries(value).reduce((clean, [key, child]) => {
    clean[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[redacted]' : sanitizeValue(child);
    return clean;
  }, {});
};

export const sanitizeAiSnapshotForCopy = (snapshot = {}) => sanitizeValue(snapshot || {});

export const snapshotContainsSensitiveKeys = (snapshot = {}) => {
  const stack = [snapshot];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item || typeof item !== 'object') continue;
    for (const [key, value] of Object.entries(item)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) return true;
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return false;
};

export const isSingleStockModeReady = ({ mode, selectedSymbol, symbols = [] } = {}) =>
  mode !== 'stock_single' || (Boolean(selectedSymbol) && symbols.includes(selectedSymbol));

export const buildAiSnapshotSummary = (snapshot = {}) => ({
  asOf: snapshot.asOf || '',
  mode: snapshot.mode || 'total_assets',
  modeLabel: AI_MODE_LABELS[snapshot.mode] || AI_MODE_LABELS.total_assets,
  modules: [
    'Portfolio summary',
    snapshot.stocks ? 'Stocks' : null,
    snapshot.cash ? 'Cash' : null,
    snapshot.treasuries ? 'Treasuries' : null,
  ].filter(Boolean),
  quoteStatus: STOCK_QUOTES_ANALYSIS_LIMITATION,
  stockSymbolsCount: snapshot.allStocks?.holdingCount ?? snapshot.stocks?.holdingCount ?? 0,
  pricedSymbolCount: snapshot.allStocks?.quoteSummary?.pricedSymbolCount ?? snapshot.stocks?.quoteSummary?.pricedSymbolCount ?? 0,
  missingPriceCount: snapshot.allStocks?.quoteSummary?.missingPriceCount ?? snapshot.stocks?.quoteSummary?.missingPriceCount ?? 0,
  stalePriceCount: snapshot.allStocks?.quoteSummary?.stalePriceCount ?? snapshot.stocks?.quoteSummary?.stalePriceCount ?? 0,
  stockMarketValue: snapshot.allStocks?.quoteSummary?.totalMarketValue ?? snapshot.stocks?.quoteSummary?.totalMarketValue ?? null,
  stockUnrealizedPnl: snapshot.allStocks?.quoteSummary?.totalUnrealizedPnl ?? snapshot.stocks?.quoteSummary?.totalUnrealizedPnl ?? null,
  riskSignalCount: snapshot.allStocks?.riskSignals?.length ?? snapshot.stocks?.riskSignals?.length ?? 0,
  cashMovementCount: snapshot.cash?.movementCount ?? 0,
  treasuryHoldingCount: snapshot.treasuries?.holdingCount ?? 0,
});
