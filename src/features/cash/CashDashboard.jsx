import React, { useEffect, useMemo, useState } from 'react';
import { Banknote, DollarSign, Loader2, MinusCircle, Plus, Receipt, Trash2, Wallet } from 'lucide-react';
import { subscribeStockTrades } from '../stocks/stockFirestore';
import { toNumber } from '../stocks/stockCalculations';
import {
  CASH_MOVEMENT_TYPE_LABELS,
  CASH_MOVEMENT_TYPES,
  calculatePortfolioCashSummary,
  getCashMovementImpact,
  hasNumericValue,
} from './cashCalculations';
import {
  defaultCashMovementForm,
  deleteCashMovement,
  normalizeCashMovementForStorage,
  saveCashMovement,
  subscribeCashMovements,
} from './cashFirestore';

const money = (value, currency = 'USD') =>
  `${currency} ${toNumber(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const signedMoney = (value, currency = 'USD') => {
  const amount = toNumber(value);
  return `${amount >= 0 ? '+' : ''}${money(amount, currency)}`;
};

const isValidOptionalNumber = (value) => value === '' || value === null || value === undefined || Number.isFinite(Number(value));

export default function CashDashboard({ db, user }) {
  const [cashMovements, setCashMovements] = useState([]);
  const [stockTrades, setStockTrades] = useState([]);
  const [formData, setFormData] = useState(defaultCashMovementForm);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingCash, setIsLoadingCash] = useState(true);
  const [isLoadingStocks, setIsLoadingStocks] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!db || !user?.uid) return undefined;
    setIsLoadingCash(true);
    return subscribeCashMovements(
      db,
      user.uid,
      (movements) => {
        setCashMovements(movements);
        setError('');
        setIsLoadingCash(false);
      },
      (err) => {
        setError(err.message || 'Unable to load cash movements.');
        setIsLoadingCash(false);
      },
    );
  }, [db, user?.uid]);

  useEffect(() => {
    if (!db || !user?.uid) return undefined;
    setIsLoadingStocks(true);
    return subscribeStockTrades(
      db,
      user.uid,
      (trades) => {
        setStockTrades(trades);
        setIsLoadingStocks(false);
      },
      (err) => {
        setError(err.message || 'Unable to load stock trades.');
        setIsLoadingStocks(false);
      },
    );
  }, [db, user?.uid]);

  const summary = useMemo(() => calculatePortfolioCashSummary(cashMovements, stockTrades), [cashMovements, stockTrades]);
  const isLoading = isLoadingCash || isLoadingStocks;

  const update = (field, value) => setFormData((prev) => ({ ...prev, [field]: value }));

  const validateForm = (movement) => {
    if (!movement.date) return '請輸入日期。';
    if (!CASH_MOVEMENT_TYPES.includes(movement.type)) return '請選擇有效現金類型。';
    if (!movement.currency) return '請輸入貨幣。';

    const amountProvided = hasNumericValue(movement.amount);
    const grossProvided = hasNumericValue(movement.grossAmount);
    const netProvided = hasNumericValue(movement.netAmount);
    const withholdingProvided = hasNumericValue(movement.withholdingTax);
    const numberFields = ['amount', 'grossAmount', 'netAmount', 'withholdingTax'];
    const invalidField = numberFields.find((field) => !isValidOptionalNumber(movement[field]));
    if (invalidField) return `${invalidField} 必須是有效數字。`;

    if (movement.type === 'dividend') {
      if (!amountProvided && !grossProvided && !netProvided) return 'Dividend 至少需要 amount、netAmount 或 grossAmount 其中一項。';
      if (amountProvided && toNumber(movement.amount) < 0) return 'Dividend amount 不應為負數。';
      if (grossProvided && toNumber(movement.grossAmount) < 0) return 'Dividend grossAmount 不應為負數。';
      if (netProvided && toNumber(movement.netAmount) < 0) return 'Dividend netAmount 不應為負數。';
      if (withholdingProvided && toNumber(movement.withholdingTax) < 0) return 'Dividend withholdingTax 不應為負數。';
      return '';
    }

    if (!amountProvided) return '請輸入 amount。';
    if (movement.type !== 'adjustment' && toNumber(movement.amount) < 0) return '除 adjustment 外，amount 不應為負數。';
    return '';
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!user?.uid) return;

    const validationError = validateForm(formData);
    if (validationError) {
      setError(validationError);
      return;
    }

    const normalized = normalizeCashMovementForStorage(formData, user.uid);
    setIsSaving(true);
    try {
      await saveCashMovement(db, user.uid, normalized);
      setFormData(defaultCashMovementForm());
      setError('');
    } catch (err) {
      setError(err.message || 'Unable to save cash movement.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (movementId) => {
    if (!user?.uid) return;
    const confirmed = window.confirm('Delete this cash movement?');
    if (!confirmed) return;

    try {
      await deleteCashMovement(db, user.uid, movementId);
      setError('');
    } catch (err) {
      setError(err.message || 'Unable to delete cash movement.');
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="bg-slate-900 text-white rounded-2xl shadow-lg p-5 sm:p-6 relative overflow-hidden">
        <div className="absolute -top-6 -right-6 opacity-10 pointer-events-none"><Banknote size={160} /></div>
        <p className="text-slate-300 text-xs sm:text-sm font-medium mb-1.5">Cash Ledger / 現金流水帳</p>
        <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">Firstrade USD Cash</h2>
        <p className="text-slate-300 text-sm mt-2 max-w-2xl">記錄入金、出金、股息、預扣稅、利息、非交易費用及手動調整，並合併股票交易現金影響。</p>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-6 gap-3 sm:gap-4">
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3">
          <div className={`p-2.5 rounded-lg ${summary.calculatedCashBalance >= 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}><Wallet size={20} /></div>
          <div><p className="text-[11px] text-slate-500 font-medium">Calculated Cash</p><p className={`text-lg font-bold ${summary.calculatedCashBalance >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{signedMoney(summary.calculatedCashBalance)}</p></div>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3">
          <div className="p-2.5 bg-blue-50 text-blue-600 rounded-lg"><Banknote size={20} /></div>
          <div><p className="text-[11px] text-slate-500 font-medium">Cash Movements</p><p className="text-lg font-bold text-slate-800">{signedMoney(summary.cashMovementsTotal)}</p></div>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3">
          <div className={`p-2.5 rounded-lg ${summary.stockTradeCashImpact >= 0 ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`}><Receipt size={20} /></div>
          <div><p className="text-[11px] text-slate-500 font-medium">Stock Cash Impact</p><p className={`text-lg font-bold ${summary.stockTradeCashImpact >= 0 ? 'text-green-600' : 'text-red-600'}`}>{signedMoney(summary.stockTradeCashImpact)}</p></div>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3">
          <div className="p-2.5 bg-emerald-50 text-emerald-600 rounded-lg"><DollarSign size={20} /></div>
          <div><p className="text-[11px] text-slate-500 font-medium">Dividend Net</p><p className="text-lg font-bold text-slate-800">{money(summary.dividendNetReceived)}</p></div>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3">
          <div className="p-2.5 bg-amber-50 text-amber-600 rounded-lg"><MinusCircle size={20} /></div>
          <div><p className="text-[11px] text-slate-500 font-medium">Withholding Tax</p><p className="text-lg font-bold text-slate-800">{money(summary.dividendWithholdingTax)}</p></div>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3">
          <div className="p-2.5 bg-slate-100 text-slate-600 rounded-lg"><Receipt size={20} /></div>
          <div><p className="text-[11px] text-slate-500 font-medium">Fees</p><p className="text-lg font-bold text-slate-800">{money(summary.fees)}</p></div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr] gap-4">
        <form onSubmit={handleSubmit} className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
          <div className="p-4 border-b border-slate-100">
            <h3 className="text-base font-bold text-slate-800 flex items-center gap-2"><Plus size={18} className="text-blue-600" />新增現金流水</h3>
            <p className="text-xs text-slate-500 mt-1">交易買賣 cash impact 會自動從 Stock Ledger 合併，不需要在這裡重複輸入。</p>
          </div>
          <div className="p-4 grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-slate-500 mb-1">Type</label>
              <select value={formData.type} onChange={(e) => update('type', e.target.value)} className="w-full p-2 border rounded-lg text-sm">
                {CASH_MOVEMENT_TYPES.map((type) => <option key={type} value={type}>{CASH_MOVEMENT_TYPE_LABELS[type]}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Date</label>
              <input required type="date" value={formData.date} onChange={(e) => update('date', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Currency</label>
              <input value={formData.currency} onChange={(e) => update('currency', e.target.value.toUpperCase())} className="w-full p-2 border rounded-lg text-sm uppercase" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-slate-500 mb-1">Symbol optional</label>
              <input value={formData.symbol} onChange={(e) => update('symbol', e.target.value.toUpperCase())} placeholder="VOO" className="w-full p-2 border rounded-lg text-sm uppercase" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Amount</label>
              <input type="number" step="0.01" value={formData.amount} onChange={(e) => update('amount', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Gross Amount</label>
              <input type="number" min="0" step="0.01" value={formData.grossAmount} onChange={(e) => update('grossAmount', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Withholding Tax</label>
              <input type="number" min="0" step="0.01" value={formData.withholdingTax} onChange={(e) => update('withholdingTax', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Net Amount</label>
              <input type="number" min="0" step="0.01" value={formData.netAmount} onChange={(e) => update('netAmount', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-slate-500 mb-1">Notes optional</label>
              <textarea value={formData.notes} onChange={(e) => update('notes', e.target.value)} rows={2} className="w-full p-2 border rounded-lg text-sm" />
            </div>
          </div>
          <div className="p-4 border-t bg-slate-50 flex justify-end">
            <button disabled={isSaving} className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2">
              {isSaving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Save Movement
            </button>
          </div>
        </form>

        <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
          <div className="p-4 border-b border-slate-100 flex justify-between items-center">
            <h3 className="text-base font-bold text-slate-800">現金流水列表</h3>
            <span className="text-xs text-slate-500">{cashMovements.length} movements</span>
          </div>
          {error && <p className="m-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg p-3">{error}</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                <tr>
                  <th className="p-3 text-left">Date</th>
                  <th className="p-3 text-left">Type</th>
                  <th className="p-3 text-left">Symbol</th>
                  <th className="p-3 text-right">Amount</th>
                  <th className="p-3 text-right">Cash Impact</th>
                  <th className="p-3 text-left">Notes</th>
                  <th className="p-3 text-center">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {isLoading ? (
                  <tr><td colSpan="7" className="p-6 text-center text-slate-400"><Loader2 className="animate-spin inline mr-2" size={16} />Loading...</td></tr>
                ) : cashMovements.length === 0 ? (
                  <tr><td colSpan="7" className="p-6 text-center text-slate-400">未有現金流水。</td></tr>
                ) : cashMovements.map((movement) => {
                  const cashImpact = getCashMovementImpact(movement);
                  return (
                    <tr key={movement.id} className="hover:bg-slate-50">
                      <td className="p-3 whitespace-nowrap">{movement.date}<div className="text-[10px] text-slate-400">{movement.accountId || 'firstrade'}</div></td>
                      <td className="p-3"><span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-200 text-slate-700">{CASH_MOVEMENT_TYPE_LABELS[movement.type] || movement.type}</span></td>
                      <td className="p-3 font-bold">{movement.symbol || '--'}</td>
                      <td className="p-3 text-right">{money(movement.amount, movement.currency)}</td>
                      <td className={`p-3 text-right font-bold ${cashImpact >= 0 ? 'text-green-600' : 'text-red-600'}`}>{signedMoney(cashImpact, movement.currency)}</td>
                      <td className="p-3 max-w-[240px] truncate text-slate-500" title={movement.notes || ''}>{movement.notes || '--'}</td>
                      <td className="p-3 text-center">
                        <button onClick={() => handleDelete(movement.id)} className="text-red-500 hover:bg-red-50 p-1.5 rounded" title="Delete movement">
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
  );
}
