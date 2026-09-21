import {
  isValidISODate,
  normalizeTradeForStorage,
  toDateAtMidnight,
} from './treasuryMath.js';

const VALID_TRADE_TYPES = new Set(['t-bill', 't-note', 't-bond', 'tips']);
const VALID_TRADE_SIDES = new Set(['buy', 'sell']);
const VALID_TRADE_STATUSES = new Set(['active', 'closed', undefined, null, '']);
const VALID_TIPS_FREQUENCIES = new Set([1, 2, 4, 12]);

const hasOwnValue = (value, key) => (
  Object.prototype.hasOwnProperty.call(value, key)
  && value[key] !== undefined
  && value[key] !== null
  && String(value[key]).trim() !== ''
);

export const markTradeDeleted = (trade, deletedAt = new Date()) => {
  if (!trade?.id) throw new Error('交易缺少識別碼');
  const timestamp = deletedAt instanceof Date ? deletedAt : new Date(deletedAt);
  if (Number.isNaN(timestamp.getTime())) throw new Error('刪除時間無效');
  return { ...trade, deletedAt: timestamp.toISOString() };
};

export const restoreDeletedTrade = (trade) => {
  if (!trade?.id) throw new Error('交易缺少識別碼');
  const restoredTrade = { ...trade };
  delete restoredTrade.deletedAt;
  return restoredTrade;
};

export const buildTradeBackup = (activeTrades, deletedTrades) => {
  if (!Array.isArray(activeTrades) || !Array.isArray(deletedTrades)) {
    throw new Error('備份交易集合無效');
  }
  return [...activeTrades, ...deletedTrades];
};

export const normalizeTradeBackupEntry = (rawTrade) => {
  if (!rawTrade || typeof rawTrade !== 'object' || Array.isArray(rawTrade)) {
    throw new Error('格式不是物件');
  }

  const rawId = String(rawTrade.id || '');
  if (!rawId || rawId.length > 1500 || rawId.includes('/')) {
    throw new Error('交易識別碼（id）無效');
  }

  const trade = normalizeTradeForStorage(rawTrade);
  if (!VALID_TRADE_TYPES.has(trade.type)) throw new Error('債券類型（type）無效');
  if (!VALID_TRADE_SIDES.has(trade.side)) throw new Error('交易方向（side）無效');
  if (!VALID_TRADE_STATUSES.has(rawTrade.status)) throw new Error('狀態（status）無效');
  if (!trade.cusip || trade.cusip.length > 120) throw new Error('CUSIP／名稱無效');
  if (!isValidISODate(trade.tradeDate) || !isValidISODate(trade.maturityDate)) {
    throw new Error('日期格式或日期值無效');
  }
  if (toDateAtMidnight(trade.maturityDate) <= toDateAtMidnight(trade.tradeDate)) {
    throw new Error('到期日（maturityDate）必須晚於交收日（legacy tradeDate）');
  }
  if (!Number.isFinite(trade.faceValue) || trade.faceValue <= 0 || trade.faceValue > 1_000_000_000_000) {
    throw new Error('面值（faceValue）無效');
  }
  if (!Number.isFinite(trade.cleanPrice) || trade.cleanPrice <= 0 || trade.cleanPrice > 1_000_000) {
    throw new Error('淨價（cleanPrice）無效');
  }
  if (!Number.isFinite(trade.currentMarketPrice) || trade.currentMarketPrice <= 0 || trade.currentMarketPrice > 1_000_000) {
    throw new Error('目前市場價格（currentMarketPrice）無效');
  }
  if (!Number.isFinite(trade.commission) || trade.commission < 0 || trade.commission > 1_000_000_000) {
    throw new Error('手續費（commission）無效');
  }
  if (trade.type !== 't-bill' && (!Number.isFinite(trade.couponRate) || trade.couponRate < 0 || trade.couponRate > 100)) {
    throw new Error('票息率（couponRate）無效');
  }
  if (
    (trade.type === 'tips' && !VALID_TIPS_FREQUENCIES.has(trade.couponFrequency))
    || (trade.type !== 'tips' && trade.type !== 't-bill' && trade.couponFrequency !== 2)
  ) {
    throw new Error('派息頻率（couponFrequency）無效');
  }
  if (
    trade.status === 'closed'
    && (
      !isValidISODate(trade.closeDate)
      || toDateAtMidnight(trade.closeDate) < toDateAtMidnight(trade.tradeDate)
      || toDateAtMidnight(trade.closeDate) > toDateAtMidnight(trade.maturityDate)
      || !Number.isFinite(trade.closePrice)
      || trade.closePrice <= 0
      || trade.closePrice > 1_000_000
      || !Number.isFinite(trade.closeCommission)
      || trade.closeCommission < 0
      || trade.closeCommission > 1_000_000_000
    )
  ) {
    throw new Error('已平倉交易缺少有效 closeDate／closePrice');
  }
  if (hasOwnValue(rawTrade, 'deletedAt') && !trade.deletedAt) {
    throw new Error('回收桶時間（deletedAt）無效');
  }
  if (hasOwnValue(rawTrade, 'priceUpdatedAt') && !trade.priceUpdatedAt) {
    throw new Error('價格更新日期（priceUpdatedAt）無效');
  }

  const hasFredFields = ['fredEstimatedPrice', 'fredEstimatedAt', 'fredPricingSignature']
    .some((key) => hasOwnValue(rawTrade, key));
  if (hasFredFields && !trade.fredEstimatedAt) {
    throw new Error('FRED 理論估值資料不完整或無效');
  }

  return trade;
};
