import React, { useEffect, useMemo, useState } from 'react';
import { Briefcase, DollarSign, Loader2, Plus, Trash2, TrendingUp, Wallet } from 'lucide-react';
import { calculateStockPortfolioTotals, calculateStockPositions, getStockTradeCashImpact, toNumber } from './stockCalculations';
import { defaultStockTradeForm, deleteStockTrade, normalizeStockTradeForStorage, saveStockTrade, subscribeStockTrades } from './stockFirestore';

const money = (value, currency = 'USD') =>
  `${currency} ${toNumber(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const number = (value, digits = 4) =>
  toNumber(value).toLocaleString(undefined, { maximumFractionDigits: digits });

const signedMoney = (value, currency = 'USD') => {
  const amount = toNumber(value);
  return `${amount >= 0 ? '+' : ''}${money(amount, currency)}`;
};

const sideLabel = (side) => (side === 'sell' ? '賣出' : '買入');

export default function StockDashboard({ db, user }) {
  const [stockTrades, setStockTrades] = useState([]);
  const [formData, setFormData] = useState(defaultStockTradeForm);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

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
        setError(err.message || 'Unable to load stock trades.');
        setIsLoading(false);
      },
    );
  }, [db, user?.uid]);

  const positions = useMemo(() => calculateStockPositions(stockTrades), [stockTrades]);
  const totals = useMemo(() => calculateStockPortfolioTotals(positions), [positions]);

  const update = (field, value) => setFormData((prev) => ({ ...prev, [field]: value }));

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!user?.uid) return;

    const normalized = normalizeStockTradeForStorage(formData, user.uid);
    if (!normalized.symbol || !normalized.tradeDate || normalized.quantity <= 0 || normalized.price < 0) {
      setError('請輸入有效 Symbol、日期、數量及價格。');
      return;
    }

    setIsSaving(true);
    try {
      await saveStockTrade(db, user.uid, normalized);
      setFormData(defaultStockTradeForm());
      setError('');
    } catch (err) {
      setError(err.message || 'Unable to save stock trade.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (tradeId) => {
    if (!user?.uid) return;
    const confirmed = window.confirm('Delete this stock trade?');
    if (!confirmed) return;

    try {
      await deleteStockTrade(db, user.uid, tradeId);
      setError('');
    } catch (err) {
      setError(err.message || 'Unable to delete stock trade.');
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="bg-slate-900 text-white rounded-2xl shadow-lg p-5 sm:p-6 relative overflow-hidden">
        <div className="absolute -top-6 -right-6 opacity-10 pointer-events-none"><Briefcase size={160} /></div>
        <p className="text-slate-300 text-xs sm:text-sm font-medium mb-1.5">Stock Ledger / 美股交易總帳</p>
        <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">Firstrade 股票及 ETF 交易紀錄</h2>
        <p className="text-slate-300 text-sm mt-2 max-w-2xl">由交易流水帳自動計算持倉、平均成本、已實現盈虧及現金影響。第一階段不接即時報價。</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3">
          <div className="p-2.5 bg-blue-50 text-blue-600 rounded-lg"><Briefcase size={20} /></div>
          <div><p className="text-[11px] text-slate-500 font-medium">Symbols</p><p className="text-lg font-bold text-slate-800">{positions.length}</p></div>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3">
          <div className="p-2.5 bg-emerald-50 text-emerald-600 rounded-lg"><DollarSign size={20} /></div>
          <div><p className="text-[11px] text-slate-500 font-medium">Remaining Cost</p><p className="text-lg font-bold text-slate-800">{money(totals.remainingCost)}</p></div>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3">
          <div className={`p-2.5 rounded-lg ${totals.realizedPnl >= 0 ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`}><TrendingUp size={20} /></div>
          <div><p className="text-[11px] text-slate-500 font-medium">Realized PnL</p><p className={`text-lg font-bold ${totals.realizedPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>{signedMoney(totals.realizedPnl)}</p></div>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3">
          <div className={`p-2.5 rounded-lg ${totals.cashImpact >= 0 ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`}><Wallet size={20} /></div>
          <div><p className="text-[11px] text-slate-500 font-medium">Cash Impact</p><p className={`text-lg font-bold ${totals.cashImpact >= 0 ? 'text-green-600' : 'text-red-600'}`}>{signedMoney(totals.cashImpact)}</p></div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr] gap-4">
        <form onSubmit={handleSubmit} className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
          <div className="p-4 border-b border-slate-100">
            <h3 className="text-base font-bold text-slate-800 flex items-center gap-2"><Plus size={18} className="text-blue-600" />新增股票交易</h3>
            <p className="text-xs text-slate-500 mt-1">Account 預設 Firstrade，可記錄美股及 ETF 買賣。</p>
          </div>
          <div className="p-4 grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-slate-500 mb-1">Symbol</label>
              <input required value={formData.symbol} onChange={(e) => update('symbol', e.target.value.toUpperCase())} placeholder="VOO" className="w-full p-2 border rounded-lg text-sm uppercase" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-slate-500 mb-1">Name optional</label>
              <input value={formData.name} onChange={(e) => update('name', e.target.value)} placeholder="Vanguard S&P 500 ETF" className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Side</label>
              <select value={formData.side} onChange={(e) => update('side', e.target.value)} className="w-full p-2 border rounded-lg text-sm">
                <option value="buy">買入</option>
                <option value="sell">賣出</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Date</label>
              <input required type="date" value={formData.tradeDate} onChange={(e) => update('tradeDate', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Time optional</label>
              <input type="time" value={formData.tradeTime} onChange={(e) => update('tradeTime', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Currency</label>
              <input value={formData.currency} onChange={(e) => update('currency', e.target.value.toUpperCase())} className="w-full p-2 border rounded-lg text-sm uppercase" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Quantity</label>
              <input required type="number" min="0" step="0.000001" value={formData.quantity} onChange={(e) => update('quantity', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Price</label>
              <input required type="number" min="0" step="0.0001" value={formData.price} onChange={(e) => update('price', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Commission</label>
              <input type="number" min="0" step="0.01" value={formData.commission} onChange={(e) => update('commission', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Fees</label>
              <input type="number" min="0" step="0.01" value={formData.fees} onChange={(e) => update('fees', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-slate-500 mb-1">Notes optional</label>
              <textarea value={formData.notes} onChange={(e) => update('notes', e.target.value)} rows={2} className="w-full p-2 border rounded-lg text-sm" />
            </div>
          </div>
          <div className="p-4 border-t bg-slate-50 flex justify-end">
            <button disabled={isSaving} className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2">
              {isSaving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Save Trade
            </button>
          </div>
        </form>

        <div className="space-y-4">
          <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex justify-between items-center">
              <h3 className="text-base font-bold text-slate-800">持倉 Summary</h3>
              <span className="text-xs text-slate-500">Average Cost basis</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                  <tr>
                    <th className="p-3 text-left">Symbol</th>
                    <th className="p-3 text-right">股數</th>
                    <th className="p-3 text-right">平均成本</th>
                    <th className="p-3 text-right">剩餘成本</th>
                    <th className="p-3 text-right">已實現盈虧</th>
                    <th className="p-3 text-right">未實現</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {isLoading ? (
                    <tr><td colSpan="6" className="p-6 text-center text-slate-400"><Loader2 className="animate-spin inline mr-2" size={16} />Loading...</td></tr>
                  ) : positions.length === 0 ? (
                    <tr><td colSpan="6" className="p-6 text-center text-slate-400">未有股票交易。</td></tr>
                  ) : positions.map((position) => (
                    <tr key={position.symbol} className="hover:bg-slate-50">
                      <td className="p-3 font-bold text-slate-800">{position.symbol}<div className="text-[10px] text-slate-400 font-normal">{position.name || position.currency}</div></td>
                      <td className="p-3 text-right font-medium">{number(position.quantity)}</td>
                      <td className="p-3 text-right">{money(position.averageCost, position.currency)}</td>
                      <td className="p-3 text-right">{money(position.remainingCost, position.currency)}</td>
                      <td className={`p-3 text-right font-bold ${position.realizedPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>{signedMoney(position.realizedPnl, position.currency)}</td>
                      <td className="p-3 text-right text-slate-400">N/A</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex justify-between items-center">
              <h3 className="text-base font-bold text-slate-800">交易紀錄</h3>
              <span className="text-xs text-slate-500">{stockTrades.length} trades</span>
            </div>
            {error && <p className="m-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg p-3">{error}</p>}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                  <tr>
                    <th className="p-3 text-left">日期</th>
                    <th className="p-3 text-left">類型</th>
                    <th className="p-3 text-left">Symbol</th>
                    <th className="p-3 text-right">數量</th>
                    <th className="p-3 text-right">價格</th>
                    <th className="p-3 text-right">手續費</th>
                    <th className="p-3 text-right">總額</th>
                    <th className="p-3 text-center">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {isLoading ? (
                    <tr><td colSpan="8" className="p-6 text-center text-slate-400"><Loader2 className="animate-spin inline mr-2" size={16} />Loading...</td></tr>
                  ) : stockTrades.length === 0 ? (
                    <tr><td colSpan="8" className="p-6 text-center text-slate-400">未有交易紀錄。</td></tr>
                  ) : stockTrades.map((trade) => {
                    const cashImpact = getStockTradeCashImpact(trade);
                    const tradeFees = toNumber(trade.commission) + toNumber(trade.fees);
                    return (
                      <tr key={trade.id} className="hover:bg-slate-50">
                        <td className="p-3 whitespace-nowrap">{trade.tradeDate}<div className="text-[10px] text-slate-400">{trade.tradeTime || trade.accountId || 'firstrade'}</div></td>
                        <td className="p-3"><span className={`px-2 py-0.5 rounded text-[10px] font-bold text-white ${trade.side === 'sell' ? 'bg-red-500' : 'bg-emerald-500'}`}>{sideLabel(trade.side)}</span></td>
                        <td className="p-3 font-bold">{trade.symbol}<div className="text-[10px] text-slate-400 font-normal">{trade.name || '--'}</div></td>
                        <td className="p-3 text-right">{number(trade.quantity)}</td>
                        <td className="p-3 text-right">{money(trade.price, trade.currency)}</td>
                        <td className="p-3 text-right">{money(tradeFees, trade.currency)}</td>
                        <td className={`p-3 text-right font-bold ${cashImpact >= 0 ? 'text-green-600' : 'text-red-600'}`}>{signedMoney(cashImpact, trade.currency)}</td>
                        <td className="p-3 text-center">
                          <button onClick={() => handleDelete(trade.id)} className="text-red-500 hover:bg-red-50 p-1.5 rounded" title="Delete trade">
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
