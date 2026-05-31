import React, { useEffect, useMemo, useState } from 'react';
import { ClipboardCheck, History, Loader2, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { calculatePortfolioCashSummary } from '../cash/cashCalculations.js';
import { subscribeCashMovements } from '../cash/cashFirestore.js';
import { calculateStockPositions, toNumber } from '../stocks/stockCalculations.js';
import { subscribeStockTrades } from '../stocks/stockFirestore.js';
import { buildReconciliationReport } from './reconciliationCalculations.js';
import {
  defaultHoldingRow,
  defaultReconciliationSnapshotForm,
  deleteReconciliationSnapshot,
  normalizeReconciliationSnapshotForStorage,
  saveReconciliationSnapshot,
  subscribeReconciliationSnapshots,
} from './reconciliationFirestore.js';

const money = (value, currency = 'USD') =>
  value === null || value === undefined
    ? '--'
    : `${currency} ${toNumber(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const signedMoney = (value, currency = 'USD') => {
  const amount = toNumber(value);
  return `${amount >= 0 ? '+' : ''}${money(amount, currency)}`;
};

const shares = (value) => toNumber(value).toLocaleString(undefined, { maximumFractionDigits: 6 });

const statusClass = (status) => {
  if (status === 'OK') return 'bg-emerald-50 text-emerald-700 border-emerald-100';
  if (status === 'SMALL_DIFF') return 'bg-amber-50 text-amber-700 border-amber-100';
  if (status === 'MISSING_IN_BROKER' || status === 'MISSING_IN_SYSTEM') return 'bg-orange-50 text-orange-700 border-orange-100';
  return 'bg-red-50 text-red-700 border-red-100';
};

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
    return subscribeStockTrades(db, user.uid, setStockTrades, (err) => setError(err.message || 'Unable to load stock trades.'));
  }, [db, user?.uid]);

  useEffect(() => {
    if (!db || !user?.uid) return undefined;
    return subscribeCashMovements(db, user.uid, setCashMovements, (err) => setError(err.message || 'Unable to load cash movements.'));
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
        setError(err.message || 'Unable to load reconciliation snapshots.');
        setIsLoading(false);
      },
    );
  }, [db, user?.uid]);

  const systemPositions = useMemo(() => calculateStockPositions(stockTrades), [stockTrades]);
  const systemCashSummary = useMemo(() => calculatePortfolioCashSummary(cashMovements, stockTrades), [cashMovements, stockTrades]);
  const reportSnapshot = useMemo(
    () => normalizeReconciliationSnapshotForStorage({ ...formData, brokerCashBalance: formData.brokerCashBalance || 0 }, user?.uid || 'preview'),
    [formData, user?.uid],
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
      id: snapshot.id,
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
      createdAt: snapshot.createdAt,
    });
  };

  const resetForm = () => {
    setSelectedSnapshotId('');
    setFormData(defaultReconciliationSnapshotForm());
    setError('');
  };

  const validateSnapshot = () => {
    if (!formData.date) return '請輸入 snapshot date。';
    if (!isRequiredNumber(formData.brokerCashBalance)) return 'Broker Cash Balance 必須是有效數字。';
    if (!isOptionalNumber(formData.brokerTotalMarketValue)) return 'Broker Total Market Value 必須是有效數字。';
    if (!isOptionalNumber(formData.brokerTotalAccountValue)) return 'Broker Total Account Value 必須是有效數字。';

    const seenSymbols = new Set();
    for (const holding of formData.holdings) {
      const symbol = String(holding.symbol || '').trim().toUpperCase();
      if (!symbol) return 'Holdings symbol 不可留空。';
      if (seenSymbols.has(symbol)) return `Holdings symbol 重複：${symbol}`;
      seenSymbols.add(symbol);
      if (!isRequiredNumber(holding.brokerQuantity) || Number(holding.brokerQuantity) < 0) return `${symbol} brokerQuantity 必須是非負數字。`;
      if (!isOptionalNumber(holding.brokerCostBasis) || Number(holding.brokerCostBasis || 0) < 0) return `${symbol} brokerCostBasis 不可為負數。`;
      if (!isOptionalNumber(holding.brokerMarketValue) || Number(holding.brokerMarketValue || 0) < 0) return `${symbol} brokerMarketValue 不可為負數。`;
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

    const existing = selectedSnapshotId ? snapshots.find((snapshot) => snapshot.id === selectedSnapshotId) : null;
    const normalized = normalizeReconciliationSnapshotForStorage(formData, user.uid, existing);
    setIsSaving(true);
    try {
      await saveReconciliationSnapshot(db, user.uid, normalized);
      setSelectedSnapshotId(normalized.id);
      setFormData({
        ...normalized,
        brokerCashBalance: normalized.brokerCashBalance,
        brokerTotalMarketValue: normalized.brokerTotalMarketValue ?? '',
        brokerTotalAccountValue: normalized.brokerTotalAccountValue ?? '',
        holdings: normalized.holdings.map((holding) => ({
          ...holding,
          brokerCostBasis: holding.brokerCostBasis ?? '',
          brokerMarketValue: holding.brokerMarketValue ?? '',
        })),
      });
      setError('');
    } catch (err) {
      setError(err.message || 'Unable to save reconciliation snapshot.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteSnapshot = async (snapshotId) => {
    if (!user?.uid) return;
    const confirmed = window.confirm('Delete this reconciliation snapshot?');
    if (!confirmed) return;
    try {
      await deleteReconciliationSnapshot(db, user.uid, snapshotId);
      if (selectedSnapshotId === snapshotId) resetForm();
    } catch (err) {
      setError(err.message || 'Unable to delete reconciliation snapshot.');
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="bg-slate-900 text-white rounded-2xl shadow-lg p-5 sm:p-6 relative overflow-hidden">
        <div className="absolute -top-6 -right-6 opacity-10 pointer-events-none"><ClipboardCheck size={160} /></div>
        <p className="text-slate-300 text-xs sm:text-sm font-medium mb-1.5">Reconcile / 手動對帳</p>
        <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">Firstrade Snapshot vs System Ledger</h2>
        <p className="text-slate-300 text-sm mt-2 max-w-2xl">手動輸入 Firstrade 現金及持倉 snapshot，對比系統由 Stock Ledger + Cash Ledger 計算出的結果。</p>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
        <div className={`bg-white p-4 rounded-xl shadow-sm border ${statusClass(report.cashComparison.status)}`}>
          <p className="text-[11px] font-medium">Cash Status</p>
          <p className="text-xl font-bold">{report.cashComparison.status}</p>
          <p className="text-[11px] mt-1">Diff {signedMoney(report.cashComparison.difference, formData.currency || 'USD')}</p>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
          <p className="text-[11px] text-slate-500 font-medium">Issue Count</p>
          <p className="text-xl font-bold text-red-600">{report.summary.issueCount}</p>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
          <p className="text-[11px] text-slate-500 font-medium">OK Count</p>
          <p className="text-xl font-bold text-emerald-600">{report.summary.okCount}</p>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
          <p className="text-[11px] text-slate-500 font-medium">Total Cost Difference</p>
          <p className={`text-xl font-bold ${report.summary.totalCostDifference >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{signedMoney(report.summary.totalCostDifference, formData.currency || 'USD')}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[420px_1fr] gap-4">
        <form onSubmit={handleSave} className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
          <div className="p-4 border-b border-slate-100 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-bold text-slate-800">{selectedSnapshotId ? 'Edit Snapshot' : 'New Snapshot'}</h3>
              <p className="text-xs text-slate-500 mt-1">手動輸入 Firstrade 當日資料。</p>
            </div>
            <button type="button" onClick={resetForm} className="text-xs bg-slate-100 hover:bg-slate-200 px-3 py-2 rounded-lg font-semibold">New</button>
          </div>
          <div className="p-4 grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Date</label>
              <input required type="date" value={formData.date} onChange={(event) => update('date', event.target.value)} className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Currency</label>
              <input value={formData.currency} onChange={(event) => update('currency', event.target.value.toUpperCase())} className="w-full p-2 border rounded-lg text-sm uppercase" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-slate-500 mb-1">Broker Cash Balance</label>
              <input required type="number" step="0.01" value={formData.brokerCashBalance} onChange={(event) => update('brokerCashBalance', event.target.value)} className="w-full p-2 border rounded-lg text-sm" />
              <p className="text-[11px] text-slate-500 mt-1">System cash: {money(systemCashSummary.calculatedCashBalance, formData.currency || 'USD')}</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Broker Market Value</label>
              <input type="number" min="0" step="0.01" value={formData.brokerTotalMarketValue} onChange={(event) => update('brokerTotalMarketValue', event.target.value)} className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Broker Account Value</label>
              <input type="number" min="0" step="0.01" value={formData.brokerTotalAccountValue} onChange={(event) => update('brokerTotalAccountValue', event.target.value)} className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-slate-500 mb-1">Notes</label>
              <textarea value={formData.notes} onChange={(event) => update('notes', event.target.value)} rows={2} className="w-full p-2 border rounded-lg text-sm" />
            </div>
          </div>

          <div className="px-4 pb-4">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-bold text-slate-800">Holdings</h4>
              <div className="flex gap-2">
                <button type="button" onClick={loadSystemHoldings} className="text-xs bg-slate-100 hover:bg-slate-200 px-2.5 py-1.5 rounded-md font-semibold flex items-center gap-1"><RefreshCw size={13} />Load system</button>
                <button type="button" onClick={addHoldingRow} className="text-xs bg-blue-50 hover:bg-blue-100 text-blue-700 px-2.5 py-1.5 rounded-md font-semibold flex items-center gap-1"><Plus size={13} />Row</button>
              </div>
            </div>
            <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
              {formData.holdings.length === 0 ? (
                <p className="text-sm text-slate-400 bg-slate-50 rounded-lg p-3">No broker holdings entered.</p>
              ) : formData.holdings.map((holding, index) => (
                <div key={`${holding.symbol || 'row'}-${index}`} className="grid grid-cols-2 gap-2 border rounded-lg p-2 bg-slate-50/70">
                  <input value={holding.symbol} onChange={(event) => updateHolding(index, 'symbol', event.target.value)} placeholder="Symbol" className="p-2 border rounded-md text-sm uppercase" />
                  <input type="number" min="0" step="0.000001" value={holding.brokerQuantity} onChange={(event) => updateHolding(index, 'brokerQuantity', event.target.value)} placeholder="Broker Qty" className="p-2 border rounded-md text-sm" />
                  <input type="number" min="0" step="0.01" value={holding.brokerCostBasis} onChange={(event) => updateHolding(index, 'brokerCostBasis', event.target.value)} placeholder="Cost Basis optional" className="p-2 border rounded-md text-sm" />
                  <input type="number" min="0" step="0.01" value={holding.brokerMarketValue} onChange={(event) => updateHolding(index, 'brokerMarketValue', event.target.value)} placeholder="Market Value optional" className="p-2 border rounded-md text-sm" />
                  <input value={holding.notes} onChange={(event) => updateHolding(index, 'notes', event.target.value)} placeholder="Notes optional" className="col-span-2 p-2 border rounded-md text-sm" />
                  <button type="button" onClick={() => removeHoldingRow(index)} className="col-span-2 text-xs text-red-600 hover:bg-red-50 rounded-md py-1.5 font-semibold">Delete row</button>
                </div>
              ))}
            </div>
          </div>

          {error && <p className="mx-4 mb-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg p-3">{error}</p>}
          <div className="p-4 border-t bg-slate-50 flex justify-end">
            <button disabled={isSaving} className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2">
              {isSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Save Snapshot
            </button>
          </div>
        </form>

        <div className="space-y-4">
          <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="p-4 border-b border-slate-100">
              <h3 className="text-base font-bold text-slate-800">Cash Comparison</h3>
            </div>
            <div className="grid grid-cols-3 gap-2 p-4">
              <div className="p-3 rounded-lg bg-slate-50 border"><p className="text-[11px] text-slate-500">System Cash</p><p className="font-bold">{money(report.cashComparison.systemCashBalance, formData.currency || 'USD')}</p></div>
              <div className="p-3 rounded-lg bg-slate-50 border"><p className="text-[11px] text-slate-500">Broker Cash</p><p className="font-bold">{money(report.cashComparison.brokerCashBalance, formData.currency || 'USD')}</p></div>
              <div className={`p-3 rounded-lg border ${statusClass(report.cashComparison.status)}`}><p className="text-[11px]">Difference</p><p className="font-bold">{signedMoney(report.cashComparison.difference, formData.currency || 'USD')}</p></div>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-800">Holdings Comparison</h3>
              <span className="text-xs text-slate-500">{report.holdingComparisons.length} symbols</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                  <tr>
                    <th className="p-3 text-left">Symbol</th>
                    <th className="p-3 text-right">System Qty</th>
                    <th className="p-3 text-right">Broker Qty</th>
                    <th className="p-3 text-right">Qty Diff</th>
                    <th className="p-3 text-right">System Cost</th>
                    <th className="p-3 text-right">Broker Cost</th>
                    <th className="p-3 text-right">Cost Diff</th>
                    <th className="p-3 text-right">Broker MV</th>
                    <th className="p-3 text-left">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.holdingComparisons.length === 0 ? (
                    <tr><td colSpan="9" className="p-6 text-center text-slate-400">No holdings to compare.</td></tr>
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
                      <td className="p-3"><span className={`px-2 py-0.5 rounded border text-[10px] font-bold ${statusClass(item.status)}`}>{item.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center gap-2">
              <History size={16} className="text-slate-600" />
              <h3 className="text-base font-bold text-slate-800">Snapshot History</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                  <tr>
                    <th className="p-3 text-left">Date</th>
                    <th className="p-3 text-right">Broker Cash</th>
                    <th className="p-3 text-right">Holdings</th>
                    <th className="p-3 text-right">Issues</th>
                    <th className="p-3 text-left">Created</th>
                    <th className="p-3 text-center">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {isLoading ? (
                    <tr><td colSpan="6" className="p-6 text-center text-slate-400"><Loader2 className="animate-spin inline mr-2" size={16} />Loading...</td></tr>
                  ) : snapshots.length === 0 ? (
                    <tr><td colSpan="6" className="p-6 text-center text-slate-400">No snapshots saved.</td></tr>
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
                            <button onClick={() => loadSnapshot(snapshot)} className="text-blue-600 hover:bg-blue-50 px-2 py-1 rounded text-xs font-semibold">Load</button>
                            <button onClick={() => handleDeleteSnapshot(snapshot.id)} className="text-red-500 hover:bg-red-50 p-1.5 rounded" title="Delete snapshot"><Trash2 size={16} /></button>
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
