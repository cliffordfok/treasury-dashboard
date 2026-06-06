import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Briefcase, ClipboardCheck, DollarSign, Landmark, Loader2, Receipt, TrendingUp, Wallet } from 'lucide-react';
import { subscribeCashMovements } from '../cash/cashFirestore.js';
import { subscribeReconciliationSnapshots } from '../reconciliation/reconciliationFirestore.js';
import { subscribeStockTrades } from '../stocks/stockFirestore.js';
import { buildPortfolioOverview } from './portfolioCalculations.js';

const money = (value, currency = 'USD') => {
  const number = Number(value);
  const amount = Number.isFinite(number) ? number : 0;
  return `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const signedMoney = (value, currency = 'USD') => {
  const number = Number(value);
  const amount = Number.isFinite(number) ? number : 0;
  return `${amount >= 0 ? '+' : ''}${money(amount, currency)}`;
};

const valueClass = (value) => (Number(value) >= 0 ? 'text-emerald-600' : 'text-red-600');

const SummaryCard = ({ icon, label, value, subtext, tone = 'slate' }) => {
  const toneClasses = {
    slate: 'bg-slate-100 text-slate-600',
    blue: 'bg-blue-50 text-blue-600',
    emerald: 'bg-emerald-50 text-emerald-600',
    amber: 'bg-amber-50 text-amber-600',
    red: 'bg-red-50 text-red-600',
  };

  return (
    <div className="bg-white p-4 sm:p-5 rounded-xl shadow-sm border border-slate-100 flex items-start gap-3">
      <div className={`p-2.5 rounded-lg flex-shrink-0 ${toneClasses[tone] || toneClasses.slate}`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-[11px] sm:text-xs text-slate-500 font-medium">{label}</p>
        <p className="text-base sm:text-xl font-bold text-slate-800 truncate">{value}</p>
        {subtext && <p className="text-[10px] text-slate-400 mt-1 truncate">{subtext}</p>}
      </div>
    </div>
  );
};

export default function PortfolioOverview({ db, user, treasuryMetrics }) {
  const [stockTrades, setStockTrades] = useState([]);
  const [cashMovements, setCashMovements] = useState([]);
  const [reconciliationSnapshots, setReconciliationSnapshots] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!db || !user?.uid) return undefined;
    setIsLoading(true);
    return subscribeStockTrades(
      db,
      user.uid,
      (trades) => {
        setStockTrades(trades);
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
    return subscribeCashMovements(
      db,
      user.uid,
      setCashMovements,
      (err) => setError(err.message || '未能載入現金流水。'),
    );
  }, [db, user?.uid]);



  useEffect(() => {
    if (!db || !user?.uid) return undefined;
    return subscribeReconciliationSnapshots(
      db,
      user.uid,
      setReconciliationSnapshots,
      (err) => setError(err.message || '未能載入對帳快照。'),
    );
  }, [db, user?.uid]);

  const overview = useMemo(
    () => buildPortfolioOverview({ treasuryMetrics, stockTrades, cashMovements, reconciliationSnapshots }),
    [treasuryMetrics, stockTrades, cashMovements, reconciliationSnapshots],
  );

  const reconciliationValue = overview.reconciliation.hasSnapshot
    ? `${overview.reconciliation.issueCount} 個差異`
    : '尚未建立';
  const reconciliationSubtext = overview.reconciliation.hasSnapshot
    ? `最近對帳：${overview.reconciliation.latestDate}`
    : '尚未建立對帳快照';

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-slate-500">Portfolio Dashboard</p>
          <h2 className="text-xl sm:text-2xl font-bold text-slate-900">投資組合總覽</h2>
        </div>
        {isLoading && <Loader2 size={18} className="animate-spin text-slate-400" />}
      </div>
      {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg p-3 flex items-center gap-2"><AlertCircle size={16} />{error}</p>}

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
        <SummaryCard
          icon={<Wallet size={20} />}
          label="總現金"
          value={signedMoney(overview.cash.calculatedCashBalance)}
          subtext={`現金流水 ${signedMoney(overview.cash.cashMovementsTotal)}`}
          tone={overview.cash.calculatedCashBalance >= 0 ? 'emerald' : 'red'}
        />
        <SummaryCard
          icon={<Landmark size={20} />}
          label="美債 Full Market Value"
          value={money(overview.treasury.fullMarketValue)}
          subtext={`Clean ${money(overview.treasury.cleanMarketValue)}`}
          tone="blue"
        />
        <SummaryCard
          icon={<Briefcase size={20} />}
          label="股票成本"
          value={money(overview.stocks.remainingCost)}
          subtext={`${overview.stocks.symbolCount} 個持倉股票代號`}
          tone="amber"
        />
        <SummaryCard
          icon={<ClipboardCheck size={20} />}
          label="最近對帳狀態"
          value={reconciliationValue}
          subtext={reconciliationSubtext}
          tone={overview.reconciliation.issueCount === 0 ? 'emerald' : overview.reconciliation.hasSnapshot ? 'red' : 'slate'}
        />
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
        <SummaryCard
          icon={<TrendingUp size={20} />}
          label="美債未實現盈虧"
          value={signedMoney(overview.treasury.unrealizedPnl)}
          subtext={`Weighted Avg YTM ${overview.treasury.weightedAvgYtm == null ? '--' : `${overview.treasury.weightedAvgYtm.toFixed(2)}%`}`}
          tone={overview.treasury.unrealizedPnl >= 0 ? 'emerald' : 'red'}
        />
        <SummaryCard
          icon={<Briefcase size={20} />}
          label="股票已實現盈虧"
          value={signedMoney(overview.stocks.realizedPnl)}
          subtext={`成本 ${money(overview.stocks.remainingCost)}`}
          tone={overview.stocks.realizedPnl >= 0 ? 'emerald' : 'red'}
        />
        <SummaryCard
          icon={<DollarSign size={20} />}
          label="股息稅後收入"
          value={money(overview.cash.dividendNetReceived)}
          subtext={`股票交易現金影響 ${signedMoney(overview.stocks.cashImpact)}`}
          tone="emerald"
        />
        <SummaryCard
          icon={<Receipt size={20} />}
          label="預扣稅"
          value={money(overview.cash.dividendWithholdingTax)}
          subtext={`非交易費用 ${money(overview.cash.fees)}`}
          tone="slate"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
          <p className="text-xs text-slate-500 font-semibold">美債摘要</p>
          <p className="mt-2 text-sm text-slate-600">每月平均利息：<span className="font-bold text-emerald-600">{money(overview.treasury.monthlyAvgIncome)}</span></p>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
          <p className="text-xs text-slate-500 font-semibold">現金摘要</p>
          <p className="mt-2 text-sm text-slate-600">股票交易現金影響：<span className={`font-bold ${valueClass(overview.cash.stockTradeCashImpact)}`}>{signedMoney(overview.cash.stockTradeCashImpact)}</span></p>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
          <p className="text-xs text-slate-500 font-semibold">對帳摘要</p>
          {overview.reconciliation.hasSnapshot ? (
            <p className="mt-2 text-sm text-slate-600">
              現金差額：<span className={`font-bold ${valueClass(overview.reconciliation.cashDifference)}`}>{signedMoney(overview.reconciliation.cashDifference)}</span>
              <span className="mx-2 text-slate-300">/</span>
              持倉差異 {overview.reconciliation.holdingsDifferenceCount}
            </p>
          ) : (
            <p className="mt-2 text-sm text-slate-500">尚未建立對帳快照</p>
          )}
        </div>
      </div>
    </section>
  );
}

