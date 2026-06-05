import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Briefcase, DollarSign, Edit2, Loader2, Plus, RefreshCw, Trash2, TrendingUp, Wallet, XCircle } from 'lucide-react';
import { EPSILON, calculateStockPortfolioTotals, calculateStockPositions, getStockTradeCashImpact, toNumber } from './stockCalculations';
import { defaultStockTradeForm, deleteStockTrade, normalizeStockTradeForStorage, saveStockTrade, subscribeStockTrades, updateStockTrade } from './stockFirestore';
import { fetchStockQuotes } from '../prices/stockQuoteClient.js';
import { getStockPriceMap, saveManualStockPrice, saveStockPrices, subscribeStockPrices } from '../prices/stockPriceFirestore.js';
import { attachPricesToPositions, calculateStockMarketTotals } from '../prices/stockPriceCalculations.js';
import {
  AUTO_QUOTE_ATTEMPT_COOLDOWN_MINUTES,
  AUTO_QUOTE_ENABLED_KEY,
  AUTO_QUOTE_STALE_HOURS,
  beginAutoQuoteRefresh,
  endAutoQuoteRefresh,
  filterQuotesForSave,
  getAutoQuoteLastAttemptKey,
  getSymbolsNeedingRefresh,
  shouldAttemptAutoRefresh,
} from '../prices/autoQuoteRefresh.js';

const money = (value, currency = 'USD') =>
  `${currency} ${toNumber(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const number = (value, digits = 4) =>
  toNumber(value).toLocaleString(undefined, { maximumFractionDigits: digits });

const signedMoney = (value, currency = 'USD') => {
  const amount = toNumber(value);
  return `${amount >= 0 ? '+' : ''}${money(amount, currency)}`;
};

const hasNumber = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const nullableMoney = (value, currency = 'USD') => (hasNumber(value) ? money(value, currency) : '--');
const signedNullableMoney = (value, currency = 'USD') => (hasNumber(value) ? signedMoney(value, currency) : '--');
const todayInputValue = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().split('T')[0];
const formatDateTime = (value) => {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString();
};

const sideLabel = (side) => {
  if (side === 'sell') return '賣出';
  if (side === 'opening_position') return '期初持倉';
  return '買入';
};

export default function StockDashboard({ db, user }) {
  const [stockTrades, setStockTrades] = useState([]);
  const [stockPrices, setStockPrices] = useState([]);
  const [formData, setFormData] = useState(defaultStockTradeForm);
  const [manualPriceForm, setManualPriceForm] = useState({ symbol: '', price: '', currency: 'USD', asOf: todayInputValue() });
  const [editingTradeId, setEditingTradeId] = useState('');
  const [editingTrade, setEditingTrade] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isRefreshingPrices, setIsRefreshingPrices] = useState(false);
  const [isSavingManualPrice, setIsSavingManualPrice] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [priceError, setPriceError] = useState('');
  const [isAutoQuoteEnabled, setIsAutoQuoteEnabled] = useState(() => localStorage.getItem(AUTO_QUOTE_ENABLED_KEY) !== 'false');
  const [autoQuoteStatus, setAutoQuoteStatus] = useState({
    isRunning: false,
    lastAttempt: localStorage.getItem(getAutoQuoteLastAttemptKey(user?.uid)) || '',
    updatedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    message: '',
  });
  const autoQuoteSignatureRef = useRef('');

  useEffect(() => {
    if (!db || !user?.uid) return undefined;
    setIsLoading(true);
    return subscribeStockTrades(
      db,
      user.uid,
      (trades) => {
        setStockTrades(trades);
        setError('');
        setIsLoading(false);
      },
      (err) => {
        setError(err.message || '未能載入美股交易。');
        setIsLoading(false);
      },
    );
  }, [db, user?.uid]);

  useEffect(() => {
    if (!db || !user?.uid) return undefined;
    return subscribeStockPrices(
      db,
      user.uid,
      (prices) => {
        setStockPrices(prices);
        setPriceError('');
      },
      (err) => setPriceError(err.message || 'Unable to load stock prices.'),
    );
  }, [db, user?.uid]);

  const positions = useMemo(() => calculateStockPositions(stockTrades), [stockTrades]);
  const totals = useMemo(() => calculateStockPortfolioTotals(positions), [positions]);
  const priceMap = useMemo(() => getStockPriceMap(stockPrices), [stockPrices]);
  const positionsWithPrices = useMemo(() => attachPricesToPositions(positions, priceMap), [positions, priceMap]);
  const marketTotals = useMemo(() => calculateStockMarketTotals(positionsWithPrices), [positionsWithPrices]);
  const validationPositions = useMemo(
    () => calculateStockPositions(editingTradeId ? stockTrades.filter((trade) => trade.id !== editingTradeId) : stockTrades),
    [editingTradeId, stockTrades],
  );

  const update = (field, value) => setFormData((prev) => ({ ...prev, [field]: value }));
  const updateSide = (value) => setFormData((prev) => ({
    ...prev,
    side: value,
    commission: value === 'opening_position' ? 0 : prev.commission,
    fees: value === 'opening_position' ? 0 : prev.fees,
  }));
  const updateManualPrice = (field, value) => setManualPriceForm((prev) => ({ ...prev, [field]: value }));

  const refreshQuotes = async (symbols, mode = 'manual') => {
    if (!db || !user?.uid) return;
    if (symbols.length === 0) {
      setPriceError('No stock positions to refresh.');
      return;
    }
    if (mode === 'manual') setIsRefreshingPrices(true);
    setPriceError('');
    try {
      const result = await fetchStockQuotes(symbols);
      const quotesToSave = filterQuotesForSave(result.quotes, priceMap, mode);
      if (quotesToSave.length > 0) {
        await saveStockPrices(db, user.uid, quotesToSave);
      }
      const skippedCount = result.quotes.length - quotesToSave.length;
      if (result.errors.length > 0) {
        setPriceError(result.errors.map((item) => `${item.symbol}: ${item.error}`).join(' / '));
      }
      return { updatedCount: quotesToSave.length, failedCount: result.errors.length, skippedCount };
    } catch (err) {
      setPriceError(err.message || 'Unable to refresh stock prices.');
      if (mode === 'auto') throw err;
      return { updatedCount: 0, failedCount: symbols.length, skippedCount: 0 };
    } finally {
      if (mode === 'manual') setIsRefreshingPrices(false);
    }
  };

  const handleRefreshPrices = async () => {
    const symbols = positions.map((position) => position.symbol).filter(Boolean).slice(0, 25);
    await refreshQuotes(symbols, 'manual');
  };

  const handleSaveManualPrice = async (event) => {
    event.preventDefault();
    if (!db || !user?.uid) return;
    setIsSavingManualPrice(true);
    setPriceError('');
    try {
      await saveManualStockPrice(db, user.uid, {
        ...manualPriceForm,
        symbol: manualPriceForm.symbol.toUpperCase(),
        asOf: manualPriceForm.asOf ? new Date(`${manualPriceForm.asOf}T00:00:00`).toISOString() : new Date().toISOString(),
      });
      setManualPriceForm({ symbol: '', price: '', currency: 'USD', asOf: todayInputValue() });
    } catch (err) {
      setPriceError(err.message || 'Unable to save manual stock price.');
    } finally {
      setIsSavingManualPrice(false);
    }
  };

  const resetForm = () => {
    setFormData(defaultStockTradeForm());
    setEditingTradeId('');
    setEditingTrade(null);
    setError('');
  };

  const handleEdit = (trade) => {
    setEditingTradeId(trade.id);
    setEditingTrade(trade);
    setFormData({
      ...defaultStockTradeForm(),
      ...trade,
      symbol: trade.symbol || '',
      name: trade.name || '',
      side: trade.side || 'buy',
      tradeDate: trade.tradeDate || defaultStockTradeForm().tradeDate,
      tradeTime: trade.tradeTime || '',
      quantity: trade.quantity ?? '',
      price: trade.price ?? '',
      commission: trade.commission ?? 0,
      fees: trade.fees ?? 0,
      currency: trade.currency || 'USD',
      notes: trade.notes || '',
    });
    setError('');
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!user?.uid) return;

    const normalized = normalizeStockTradeForStorage(formData, user.uid, editingTrade);
    if (!normalized.symbol || !normalized.tradeDate || normalized.quantity <= 0 || normalized.price < 0) {
      setError('請輸入有效股票代號、日期、數量及價格。');
      return;
    }
    if (normalized.side === 'sell') {
      const currentPosition = validationPositions.find((position) => position.symbol === normalized.symbol);
      const availableQuantity = currentPosition?.quantity || 0;
      if (normalized.quantity > availableQuantity + EPSILON) {
        setError(`持倉不足：${normalized.symbol} 現有 ${number(availableQuantity, 6)} 股，不可賣出 ${number(normalized.quantity, 6)} 股。`);
        return;
      }
    }

    setIsSaving(true);
    try {
      if (editingTradeId) {
        await updateStockTrade(db, user.uid, editingTradeId, normalized);
      } else {
        await saveStockTrade(db, user.uid, normalized);
      }
      resetForm();
      setError('');
    } catch (err) {
      setError(err.message || '未能儲存美股交易。');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (tradeId) => {
    if (!user?.uid) return;
    const confirmed = window.confirm('刪除此筆美股交易？');
    if (!confirmed) return;

    try {
      await deleteStockTrade(db, user.uid, tradeId);
      setError('');
    } catch (err) {
      setError(err.message || '未能刪除美股交易。');
    }
  };

  const handleAutoQuoteToggle = (event) => {
    const enabled = event.target.checked;
    setIsAutoQuoteEnabled(enabled);
    localStorage.setItem(AUTO_QUOTE_ENABLED_KEY, enabled ? 'true' : 'false');
    if (!enabled) setAutoQuoteStatus((prev) => ({ ...prev, message: '自動更新已關閉。' }));
  };

  useEffect(() => {
    if (!db || !user?.uid || isLoading || !isAutoQuoteEnabled) return;
    const symbols = getSymbolsNeedingRefresh(positions, priceMap, { staleHours: AUTO_QUOTE_STALE_HOURS });
    if (symbols.length === 0) {
      setAutoQuoteStatus((prev) => ({ ...prev, message: '所有持倉報價仍然有效。' }));
      return;
    }

    const lastAttemptKey = getAutoQuoteLastAttemptKey(user.uid);
    const lastAttempt = localStorage.getItem(lastAttemptKey);
    if (!shouldAttemptAutoRefresh(lastAttempt, AUTO_QUOTE_ATTEMPT_COOLDOWN_MINUTES)) {
      setAutoQuoteStatus((prev) => ({ ...prev, lastAttempt: lastAttempt || prev.lastAttempt, message: '自動更新 cooldown 中。' }));
      return;
    }

    const signature = `${user.uid}:${symbols.join(',')}:${lastAttempt || ''}`;
    if (autoQuoteSignatureRef.current === signature) return;
    if (!beginAutoQuoteRefresh()) return;

    autoQuoteSignatureRef.current = signature;
    const attemptedAt = new Date().toISOString();
    localStorage.setItem(lastAttemptKey, attemptedAt);
    setAutoQuoteStatus((prev) => ({
      ...prev,
      isRunning: true,
      lastAttempt: attemptedAt,
      message: `自動更新 ${symbols.length} 個股票代號...`,
    }));

    refreshQuotes(symbols, 'auto')
      .then((result) => {
        setAutoQuoteStatus((prev) => ({
          ...prev,
          isRunning: false,
          lastAttempt: attemptedAt,
          updatedCount: result?.updatedCount || 0,
          failedCount: result?.failedCount || 0,
          skippedCount: result?.skippedCount || 0,
          message: `自動更新完成：${result?.updatedCount || 0} 個成功，${result?.failedCount || 0} 個失敗。`,
        }));
      })
      .catch((err) => {
        setAutoQuoteStatus((prev) => ({
          ...prev,
          isRunning: false,
          lastAttempt: attemptedAt,
          updatedCount: 0,
          failedCount: symbols.length,
          skippedCount: 0,
          message: '自動報價失敗，可稍後再試或使用手動價格。',
        }));
        setPriceError(err.message || '自動報價失敗，可稍後再試或使用手動價格。');
      })
      .finally(() => {
        endAutoQuoteRefresh();
      });
  }, [db, user?.uid, isLoading, isAutoQuoteEnabled, positions, priceMap]);

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="bg-slate-900 text-white rounded-xl shadow-sm p-4 sm:p-5 relative overflow-hidden">
        <div className="absolute -top-4 -right-4 opacity-5 pointer-events-none"><Briefcase size={112} /></div>
        <p className="text-slate-300 text-xs sm:text-sm font-medium mb-1.5">美股 / ETF 交易總帳</p>
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight">券商美股及 ETF 交易紀錄</h2>
        <p className="text-slate-300 text-xs sm:text-sm mt-1.5 max-w-2xl">由交易流水帳自動計算持倉、平均成本、已實現盈虧及現金影響。第一階段不接即時報價。</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <div className="bg-white p-4 sm:p-5 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3 min-w-0">
          <div className="p-2.5 bg-blue-50 text-blue-600 rounded-lg"><Briefcase size={20} /></div>
          <div className="min-w-0"><p className="text-[11px] text-slate-500 font-medium leading-tight">持倉股票代號</p><p className="text-xl font-bold text-slate-800 truncate">{positions.length}</p></div>
        </div>
        <div className="bg-white p-4 sm:p-5 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3 min-w-0">
          <div className="p-2.5 bg-emerald-50 text-emerald-600 rounded-lg"><DollarSign size={20} /></div>
          <div className="min-w-0"><p className="text-[11px] text-slate-500 font-medium leading-tight">剩餘成本</p><p className="text-base sm:text-xl font-bold text-slate-800 truncate">{money(totals.remainingCost)}</p></div>
        </div>
        <div className="bg-white p-4 sm:p-5 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3 min-w-0">
          <div className={`p-2.5 rounded-lg ${totals.realizedPnl >= 0 ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`}><TrendingUp size={20} /></div>
          <div className="min-w-0"><p className="text-[11px] text-slate-500 font-medium leading-tight">已實現盈虧</p><p className={`text-base sm:text-xl font-bold truncate ${totals.realizedPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>{signedMoney(totals.realizedPnl)}</p></div>
        </div>
        <div className="bg-white p-4 sm:p-5 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3 min-w-0">
          <div className={`p-2.5 rounded-lg ${totals.cashImpact >= 0 ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`}><Wallet size={20} /></div>
          <div className="min-w-0"><p className="text-[11px] text-slate-500 font-medium leading-tight">股票交易現金影響</p><p className={`text-base sm:text-xl font-bold truncate ${totals.cashImpact >= 0 ? 'text-green-600' : 'text-red-600'}`}>{signedMoney(totals.cashImpact)}</p></div>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <div className="bg-white p-4 sm:p-5 rounded-xl shadow-sm border border-slate-100 min-w-0">
          <p className="text-[11px] text-slate-500 font-medium leading-tight">Market Value</p>
          <p className="text-base sm:text-xl font-bold text-slate-800 truncate">{nullableMoney(marketTotals.totalMarketValue)}</p>
          <p className="text-[10px] text-slate-400 mt-1 truncate">From saved stockPrices</p>
        </div>
        <div className="bg-white p-4 sm:p-5 rounded-xl shadow-sm border border-slate-100 min-w-0">
          <p className="text-[11px] text-slate-500 font-medium leading-tight">Unrealized P&amp;L</p>
          <p className={`text-base sm:text-xl font-bold truncate ${marketTotals.totalUnrealizedPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>{signedNullableMoney(marketTotals.totalUnrealizedPnl)}</p>
          <p className="text-[10px] text-slate-400 mt-1 truncate">Market value - remaining cost</p>
        </div>
        <div className="bg-white p-4 sm:p-5 rounded-xl shadow-sm border border-slate-100 min-w-0">
          <p className="text-[11px] text-slate-500 font-medium leading-tight">Priced Symbols</p>
          <p className="text-base sm:text-xl font-bold text-slate-800 truncate">{marketTotals.pricedSymbolCount} / {positions.length}</p>
          <p className="text-[10px] text-slate-400 mt-1 truncate">{marketTotals.missingPriceCount} missing</p>
        </div>
        <div className="bg-white p-4 sm:p-5 rounded-xl shadow-sm border border-slate-100 min-w-0">
          <p className="text-[11px] text-slate-500 font-medium leading-tight">Quote Status</p>
          <p className={`text-base sm:text-xl font-bold truncate ${marketTotals.stalePriceCount > 0 ? 'text-amber-600' : 'text-slate-800'}`}>{marketTotals.stalePriceCount} stale</p>
          <p className="text-[10px] text-slate-400 mt-1 truncate">Older than 3 calendar days</p>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-slate-800">Stock quote update</h3>
            <p className="text-xs text-slate-500 mt-1">Uses a server-side proxy. Current source: Yahoo Finance unofficial.</p>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={isAutoQuoteEnabled} onChange={handleAutoQuoteToggle} className="h-4 w-4 rounded border-slate-300" />
              自動更新報價
            </label>
            <button type="button" onClick={handleRefreshPrices} disabled={isRefreshingPrices || positions.length === 0} className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white px-4 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-2">
              {isRefreshingPrices ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
              Refresh quotes
            </button>
          </div>
        </div>
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-100 grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs">
          <div>
            <p className="font-semibold text-slate-500">Auto quote status</p>
            <p className={`${autoQuoteStatus.isRunning ? 'text-blue-600' : isAutoQuoteEnabled ? 'text-emerald-600' : 'text-slate-500'}`}>
              {autoQuoteStatus.isRunning ? '自動更新中...' : isAutoQuoteEnabled ? '自動更新已啟用' : '自動更新已關閉'}
            </p>
          </div>
          <div>
            <p className="font-semibold text-slate-500">上次自動嘗試</p>
            <p className="text-slate-600">{formatDateTime(autoQuoteStatus.lastAttempt)}</p>
          </div>
          <div>
            <p className="font-semibold text-slate-500">本次結果</p>
            <p className="text-slate-600">{autoQuoteStatus.updatedCount} updated / {autoQuoteStatus.failedCount} failed</p>
          </div>
          <div>
            <p className="font-semibold text-slate-500">說明</p>
            <p className="text-slate-600">{autoQuoteStatus.message || `Stale after ${AUTO_QUOTE_STALE_HOURS} hours · cooldown ${AUTO_QUOTE_ATTEMPT_COOLDOWN_MINUTES} minutes`}</p>
          </div>
        </div>
        <form onSubmit={handleSaveManualPrice} className="p-4 sm:p-5 grid grid-cols-1 sm:grid-cols-5 gap-3 bg-slate-50/60">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Manual symbol</label>
            <input value={manualPriceForm.symbol} onChange={(e) => updateManualPrice('symbol', e.target.value.toUpperCase())} placeholder="VOO" className="w-full min-h-10 p-2 border rounded-lg text-sm uppercase" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Price</label>
            <input type="number" min="0" step="0.0001" value={manualPriceForm.price} onChange={(e) => updateManualPrice('price', e.target.value)} placeholder="693.12" className="w-full min-h-10 p-2 border rounded-lg text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Currency</label>
            <input value={manualPriceForm.currency} onChange={(e) => updateManualPrice('currency', e.target.value.toUpperCase())} className="w-full min-h-10 p-2 border rounded-lg text-sm uppercase" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">As of</label>
            <input type="date" value={manualPriceForm.asOf} onChange={(e) => updateManualPrice('asOf', e.target.value)} className="w-full min-h-10 p-2 border rounded-lg text-sm" />
          </div>
          <div className="flex items-end">
            <button type="submit" disabled={isSavingManualPrice} className="w-full bg-slate-800 hover:bg-slate-900 disabled:bg-slate-300 text-white px-4 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-2">
              {isSavingManualPrice ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              Save price
            </button>
          </div>
          {priceError && <p className="sm:col-span-5 text-sm text-amber-700 bg-amber-50 border border-amber-100 rounded-lg p-3">{priceError}</p>}
        </form>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(340px,440px)_1fr] gap-4">
        <form onSubmit={handleSubmit} className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
          <div className="p-4 border-b border-slate-100">
            <h3 className="text-sm font-medium text-slate-800 flex items-center gap-2">
              {editingTradeId ? <Edit2 size={18} className="text-blue-600" /> : <Plus size={18} className="text-blue-600" />}
              {editingTradeId ? '編輯股票交易' : '新增股票交易'}
            </h3>
            <p className="text-xs text-slate-500 mt-1">Account 預設券商帳戶，可記錄美股及 ETF 買賣。</p>
          </div>
          <div className="p-4 sm:p-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">股票代號</label>
              <input required value={formData.symbol} onChange={(e) => update('symbol', e.target.value.toUpperCase())} placeholder="例如 VOO、NVDA、GOOGL" className="w-full min-h-10 p-2 border rounded-lg text-sm uppercase" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">類型</label>
              <select value={formData.side} onChange={(e) => updateSide(e.target.value)} className="w-full min-h-10 p-2 border rounded-lg text-sm">
                <option value="buy">買入</option>
                <option value="sell">賣出</option>
                <option value="opening_position">期初持倉</option>
              </select>
            </div>
            {formData.side === 'opening_position' && (
              <div className="sm:col-span-2 text-xs text-blue-700 bg-blue-50 border border-blue-100 rounded-lg p-3">
                期初持倉只用來建立起始股數及成本，不會影響現金餘額。
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">交易日期</label>
              <input required type="date" value={formData.tradeDate} onChange={(e) => update('tradeDate', e.target.value)} className="w-full min-h-10 p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">數量</label>
              <input required type="number" min="0" step="0.000001" value={formData.quantity} onChange={(e) => update('quantity', e.target.value)} className="w-full min-h-10 p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">價格</label>
              <input required type="number" min="0" step="0.0001" value={formData.price} onChange={(e) => update('price', e.target.value)} className="w-full min-h-10 p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">貨幣</label>
              <input value={formData.currency} onChange={(e) => update('currency', e.target.value.toUpperCase())} className="w-full min-h-10 p-2 border rounded-lg text-sm uppercase" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">手續費</label>
              <input type="number" min="0" step="0.01" value={formData.commission} onChange={(e) => update('commission', e.target.value)} className="w-full min-h-10 p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">其他費用</label>
              <input type="number" min="0" step="0.01" value={formData.fees} onChange={(e) => update('fees', e.target.value)} className="w-full min-h-10 p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">時間（可選）</label>
              <input type="time" value={formData.tradeTime} onChange={(e) => update('tradeTime', e.target.value)} className="w-full min-h-10 p-2 border rounded-lg text-sm" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-500 mb-1">備註（可選）</label>
              <textarea value={formData.notes} onChange={(e) => update('notes', e.target.value)} rows={2} className="w-full min-h-20 p-2 border rounded-lg text-sm" />
            </div>
          </div>
          <div className="p-4 border-t bg-slate-50 flex flex-col sm:flex-row sm:justify-end gap-2">
            {editingTradeId && (
              <button type="button" onClick={resetForm} className="bg-white hover:bg-slate-100 border border-slate-200 text-slate-600 px-4 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-2">
                <XCircle size={16} /> 取消編輯
              </button>
            )}
            <button disabled={isSaving} className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2">
              {isSaving ? <Loader2 size={16} className="animate-spin" /> : editingTradeId ? <Edit2 size={16} /> : <Plus size={16} />}
              {editingTradeId ? '儲存修改' : '儲存交易'}
            </button>
          </div>
        </form>

        <div className="space-y-4">
          <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex justify-between items-center">
              <h3 className="text-base font-bold text-slate-800">持倉摘要</h3>
              <span className="text-xs text-slate-500">平均成本法</span>
            </div>
            <div className="md:hidden divide-y divide-slate-100">
              {isLoading ? (
                <div className="p-6 text-center text-slate-400"><Loader2 className="animate-spin inline mr-2" size={16} />載入中...</div>
              ) : positionsWithPrices.length === 0 ? (
                <div className="p-6 text-center text-slate-400">未有股票交易。</div>
              ) : positionsWithPrices.map((position) => (
                <div key={position.symbol} className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-bold text-slate-900 truncate">{position.symbol}</p>
                      <p className="text-xs text-slate-400 truncate">{position.name || position.currency}</p>
                    </div>
                    <p className={`font-bold ${position.realizedPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>{signedMoney(position.realizedPnl, position.currency)}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div><p className="text-xs text-slate-500">股數</p><p className="font-semibold">{number(position.quantity)}</p></div>
                    <div><p className="text-xs text-slate-500">平均成本</p><p className="font-semibold">{money(position.averageCost, position.currency)}</p></div>
                    <div><p className="text-xs text-slate-500">剩餘成本</p><p className="font-semibold">{money(position.remainingCost, position.currency)}</p></div>
                    <div><p className="text-xs text-slate-500">已實現盈虧</p><p className={`font-semibold ${position.realizedPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>{signedMoney(position.realizedPnl, position.currency)}</p></div>
                    <div><p className="text-xs text-slate-500">Current Price</p><p className="font-semibold">{nullableMoney(position.currentPrice, position.currency)}</p></div>
                    <div><p className="text-xs text-slate-500">Market Value</p><p className="font-semibold">{nullableMoney(position.marketValue, position.currency)}</p></div>
                    <div className="col-span-2"><p className="text-xs text-slate-500">Unrealized P&amp;L</p><p className={`font-semibold ${hasNumber(position.unrealizedPnl) && position.unrealizedPnl < 0 ? 'text-red-600' : 'text-green-600'}`}>{signedNullableMoney(position.unrealizedPnl, position.currency)}{hasNumber(position.unrealizedPnlPercent) ? ` (${position.unrealizedPnlPercent.toFixed(2)}%)` : ''}</p></div>
                  </div>
                </div>
              ))}
            </div>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                  <tr>
                    <th className="p-3 text-left">股票代號</th>
                    <th className="p-3 text-right">股數</th>
                    <th className="p-3 text-right">平均成本</th>
                    <th className="p-3 text-right">剩餘成本</th>
                    <th className="p-3 text-right">已實現盈虧</th>
                    <th className="p-3 text-right">Current Price</th>
                    <th className="p-3 text-right">Market Value</th>
                    <th className="p-3 text-right">Unrealized P&amp;L</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {isLoading ? (
                    <tr><td colSpan="8" className="p-6 text-center text-slate-400"><Loader2 className="animate-spin inline mr-2" size={16} />載入中...</td></tr>
                  ) : positionsWithPrices.length === 0 ? (
                    <tr><td colSpan="8" className="p-6 text-center text-slate-400">未有股票交易。</td></tr>
                  ) : positionsWithPrices.map((position) => (
                    <tr key={position.symbol} className="hover:bg-slate-50">
                      <td className="p-3 font-bold text-slate-800">{position.symbol}<div className="text-[10px] text-slate-400 font-normal">{position.name || position.currency}</div></td>
                      <td className="p-3 text-right font-medium">{number(position.quantity)}</td>
                      <td className="p-3 text-right">{money(position.averageCost, position.currency)}</td>
                      <td className="p-3 text-right">{money(position.remainingCost, position.currency)}</td>
                      <td className={`p-3 text-right font-bold ${position.realizedPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>{signedMoney(position.realizedPnl, position.currency)}</td>
                      <td className="p-3 text-right">{nullableMoney(position.currentPrice, position.currency)}{position.isPriceStale && <div className="text-[10px] text-amber-600">Stale</div>}</td>
                      <td className="p-3 text-right">{nullableMoney(position.marketValue, position.currency)}</td>
                      <td className={`p-3 text-right font-bold ${hasNumber(position.unrealizedPnl) && position.unrealizedPnl < 0 ? 'text-red-600' : 'text-green-600'}`}>{signedNullableMoney(position.unrealizedPnl, position.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex justify-between items-center">
              <h3 className="text-base font-bold text-slate-800">交易紀錄</h3>
              <span className="text-xs text-slate-500">{stockTrades.length} 筆交易</span>
            </div>
            {error && <p className="m-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg p-3">{error}</p>}
            <div className="md:hidden divide-y divide-slate-100">
              {isLoading ? (
                <div className="p-6 text-center text-slate-400"><Loader2 className="animate-spin inline mr-2" size={16} />載入中...</div>
              ) : stockTrades.length === 0 ? (
                <div className="p-6 text-center text-slate-400">未有交易紀錄。</div>
              ) : stockTrades.map((trade) => {
                const cashImpact = getStockTradeCashImpact(trade);
                return (
                  <div key={trade.id} className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-bold text-slate-900 truncate">{trade.symbol}</p>
                        <p className="text-xs text-slate-400">{trade.tradeDate}{trade.tradeTime ? ` · ${trade.tradeTime}` : ''}</p>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold text-white ${trade.side === 'sell' ? 'bg-red-500' : trade.side === 'opening_position' ? 'bg-blue-500' : 'bg-emerald-500'}`}>{sideLabel(trade.side)}</span>
                        {trade.source === 'firstrade_csv' && <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-500">CSV 匯入</span>}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div><p className="text-xs text-slate-500">數量 × 價格</p><p className="font-semibold">{number(trade.quantity)} × {money(trade.price, trade.currency)}</p></div>
                      <div><p className="text-xs text-slate-500">手續費 / 費用</p><p className="font-semibold">{money(trade.commission, trade.currency)} / {money(trade.fees, trade.currency)}</p></div>
                      <div className="col-span-2"><p className="text-xs text-slate-500">現金影響</p><p className={`font-bold ${trade.side === 'opening_position' ? 'text-slate-500' : cashImpact >= 0 ? 'text-green-600' : 'text-red-600'}`}>{trade.side === 'opening_position' ? '不影響現金' : signedMoney(cashImpact, trade.currency)}</p></div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <button onClick={() => handleEdit(trade)} className="text-blue-500 hover:bg-blue-50 p-2 rounded" title="編輯交易">
                        <Edit2 size={16} />
                      </button>
                      <button onClick={() => handleDelete(trade.id)} className="text-red-500 hover:bg-red-50 p-2 rounded" title="刪除交易">
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                  <tr>
                    <th className="p-3 text-left">日期</th>
                    <th className="p-3 text-left">類型</th>
                    <th className="p-3 text-left">股票代號</th>
                    <th className="p-3 text-right">數量</th>
                    <th className="p-3 text-right">價格</th>
                    <th className="p-3 text-right">手續費</th>
                    <th className="p-3 text-right">其他費用</th>
                    <th className="p-3 text-right">總額</th>
                    <th className="p-3 text-center">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {isLoading ? (
                    <tr><td colSpan="9" className="p-6 text-center text-slate-400"><Loader2 className="animate-spin inline mr-2" size={16} />載入中...</td></tr>
                  ) : stockTrades.length === 0 ? (
                    <tr><td colSpan="9" className="p-6 text-center text-slate-400">未有交易紀錄。</td></tr>
                  ) : stockTrades.map((trade) => {
                    const cashImpact = getStockTradeCashImpact(trade);
                    return (
                      <tr key={trade.id} className="hover:bg-slate-50">
                        <td className="p-3 whitespace-nowrap">{trade.tradeDate}<div className="text-[10px] text-slate-400">{trade.tradeTime || trade.accountId || 'firstrade'}</div></td>
                        <td className="p-3">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold text-white ${trade.side === 'sell' ? 'bg-red-500' : trade.side === 'opening_position' ? 'bg-blue-500' : 'bg-emerald-500'}`}>{sideLabel(trade.side)}</span>
                          {trade.source === 'firstrade_csv' && <div className="mt-1"><span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-500">CSV 匯入</span></div>}
                        </td>
                        <td className="p-3 font-bold">{trade.symbol}<div className="text-[10px] text-slate-400 font-normal">{trade.name || '--'}</div></td>
                        <td className="p-3 text-right">{number(trade.quantity)}</td>
                        <td className="p-3 text-right">{money(trade.price, trade.currency)}</td>
                        <td className="p-3 text-right">{money(trade.commission, trade.currency)}</td>
                        <td className="p-3 text-right">{money(trade.fees, trade.currency)}</td>
                        <td className={`p-3 text-right font-bold ${trade.side === 'opening_position' ? 'text-slate-400' : cashImpact >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {trade.side === 'opening_position' ? '不影響現金' : signedMoney(cashImpact, trade.currency)}
                        </td>
                        <td className="p-3 text-center">
                          <button onClick={() => handleEdit(trade)} className="text-blue-500 hover:bg-blue-50 p-1.5 rounded" title="編輯交易">
                            <Edit2 size={16} />
                          </button>
                          <button onClick={() => handleDelete(trade.id)} className="text-red-500 hover:bg-red-50 p-1.5 rounded" title="刪除交易">
                            <Trash2 size={16} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
