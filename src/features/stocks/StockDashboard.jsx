import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Briefcase, DollarSign, Edit2, KeyRound, Loader2, Plus, RefreshCw, Save, Trash2, TrendingUp, Wallet, XCircle } from 'lucide-react';
import { attachPricesToPositions, calculateStockMarketTotals } from '../prices/stockPriceCalculations';
import { fetchStockQuotes } from '../prices/stockQuoteClient';
import { getStockPriceMap, saveManualStockPrice, saveStockPrices, subscribeStockPrices } from '../prices/stockPriceFirestore';
import { EPSILON, calculateStockPortfolioTotals, calculateStockPositions, getStockTradeCashImpact, toNumber } from './stockCalculations';
import { defaultStockTradeForm, deleteStockTrade, normalizeStockTradeForStorage, saveStockTrade, subscribeStockTrades, updateStockTrade } from './stockFirestore';

const TWELVE_DATA_KEY_STORAGE_KEY = 'portfolioDashboard.twelveDataApiKey';

const money = (value, currency = 'USD') =>
  `${currency} ${toNumber(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const number = (value, digits = 4) =>
  toNumber(value).toLocaleString(undefined, { maximumFractionDigits: digits });

const signedMoney = (value, currency = 'USD') => {
  const amount = toNumber(value);
  return `${amount >= 0 ? '+' : ''}${money(amount, currency)}`;
};

const sideLabel = (side) => {
  if (side === 'sell') return '賣出';
  if (side === 'opening_position') return '期初持倉';
  return '買入';
};

const formatDateTime = (value) => {
  if (!value) return '--';
  const date = value?.toDate ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-HK', { hour12: false });
};

const getActiveSymbols = (positions = []) =>
  positions
    .filter((position) => toNumber(position.quantity) > EPSILON)
    .map((position) => position.symbol)
    .filter(Boolean);

export default function StockDashboard({ db, user }) {
  const [stockTrades, setStockTrades] = useState([]);
  const [stockPrices, setStockPrices] = useState([]);
  const [formData, setFormData] = useState(defaultStockTradeForm);
  const [editingTradeId, setEditingTradeId] = useState('');
  const [editingTrade, setEditingTrade] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [quoteError, setQuoteError] = useState('');
  const [quoteResult, setQuoteResult] = useState('');
  const [isRefreshingQuotes, setIsRefreshingQuotes] = useState(false);
  const [twelveDataApiKey, setTwelveDataApiKey] = useState(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem(TWELVE_DATA_KEY_STORAGE_KEY) || '';
  });
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [isApiKeyOpen, setIsApiKeyOpen] = useState(false);
  const [manualPrice, setManualPrice] = useState({
    symbol: '',
    price: '',
    currency: 'USD',
    asOf: new Date().toISOString().slice(0, 10),
  });

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
      setStockPrices,
      (err) => setQuoteError(err.message || '未能載入股票報價。'),
    );
  }, [db, user?.uid]);

  const positions = useMemo(() => calculateStockPositions(stockTrades), [stockTrades]);
  const priceMap = useMemo(() => getStockPriceMap(stockPrices), [stockPrices]);
  const positionsWithPrices = useMemo(() => attachPricesToPositions(positions, priceMap), [positions, priceMap]);
  const totals = useMemo(() => calculateStockPortfolioTotals(positions), [positions]);
  const marketTotals = useMemo(() => calculateStockMarketTotals(positionsWithPrices), [positionsWithPrices]);
  const activeSymbols = useMemo(() => getActiveSymbols(positions), [positions]);
  const validationPositions = useMemo(
    () => calculateStockPositions(editingTradeId ? stockTrades.filter((trade) => trade.id !== editingTradeId) : stockTrades),
    [editingTradeId, stockTrades],
  );
  const hasTwelveDataKey = Boolean(twelveDataApiKey.trim());

  const update = (field, value) => setFormData((prev) => ({ ...prev, [field]: value }));
  const updateSide = (value) => setFormData((prev) => ({
    ...prev,
    side: value,
    commission: value === 'opening_position' ? 0 : prev.commission,
    fees: value === 'opening_position' ? 0 : prev.fees,
  }));
  const resetForm = () => {
    setFormData(defaultStockTradeForm());
    setEditingTradeId('');
    setEditingTrade(null);
    setError('');
  };

  const openApiKeySettings = () => {
    setApiKeyDraft(twelveDataApiKey);
    setIsApiKeyOpen(true);
    setQuoteError('');
    setQuoteResult('');
  };

  const handleSaveApiKey = () => {
    const key = apiKeyDraft.trim();
    if (typeof window !== 'undefined') {
      if (key) window.localStorage.setItem(TWELVE_DATA_KEY_STORAGE_KEY, key);
      else window.localStorage.removeItem(TWELVE_DATA_KEY_STORAGE_KEY);
    }
    setTwelveDataApiKey(key);
    setApiKeyDraft('');
    setIsApiKeyOpen(false);
    setQuoteResult(key ? '已儲存 Twelve Data API Key。' : '已清除 Twelve Data API Key。');
    setQuoteError('');
  };

  const handleClearApiKey = () => {
    if (typeof window !== 'undefined') window.localStorage.removeItem(TWELVE_DATA_KEY_STORAGE_KEY);
    setTwelveDataApiKey('');
    setApiKeyDraft('');
    setQuoteResult('已清除 Twelve Data API Key。');
    setQuoteError('');
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

  const handleRefreshQuotes = async () => {
    if (!user?.uid) return;
    if (activeSymbols.length === 0) {
      setQuoteError('目前沒有持倉股票代號可更新報價。');
      return;
    }
    if (!hasTwelveDataKey) {
      setQuoteError('請先按 API Key 輸入 Twelve Data API Key。');
      setIsApiKeyOpen(true);
      return;
    }

    setIsRefreshingQuotes(true);
    setQuoteError('');
    setQuoteResult('');
    try {
      const result = await fetchStockQuotes(activeSymbols, { apiKey: twelveDataApiKey });
      if (result.quotes.length > 0) await saveStockPrices(db, user.uid, result.quotes);
      const failedText = result.errors.length > 0
        ? `；${result.errors.map((item) => `${item.symbol}: ${item.error}`).join(' / ')}`
        : '';
      setQuoteResult(`已更新 ${result.quotes.length} / ${activeSymbols.length} 個股票報價${failedText}`);
      if (result.quotes.length === 0 && result.errors.length > 0) setQuoteError(result.errors.map((item) => `${item.symbol}: ${item.error}`).join(' / '));
    } catch (err) {
      setQuoteError(err.message || '未能更新股票報價。');
    } finally {
      setIsRefreshingQuotes(false);
    }
  };

  const handleSaveManualPrice = async (event) => {
    event.preventDefault();
    if (!user?.uid) return;
    try {
      await saveManualStockPrice(db, user.uid, manualPrice);
      setManualPrice({
        symbol: '',
        price: '',
        currency: 'USD',
        asOf: new Date().toISOString().slice(0, 10),
      });
      setQuoteResult('已儲存手動價格。');
      setQuoteError('');
    } catch (err) {
      setQuoteError(err.message || '未能儲存手動價格。');
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="bg-slate-900 text-white rounded-xl shadow-sm p-4 sm:p-5 relative overflow-hidden">
        <div className="absolute -top-4 -right-4 opacity-5 pointer-events-none"><Briefcase size={112} /></div>
        <p className="text-slate-300 text-xs sm:text-sm font-medium mb-1.5">美股 / ETF 交易總帳</p>
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight">券商美股及 ETF 交易紀錄</h2>
        <p className="text-slate-300 text-xs sm:text-sm mt-1.5 max-w-2xl">由交易流水帳自動計算持倉、平均成本、已實現盈虧及現金影響；Twelve Data 報價只用於估算市值及未實現盈虧。</p>
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
        <div className="bg-white p-4 sm:p-5 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3 min-w-0">
          <div className="p-2.5 bg-indigo-50 text-indigo-600 rounded-lg"><DollarSign size={20} /></div>
          <div className="min-w-0"><p className="text-[11px] text-slate-500 font-medium leading-tight">Market Value</p><p className="text-base sm:text-xl font-bold text-slate-800 truncate">{money(marketTotals.totalMarketValue)}</p></div>
        </div>
        <div className="bg-white p-4 sm:p-5 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3 min-w-0">
          <div className={`p-2.5 rounded-lg ${marketTotals.totalUnrealizedPnl >= 0 ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`}><TrendingUp size={20} /></div>
          <div className="min-w-0"><p className="text-[11px] text-slate-500 font-medium leading-tight">Unrealized P&L</p><p className={`text-base sm:text-xl font-bold truncate ${marketTotals.totalUnrealizedPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>{signedMoney(marketTotals.totalUnrealizedPnl)}</p></div>
        </div>
        <div className="bg-white p-4 sm:p-5 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3 min-w-0">
          <div className="p-2.5 bg-slate-100 text-slate-600 rounded-lg"><RefreshCw size={20} /></div>
          <div className="min-w-0"><p className="text-[11px] text-slate-500 font-medium leading-tight">Priced Symbols</p><p className="text-base sm:text-xl font-bold text-slate-800 truncate">{marketTotals.pricedSymbolCount} / {positions.length}</p><p className="text-[10px] text-slate-400 truncate">{marketTotals.missingPriceCount} missing</p></div>
        </div>
        <div className="bg-white p-4 sm:p-5 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3 min-w-0">
          <div className={`p-2.5 rounded-lg ${marketTotals.stalePriceCount > 0 ? 'bg-amber-50 text-amber-600' : 'bg-emerald-50 text-emerald-600'}`}><AlertCircle size={20} /></div>
          <div className="min-w-0"><p className="text-[11px] text-slate-500 font-medium leading-tight">Quote Status</p><p className="text-base sm:text-xl font-bold text-slate-800 truncate">{marketTotals.stalePriceCount} stale</p><p className="text-[10px] text-slate-400 truncate">Older than 3 calendar days</p></div>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-slate-800">股票報價</h3>
            <p className="text-xs text-slate-500 mt-1">來源：Twelve Data。API Key 只會儲存在此瀏覽器 localStorage，不會寫入 Firestore。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={openApiKeySettings} className={`px-3 py-2 rounded-lg text-sm font-semibold border flex items-center gap-2 ${hasTwelveDataKey ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-white text-slate-700 border-slate-200'}`}>
              <KeyRound size={16} /> {hasTwelveDataKey ? 'Twelve Data Key 已設定' : '輸入 API Key'}
            </button>
            <button type="button" onClick={handleRefreshQuotes} disabled={isRefreshingQuotes || activeSymbols.length === 0} className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2">
              {isRefreshingQuotes ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />} 更新持倉報價
            </button>
          </div>
        </div>
        {isApiKeyOpen && (
          <div className="p-4 border-b border-slate-100 bg-slate-50">
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="password"
                value={apiKeyDraft}
                onChange={(event) => setApiKeyDraft(event.target.value)}
                placeholder="Paste your Twelve Data API key"
                className="flex-1 min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                autoComplete="off"
              />
              <button type="button" onClick={handleSaveApiKey} className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded-lg text-sm font-semibold">儲存</button>
              {hasTwelveDataKey && <button type="button" onClick={handleClearApiKey} className="bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 px-3 py-2 rounded-lg text-sm font-semibold">清除</button>}
              <button type="button" onClick={() => setIsApiKeyOpen(false)} className="bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 px-3 py-2 rounded-lg text-sm font-semibold">取消</button>
            </div>
          </div>
        )}
        <form onSubmit={handleSaveManualPrice} className="p-4 grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_1fr_auto] gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">手動股票代號</label>
            <input value={manualPrice.symbol} onChange={(event) => setManualPrice((prev) => ({ ...prev, symbol: event.target.value.toUpperCase() }))} placeholder="VOO" className="w-full min-h-10 p-2 border rounded-lg text-sm uppercase" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">價格</label>
            <input type="number" min="0" step="0.0001" value={manualPrice.price} onChange={(event) => setManualPrice((prev) => ({ ...prev, price: event.target.value }))} className="w-full min-h-10 p-2 border rounded-lg text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">貨幣</label>
            <input value={manualPrice.currency} onChange={(event) => setManualPrice((prev) => ({ ...prev, currency: event.target.value.toUpperCase() }))} className="w-full min-h-10 p-2 border rounded-lg text-sm uppercase" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">As of</label>
            <input type="date" value={manualPrice.asOf} onChange={(event) => setManualPrice((prev) => ({ ...prev, asOf: event.target.value }))} className="w-full min-h-10 p-2 border rounded-lg text-sm" />
          </div>
          <button type="submit" className="bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 min-h-10">
            <Save size={16} /> 儲存價格
          </button>
        </form>
        {(quoteError || quoteResult) && (
          <div className={`mx-4 mb-4 rounded-lg border px-3 py-2 text-sm ${quoteError ? 'bg-red-50 border-red-100 text-red-700' : 'bg-emerald-50 border-emerald-100 text-emerald-700'}`}>
            {quoteError || quoteResult}
          </div>
        )}
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
                    <div><p className="text-xs text-slate-500">Current Price</p><p className="font-semibold">{position.currentPrice == null ? '--' : money(position.currentPrice, position.currency)}</p></div>
                    <div><p className="text-xs text-slate-500">Market Value</p><p className="font-semibold">{position.marketValue == null ? '--' : money(position.marketValue, position.currency)}</p></div>
                    <div><p className="text-xs text-slate-500">剩餘成本</p><p className="font-semibold">{money(position.remainingCost, position.currency)}</p></div>
                    <div><p className="text-xs text-slate-500">Unrealized P&L</p><p className={`font-semibold ${toNumber(position.unrealizedPnl) >= 0 ? 'text-green-600' : 'text-red-600'}`}>{position.unrealizedPnl == null ? '--' : signedMoney(position.unrealizedPnl, position.currency)}</p></div>
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
                    <th className="p-3 text-right">Current Price</th>
                    <th className="p-3 text-right">Market Value</th>
                    <th className="p-3 text-right">Unrealized P&L</th>
                    <th className="p-3 text-right">已實現盈虧</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {isLoading ? (
                    <tr><td colSpan="8" className="p-6 text-center text-slate-400"><Loader2 className="animate-spin inline mr-2" size={16} />載入中...</td></tr>
                  ) : positionsWithPrices.length === 0 ? (
                    <tr><td colSpan="8" className="p-6 text-center text-slate-400">未有股票交易。</td></tr>
                  ) : positionsWithPrices.map((position) => (
                    <tr key={position.symbol} className="hover:bg-slate-50">
                      <td className="p-3 font-bold text-slate-800">{position.symbol}<div className="text-[10px] text-slate-400 font-normal">{position.name || position.currency}{position.priceAsOf ? ` · ${formatDateTime(position.priceAsOf)}` : ''}</div></td>
                      <td className="p-3 text-right font-medium">{number(position.quantity)}</td>
                      <td className="p-3 text-right">{money(position.averageCost, position.currency)}</td>
                      <td className="p-3 text-right">{money(position.remainingCost, position.currency)}</td>
                      <td className={`p-3 text-right ${position.isPriceStale ? 'text-amber-600' : 'text-slate-700'}`}>{position.currentPrice == null ? '--' : money(position.currentPrice, position.currency)}</td>
                      <td className="p-3 text-right">{position.marketValue == null ? '--' : money(position.marketValue, position.currency)}</td>
                      <td className={`p-3 text-right font-bold ${position.unrealizedPnl == null ? 'text-slate-400' : position.unrealizedPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>{position.unrealizedPnl == null ? '--' : signedMoney(position.unrealizedPnl, position.currency)}</td>
                      <td className={`p-3 text-right font-bold ${position.realizedPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>{signedMoney(position.realizedPnl, position.currency)}</td>
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
