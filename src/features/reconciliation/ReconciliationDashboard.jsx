import React, { useEffect, useMemo, useState } from 'react';
import { ClipboardCheck, History, Loader2, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { calculatePortfolioCashSummary } from '../cash/cashCalculations.js';
import { subscribeCashMovements } from '../cash/cashFirestore.js';
import { calculateStockPositions, toNumber } from '../stocks/stockCalculations.js';
import { subscribeStockTrades } from '../stocks/stockFirestore.js';
import { CASH_STATUS, buildReconciliationReport } from './reconciliationCalculations.js';
import {
  defaultHoldingRow,
  defaultReconciliationSnapshotForm,
  deleteReconciliationSnapshot,
  normalizeReconciliationSnapshotForStorage,
  saveReconciliationSnapshot,
  subscribeReconciliationSnapshots,
} from './reconciliationFirestore.js';

const isBlankDisplayValue = (value) => value === '' || value === null || value === undefined || !Number.isFinite(Number(value));

const money = (value, currency = 'USD') =>
  isBlankDisplayValue(value)
    ? '--'
    : `${currency} ${toNumber(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const signedMoney = (value, currency = 'USD') => {
  if (isBlankDisplayValue(value)) return '--';
  const amount = toNumber(value);
  return `${amount >= 0 ? '+' : ''}${money(amount, currency)}`;
};

const shares = (value) => toNumber(value).toLocaleString(undefined, { maximumFractionDigits: 6 });

const statusClass = (status) => {
  if (status === 'OK') return 'bg-emerald-50 text-emerald-700 border-emerald-100';
  if (status === CASH_STATUS.AWAITING_INPUT) return 'bg-slate-50 text-slate-600 border-slate-200';
  if (status === 'SMALL_DIFF') return 'bg-amber-50 text-amber-700 border-amber-100';
  if (status === 'MISSING_IN_BROKER' || status === 'MISSING_IN_SYSTEM') return 'bg-orange-50 text-orange-700 border-orange-100';
  return 'bg-red-50 text-red-700 border-red-100';
};

const cashStatusLabel = (status) => {
  if (status === CASH_STATUS.AWAITING_INPUT) return '未輸入';
  if (status === CASH_STATUS.OK) return '正常';
  if (status === CASH_STATUS.SMALL_DIFF) return '小額差異';
  if (status === CASH_STATUS.DIFF) return '有差異';
  return status;
};

const holdingStatusLabel = (status) => ({
  OK: '正常',
  QTY_DIFF: '股數差異',
  COST_DIFF: '成本差異',
  MISSING_IN_BROKER: '券商缺少',
  MISSING_IN_SYSTEM: '系統缺少',
}[status] || status);

const isOptionalNumber = (value) => value === '' || value === null || value === undefined || Number.isFinite(Number(value));
const isRequiredNumber = (value) => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));

export default function ReconciliationDashboard({ db, user }) {
  const [stockTrades, setStockTrades] = useState([]);
  const [cashMovements, setCashMovements] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [formData, setFormData] = useState(defaultReconciliationSnapshotForm);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!db || !user?.uid) return undefined;
    return subscribeStockTrades(db, user.uid, setStockTrades, (err) => setError(err.message || '未能載入美股交易。'));
  }, [db, user?.uid]);

  useEffect(() => {
    if (!db || !user?.uid) return undefined;
    return subscribeCashMovements(db, user.uid, setCashMovements, (err) => setError(err.message || '未能載入現金流水。'));
  }, [db, user?.uid]);

  useEffect(() => {
    if (!db || !user?.uid) return undefined;
    setIsLoading(true);
    return subscribeReconciliationSnapshots(
      db,
      user.uid,
      (items) => {
        setSnapshots(items);
        setIsLoading(false);
      },
      (err) => {
        setError(err.message || '未能載入對帳快照。');
        setIsLoading(false);
      },
    );
  }, [db, user?.uid]);

  const systemPositions = useMemo(() => calculateStockPositions(stockTrades), [stockTrades]);
  const systemCashSummary = useMemo(() => calculatePortfolioCashSummary(cashMovements, stockTrades), [cashMovements, stockTrades]);
  const reportSnapshot = useMemo(
    () => ({
      accountId: formData.accountId || 'firstrade',
      date: formData.date,
      currency: formData.currency || 'USD',
      brokerCashBalance: formData.brokerCashBalance,
      brokerTotalMarketValue: formData.brokerTotalMarketValue,
      brokerTotalAccountValue: formData.brokerTotalAccountValue,
      notes: formData.notes || '',
      holdings: (formData.holdings || [])
        .filter((holding) => String(holding.symbol || '').trim())
        .map((holding) => ({
          symbol: holding.symbol,
          brokerQuantity: holding.brokerQuantity,
          brokerCostBasis: holding.brokerCostBasis,
          brokerMarketValue: holding.brokerMarketValue,
          notes: holding.notes || '',
        })),
    }),
    [formData],
  );
  const report = useMemo(
    () => buildReconciliationReport({ snapshot: reportSnapshot, stockTrades, cashMovements }),
    [reportSnapshot, stockTrades, cashMovements],
  );

  const update = (field, value) => setFormData((prev) => ({ ...prev, [field]: value }));
  const updateHolding = (index, field, value) => {
    setFormData((prev) => ({
      ...prev,
      holdings: prev.holdings.map((holding, i) => (i === index ? { ...holding, [field]: field === 'symbol' ? value.toUpperCase() : value } : holding)),
    }));
  };

  const addHoldingRow = () => setFormData((prev) => ({ ...prev, holdings: [...prev.holdings, defaultHoldingRow()] }));
  const removeHoldingRow = (index) => setFormData((prev) => ({ ...prev, holdings: prev.holdings.filter((_, i) => i !== index) }));

  const loadSystemHoldings = () => {
    setFormData((prev) => ({
      ...prev,
      holdings: systemPositions.map((position) => ({
        symbol: position.symbol,
        brokerQuantity: '',
        brokerCostBasis: '',
        brokerMarketValue: '',
        notes: '',
      })),
    }));
  };

  const loadSnapshot = (snapshot) => {
    setSelectedSnapshotId(snapshot.id);
    setFormData({
      accountId: snapshot.accountId || 'firstrade',
      date: snapshot.date,
      currency: snapshot.currency || 'USD',
      brokerCashBalance: snapshot.brokerCashBalance ?? '',
      brokerTotalMarketValue: snapshot.brokerTotalMarketValue ?? '',
      brokerTotalAccountValue: snapshot.brokerTotalAccountValue ?? '',
      notes: snapshot.notes || '',
      holdings: (snapshot.holdings || []).map((holding) => ({
        symbol: holding.symbol || '',
        brokerQuantity: holding.brokerQuantity ?? '',
        brokerCostBasis: holding.brokerCostBasis ?? '',
        brokerMarketValue: holding.brokerMarketValue ?? '',
        notes: holding.notes || '',
      })),
    });
    setError('');
  };

  const resetForm = () => {
    setSelectedSnapshotId('');
    setFormData(defaultReconciliationSnapshotForm());
    setError('');
  };

  const validateSnapshot = () => {
    if (!formData.date) return '請輸入對帳日期。';
    if (!isRequiredNumber(formData.brokerCashBalance)) return '券商現金餘額必須是有效數字。';
    if (!isOptionalNumber(formData.brokerTotalMarketValue)) return '券商市值必須是有效數字。';
    if (!isOptionalNumber(formData.brokerTotalAccountValue)) return '券商帳戶總值必須是有效數字。';

    const seenSymbols = new Set();
    for (const holding of formData.holdings) {
      const symbol = String(holding.symbol || '').trim().toUpperCase();
      if (!symbol) continue;
      if (seenSymbols.has(symbol)) return `持倉 symbol 重複：${symbol}`;
      seenSymbols.add(symbol);
      if (!isRequiredNumber(holding.brokerQuantity) || Number(holding.brokerQuantity) < 0) return `${symbol} 券商股數必須是非負數字。`;
      if (!isOptionalNumber(holding.brokerCostBasis) || Number(holding.brokerCostBasis || 0) < 0) return `${symbol} 券商成本不可為負數。`;
      if (!isOptionalNumber(holding.brokerMarketValue) || Number(holding.brokerMarketValue || 0) < 0) return `${symbol} 券商市值不可為負數。`;
    }
    return '';
  };

  const handleSave = async (event) => {
    event.preventDefault();
    if (!user?.uid) return;
    const validationError = validateSnapshot();
    if (validationError) {
      setError(validationError);
      return;
    }

    const normalized = normalizeReconciliationSnapshotForStorage(
      {
        ...formData,
        id: undefined,
        createdAt: undefined,
        holdings: (formData.holdings || []).filter((holding) => String(holding.symbol || '').trim()),
      },
      user.uid,
      null,
    );
    setIsSaving(true);
    try {
      await saveReconciliationSnapshot(db, user.uid, normalized);
      resetForm();
      setError('');
    } catch (err) {
      setError(err.message || '未能儲存對帳快照。');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteSnapshot = async (snapshotId) => {
    if (!user?.uid) return;
    const confirmed = window.confirm('刪除此個對帳快照？');
    if (!confirmed) return;
    try {
      await deleteReconciliationSnapshot(db, user.uid, snapshotId);
      if (selectedSnapshotId === snapshotId) resetForm();
    } catch (err) {
      setError(err.message || '未能刪除對帳快照。');
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="bg-slate-900 text-white rounded-xl shadow-sm p-4 sm:p-5 relative overflow-hidden">
        <div className="absolute -top-4 -right-4 opacity-5 pointer-events-none"><ClipboardCheck size={112} /></div>
        <p className="text-slate-300 text-xs sm:text-sm font-medium mb-1.5">券商手動對帳</p>
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight">券商快照 vs 系統帳本</h2>
        <p className="text-slate-300 text-xs sm:text-sm mt-1.5 max-w-2xl">手動輸入券商現金及持倉快照，對比系統由美股 / ETF 交易總帳及現金流水帳計算出的結果。如使用 Firstrade，可直接參考 Firstrade 顯示的現金、股數及成本。</p>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
        <div className={`bg-white p-4 rounded-xl shadow-sm border ${statusClass(report.cashComparison.status)}`}>
          <p className="text-[11px] font-medium">現金狀態</p>
          <p className="text-xl font-bold">{cashStatusLabel(report.cashComparison.status)}</p>
          <p className="text-[11px] mt-1">
            {report.cashComparison.status === CASH_STATUS.AWAITING_INPUT
              ? '尚未輸入券商現金'
              : `差額 ${signedMoney(report.cashComparison.difference, formData.currency || 'USD')}`}
          </p>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
          <p className="text-[11px] text-slate-500 font-medium">差異項目</p>
          <p className="text-xl font-bold text-red-600">{report.summary.issueCount}</p>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
          <p className="text-[11px] text-slate-500 font-medium">正常項目</p>
          <p className="text-xl font-bold text-emerald-600">{report.summary.okCount}</p>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
          <p className="text-[11px] text-slate-500 font-medium">總成本差異</p>
          <p className={`text-xl font-bold ${report.summary.totalCostDifference >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{signedMoney(report.summary.totalCostDifference, formData.currency || 'USD')}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(360px,460px)_1fr] gap-4">
        <form onSubmit={handleSave} className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
          <div className="p-4 border-b border-slate-100 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-bold text-slate-800">{selectedSnapshotId ? '已載入快照' : '新對帳快照'}</h3>
              <p className="text-xs text-slate-500 mt-1">
                {selectedSnapshotId
                  ? '已載入快照作檢視用途；儲存會建立新快照，如需修改舊快照請先刪除再新增。'
                  : '手動輸入券商當日資料。'}
              </p>
            </div>
            <button type="button" onClick={resetForm} className="text-xs bg-slate-100 hover:bg-slate-200 px-3 py-2 rounded-lg font-semibold">新增</button>
          </div>
          <div className="p-4 sm:p-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">日期</label>
              <input required type="date" value={formData.date} onChange={(event) => update('date', event.target.value)} className="w-full min-h-10 p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">貨幣</label>
              <input value={formData.currency} onChange={(event) => update('currency', event.target.value.toUpperCase())} className="w-full min-h-10 p-2 border rounded-lg text-sm uppercase" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-500 mb-1">券商現金餘額</label>
              <input required type="number" step="0.01" value={formData.brokerCashBalance} onChange={(event) => update('brokerCashBalance', event.target.value)} className="w-full min-h-10 p-2 border rounded-lg text-sm" />
              <p className="text-[11px] text-slate-500 mt-1">系統現金：{money(systemCashSummary.calculatedCashBalance, formData.currency || 'USD')}</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">券商市值</label>
              <input type="number" min="0" step="0.01" value={formData.brokerTotalMarketValue} onChange={(event) => update('brokerTotalMarketValue', event.target.value)} className="w-full min-h-10 p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">券商帳戶總值</label>
              <input type="number" min="0" step="0.01" value={formData.brokerTotalAccountValue} onChange={(event) => update('brokerTotalAccountValue', event.target.value)} className="w-full min-h-10 p-2 border rounded-lg text-sm" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-500 mb-1">備註</label>
              <textarea value={formData.notes} onChange={(event) => update('notes', event.target.value)} rows={2} className="w-full min-h-20 p-2 border rounded-lg text-sm" />
            </div>
          </div>

          <div className="px-4 pb-4">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-bold text-slate-800">券商持倉</h4>
              <div className="flex gap-2">
                <button type="button" onClick={loadSystemHoldings} className="text-xs bg-slate-100 hover:bg-slate-200 px-2.5 py-1.5 rounded-md font-semibold flex items-center gap-1"><RefreshCw size={13} />載入系統持倉</button>
                <button type="button" onClick={addHoldingRow} className="text-xs bg-blue-50 hover:bg-blue-100 text-blue-700 px-2.5 py-1.5 rounded-md font-semibold flex items-center gap-1"><Plus size={13} />新增一行</button>
              </div>
            </div>
            <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
              {formData.holdings.length === 0 ? (
                <p className="text-sm text-slate-400 bg-slate-50 rounded-lg p-3">尚未輸入券商持倉。</p>
              ) : formData.holdings.map((holding, index) => (
                <div key={`${holding.symbol || 'row'}-${index}`} className="grid grid-cols-1 sm:grid-cols-2 gap-2 border rounded-lg p-3 bg-slate-50/70">
                  <input value={holding.symbol} onChange={(event) => updateHolding(index, 'symbol', event.target.value)} placeholder="Symbol" className="min-h-10 p-2 border rounded-md text-sm uppercase" />
                  <input type="number" min="0" step="0.000001" value={holding.brokerQuantity} onChange={(event) => updateHolding(index, 'brokerQuantity', event.target.value)} placeholder="券商股數" className="min-h-10 p-2 border rounded-md text-sm" />
                  <input type="number" min="0" step="0.01" value={holding.brokerCostBasis} onChange={(event) => updateHolding(index, 'brokerCostBasis', event.target.value)} placeholder="成本（可選）" className="min-h-10 p-2 border rounded-md text-sm" />
                  <input type="number" min="0" step="0.01" value={holding.brokerMarketValue} onChange={(event) => updateHolding(index, 'brokerMarketValue', event.target.value)} placeholder="市值（可選）" className="min-h-10 p-2 border rounded-md text-sm" />
                  <input value={holding.notes} onChange={(event) => updateHolding(index, 'notes', event.target.value)} placeholder="備註（可選）" className="sm:col-span-2 min-h-10 p-2 border rounded-md text-sm" />
                  <button type="button" onClick={() => removeHoldingRow(index)} className="sm:col-span-2 text-xs text-red-600 hover:bg-red-50 rounded-md py-2 font-semibold">刪除此行</button>
                </div>
              ))}
            </div>
          </div>

          {error && <p className="mx-4 mb-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg p-3">{error}</p>}
          <div className="p-4 border-t bg-slate-50 flex justify-end">
            <button disabled={isSaving} className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2">
              {isSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} 儲存新對帳快照
            </button>
          </div>
        </form>

        <div className="space-y-4">
          <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="p-4 border-b border-slate-100">
              <h3 className="text-base font-bold text-slate-800">現金對帳</h3>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 p-4">
              <div className="p-3 rounded-lg bg-slate-50 border"><p className="text-[11px] text-slate-500">系統現金</p><p className="font-bold">{money(report.cashComparison.systemCashBalance, formData.currency || 'USD')}</p></div>
              <div className="p-3 rounded-lg bg-slate-50 border"><p className="text-[11px] text-slate-500">券商現金</p><p className="font-bold">{money(report.cashComparison.brokerCashBalance, formData.currency || 'USD')}</p></div>
              <div className={`p-3 rounded-lg border ${statusClass(report.cashComparison.status)}`}>
                <p className="text-[11px]">{report.cashComparison.status === CASH_STATUS.AWAITING_INPUT ? '未輸入' : '差額'}</p>
                <p className="font-bold">{signedMoney(report.cashComparison.difference, formData.currency || 'USD')}</p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-800">持倉對帳</h3>
              <span className="text-xs text-slate-500">{report.holdingComparisons.length} 個 symbol</span>
            </div>
            <div className="md:hidden divide-y divide-slate-100">
              {report.holdingComparisons.length === 0 ? (
                <div className="p-6 text-center text-slate-400">沒有持倉可對帳。</div>
              ) : report.holdingComparisons.map((item) => (
                <div key={item.symbol} className="p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-bold text-slate-900">{item.symbol}</p>
                    <span className={`px-2 py-0.5 rounded border text-[10px] font-bold ${statusClass(item.status)}`}>{holdingStatusLabel(item.status)}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div><p className="text-xs text-slate-500">系統股數</p><p className="font-semibold">{shares(item.systemQuantity)}</p></div>
                    <div><p className="text-xs text-slate-500">券商股數</p><p className="font-semibold">{shares(item.brokerQuantity)}</p></div>
                    <div><p className="text-xs text-slate-500">股數差異</p><p className={Math.abs(item.quantityDifference) <= 0.000001 ? 'font-semibold text-slate-700' : 'font-semibold text-red-600'}>{shares(item.quantityDifference)}</p></div>
                    <div><p className="text-xs text-slate-500">成本差異</p><p className={item.costDifference === null || Math.abs(item.costDifference) <= 0.01 ? 'font-semibold text-slate-700' : 'font-semibold text-red-600'}>{item.costDifference === null ? '--' : signedMoney(item.costDifference, formData.currency || 'USD')}</p></div>
                    <div><p className="text-xs text-slate-500">系統成本</p><p className="font-semibold">{money(item.systemCostBasis, formData.currency || 'USD')}</p></div>
                    <div><p className="text-xs text-slate-500">券商成本</p><p className="font-semibold">{money(item.brokerCostBasis, formData.currency || 'USD')}</p></div>
                  </div>
                </div>
              ))}
            </div>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                  <tr>
                    <th className="p-3 text-left">Symbol</th>
                    <th className="p-3 text-right">系統股數</th>
                    <th className="p-3 text-right">券商股數</th>
                    <th className="p-3 text-right">股數差異</th>
                    <th className="p-3 text-right">系統成本</th>
                    <th className="p-3 text-right">券商成本</th>
                    <th className="p-3 text-right">成本差異</th>
                    <th className="p-3 text-right">券商市值</th>
                    <th className="p-3 text-left">狀態</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.holdingComparisons.length === 0 ? (
                    <tr><td colSpan="9" className="p-6 text-center text-slate-400">沒有持倉可對帳。</td></tr>
                  ) : report.holdingComparisons.map((item) => (
                    <tr key={item.symbol} className="hover:bg-slate-50">
                      <td className="p-3 font-bold">{item.symbol}</td>
                      <td className="p-3 text-right">{shares(item.systemQuantity)}</td>
                      <td className="p-3 text-right">{shares(item.brokerQuantity)}</td>
                      <td className={`p-3 text-right font-semibold ${Math.abs(item.quantityDifference) <= 0.000001 ? 'text-slate-600' : 'text-red-600'}`}>{shares(item.quantityDifference)}</td>
                      <td className="p-3 text-right">{money(item.systemCostBasis, formData.currency || 'USD')}</td>
                      <td className="p-3 text-right">{money(item.brokerCostBasis, formData.currency || 'USD')}</td>
                      <td className={`p-3 text-right font-semibold ${item.costDifference === null || Math.abs(item.costDifference) <= 0.01 ? 'text-slate-600' : 'text-red-600'}`}>{item.costDifference === null ? '--' : signedMoney(item.costDifference, formData.currency || 'USD')}</td>
                      <td className="p-3 text-right">{money(item.brokerMarketValue, formData.currency || 'USD')}</td>
                      <td className="p-3"><span className={`px-2 py-0.5 rounded border text-[10px] font-bold ${statusClass(item.status)}`}>{holdingStatusLabel(item.status)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center gap-2">
              <History size={16} className="text-slate-600" />
              <h3 className="text-base font-bold text-slate-800">對帳快照紀錄</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                  <tr>
                    <th className="p-3 text-left">日期</th>
                    <th className="p-3 text-right">券商現金</th>
                    <th className="p-3 text-right">持倉</th>
                    <th className="p-3 text-right">差異</th>
                    <th className="p-3 text-left">建立時間</th>
                    <th className="p-3 text-center">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {isLoading ? (
                    <tr><td colSpan="6" className="p-6 text-center text-slate-400"><Loader2 className="animate-spin inline mr-2" size={16} />載入中...</td></tr>
                  ) : snapshots.length === 0 ? (
                    <tr><td colSpan="6" className="p-6 text-center text-slate-400">尚未建立對帳快照。</td></tr>
                  ) : snapshots.map((snapshot) => {
                    const snapshotReport = buildReconciliationReport({ snapshot, stockTrades, cashMovements });
                    return (
                      <tr key={snapshot.id} className="hover:bg-slate-50">
                        <td className="p-3 font-medium">{snapshot.date}</td>
                        <td className="p-3 text-right">{money(snapshot.brokerCashBalance, snapshot.currency || 'USD')}</td>
                        <td className="p-3 text-right">{snapshot.holdings?.length || 0}</td>
                        <td className={`p-3 text-right font-bold ${snapshotReport.summary.issueCount === 0 ? 'text-emerald-600' : 'text-red-600'}`}>{snapshotReport.summary.issueCount}</td>
                        <td className="p-3 text-slate-500">{snapshot.createdAt ? new Date(snapshot.createdAt).toLocaleString() : '--'}</td>
                        <td className="p-3 text-center">
                          <div className="flex justify-center gap-2">
                            <button onClick={() => loadSnapshot(snapshot)} className="text-blue-600 hover:bg-blue-50 px-2 py-1 rounded text-xs font-semibold">載入</button>
                            <button onClick={() => handleDeleteSnapshot(snapshot.id)} className="text-red-500 hover:bg-red-50 p-1.5 rounded" title="刪除快照"><Trash2 size={16} /></button>
                          </div>
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
