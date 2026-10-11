import { lazy, Suspense, useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Plus, Trash2, Edit2, TrendingUp, Activity, Calendar, Loader2, AlertCircle, Archive, Wallet, Clock, LogOut, History, Landmark, Download, Upload, RefreshCw, Calculator, RotateCcw } from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, collection, onSnapshot, doc, setDoc, writeBatch, connectFirestoreEmulator } from 'firebase/firestore';
import {
  STALE_MARKET_PRICE_DAYS,
  calculateAccruedInterestPer100,
  calculateDaysBetween,
  calculateForwardDaysBetween,
  calculateHoldToMaturityQuote,
  calculateTradePricePnl,
  formatDateOnly,
  generateAllCoupons,
  getDirtyPrice,
  getMarketPriceAgeDays,
  getMarketPriceAsOf,
  getMarketYTMFromCurve,
  getTradeYTM,
  isCouponTreasury,
  isMarketPriceStale,
  isMatured,
  isSupportedTreasuryType,
  isValidISODate,
  makeTradeId,
  normalizeTradeForStorage,
  solveYTMFromPrice,
  toDateAtMidnight,
  toFiniteNumber,
} from './lib/treasuryMath.js';
import { calculatePortfolioMetrics } from './lib/portfolio.js';
import { describeFirestoreError } from './lib/firestoreErrors.js';
import {
  getFredPricingSignature,
  getFredTheoreticalEstimate,
  hasCurrentFredEstimate,
  normalizeYieldCurve,
  shouldUpdateFredEstimate,
} from './lib/yieldCurve.js';
import {
  buildTradeBackup,
  markTradeDeleted,
  normalizeTradeBackupEntry,
  partitionTradesByLifecycle,
  restoreDeletedTrade,
} from './lib/tradeLifecycle.js';
import CouponCalendar from './components/CouponCalendar.jsx';

const YieldCurveChart = lazy(() => import('./components/YieldCurveChart.jsx'));

const TREASURY_TYPE_LABELS = {
  't-bill': '短期國庫券',
  't-note': '中期國庫券',
  't-bond': '長期國庫券',
  tips: '通脹保值國債',
};

// 本機開發可連接 Firebase Emulator；Production Build 永遠不會啟用。
const useFirebaseEmulators = import.meta.env.DEV && import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true';

// --- 真實環境 Firebase 設定 (使用環境變數) ---
const firebaseConfig = useFirebaseEmulators ? {
  apiKey: 'demo-api-key',
  authDomain: '127.0.0.1',
  projectId: 'demo-treasury-dashboard',
  appId: 'demo-app',
} : {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
const appCheckSiteKey = import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY;
if (import.meta.env.PROD && appCheckSiteKey) {
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
    isTokenAutoRefreshEnabled: true,
  });
}
const auth = getAuth(app);
const db = getFirestore(app);
if (useFirebaseEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}
const googleProvider = new GoogleAuthProvider();

const MAX_IMPORT_BYTES = 1_000_000;
const MAX_IMPORT_TRADES = 500;

const fetchYieldCurve = async ({ bypassCache = false } = {}) => {
  const base = import.meta.env.BASE_URL || '/';
  const suffix = bypassCache ? `?refresh=${Date.now()}` : '';
  const res = await fetch(`${base}yield-curve.json${suffix}`, { cache: bypassCache ? 'no-store' : 'default' });
  if (!res.ok) throw new Error(`收益率曲線資料請求失敗（HTTP ${res.status}）`);
  return normalizeYieldCurve(await res.json());
};

const roundMarketPriceForStorage = (price) => Math.round(price * 1000) / 1000;

const formatUsd = (value, fractionDigits = 2) => Number(value || 0).toLocaleString(undefined, {
  minimumFractionDigits: fractionDigits,
  maximumFractionDigits: fractionDigits,
});

const formatSignedUsd = (value) => {
  const cents = Math.round(value * 100) / 100;
  return `${cents >= 0 ? '+' : '-'}$${formatUsd(Math.abs(cents))}`;
};

const downloadJson = (data, filename) => {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking synchronously can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [trades, setTrades] = useState([]);
  const [deletedTrades, setDeletedTrades] = useState([]);
  const [isDbReady, setIsDbReady] = useState(false);
  const [dbError, setDbError] = useState('');

  const [activeTab, setActiveTab] = useState('dashboard');
  const [ledgerSubTab, setLedgerSubTab] = useState('active'); 
  
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingTradeId, setEditingTradeId] = useState(null);
  
  const [isCloseModalOpen, setIsCloseModalOpen] = useState(false);
  const [closingTradeId, setClosingTradeId] = useState(null);
  const tradeDialogRef = useRef(null);
  const closeDialogRef = useRef(null);
  
  const [editingPriceId, setEditingPriceId] = useState(null);
  const [newPrice, setNewPrice] = useState('');

  // --- FRED Yield Curve ---
  const [yieldCurve, setYieldCurve] = useState(null);
  const [yieldCurveError, setYieldCurveError] = useState('');
  const [isFetchingCurve, setIsFetchingCurve] = useState(true);
  const [todayObj, setTodayObj] = useState(() => toDateAtMidnight(new Date()));

  const defaultForm = { cusip: '', type: 't-note', side: 'buy', tradeDate: formatDateOnly(new Date()), maturityDate: '', faceValue: 1000, cleanPrice: 100, couponRate: 0, commission: 0, couponFrequency: 2, accruedInterestPer100: '' };
  const defaultYtmForm = { type: 't-note', tradeDate: formatDateOnly(new Date()), maturityDate: '', faceValue: 1000, cleanPrice: 100, couponRate: 4, couponFrequency: 2, commission: 0, accruedInterestPer100: '' };
  const [formData, setFormData] = useState(defaultForm);
  const [ytmForm, setYtmForm] = useState(defaultYtmForm);
  const [closeData, setCloseData] = useState({ closeDate: formatDateOnly(new Date()), closePrice: '', closeCommission: 0, closeAccruedInterestPer100: '' });
  const [selectedBenchmark, setSelectedBenchmark] = useState('UST10Y');
  const [importAuditLog, setImportAuditLog] = useState([]);

  useEffect(() => {
    const dialog = isCloseModalOpen ? closeDialogRef.current : isFormOpen ? tradeDialogRef.current : null;
    if (!dialog) return undefined;
    const previouslyFocused = document.activeElement;
    const focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    const focusTimer = window.requestAnimationFrame(() => dialog.querySelector(focusableSelector)?.focus());
    const handleDialogKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (isCloseModalOpen) setIsCloseModalOpen(false);
        else setIsFormOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusableElements = [...dialog.querySelectorAll(focusableSelector)];
      if (focusableElements.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleDialogKeyDown);
    return () => {
      window.cancelAnimationFrame(focusTimer);
      document.removeEventListener('keydown', handleDialogKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [isCloseModalOpen, isFormOpen]);

  useEffect(() => {
    const refreshValuationDate = () => {
      const currentDate = toDateAtMidnight(new Date());
      setTodayObj((previousDate) => previousDate?.getTime() === currentDate?.getTime() ? previousDate : currentDate);
    };
    const timerId = window.setInterval(refreshValuationDate, 60_000);
    return () => window.clearInterval(timerId);
  }, []);

  const saveTradeToDB = useCallback(async (tradeData) => {
    if (!user) return;
    const normalizedTrade = normalizeTradeForStorage(tradeData);
    const tradeRef = doc(db, 'users', user.uid, 'trades', normalizedTrade.id);
    await setDoc(tradeRef, normalizedTrade);
  }, [user]);

  const saveTradeWithFeedback = useCallback(async (tradeData, actionLabel) => {
    try {
      await saveTradeToDB(tradeData);
      return true;
    } catch (error) {
      console.error(`${actionLabel}失敗：`, tradeData.id, error);
      alert(`${actionLabel}失敗，資料沒有變更。${describeFirestoreError(error)}`);
      return false;
    }
  }, [saveTradeToDB]);

  // --- Firebase Auth 監聽 (改為 Google 登入) ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (!currentUser) {
        setTrades([]);
        setDeletedTrades([]);
        setIsDbReady(false);
        setDbError('');
      }
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // FRED data is generated server-side by GitHub Actions and served as static JSON.
  useEffect(() => {
    let cancelled = false;
    fetchYieldCurve()
      .then(curve => { if (!cancelled) { setYieldCurve(curve); setYieldCurveError(''); } })
      .catch(err => { if (!cancelled) setYieldCurveError(err.message || '無法獲取市場收益率'); })
      .finally(() => { if (!cancelled) setIsFetchingCurve(false); });
    return () => { cancelled = true; };
  }, []);

  // --- 當 yield curve 載入後，更新獨立的 FRED 理論估值，不覆寫使用者市場價 ---
  const priceUpdatesInFlightRef = useRef(new Set());
  useEffect(() => {
    if (!yieldCurve?.points?.length || !user || !isDbReady) return;
    const curveDate = yieldCurve.observationDate;
    if (!curveDate) return;
    const toUpdate = trades.filter(t =>
      isSupportedTreasuryType(t)
      && t.status !== 'closed'
      && !isMatured(t.maturityDate, todayObj)
      && shouldUpdateFredEstimate(t, curveDate)
      && !priceUpdatesInFlightRef.current.has(t.id)
    );
    for (const trade of toUpdate) {
      priceUpdatesInFlightRef.current.add(trade.id);
      (async () => {
        try {
          const estimate = getFredTheoreticalEstimate(trade, yieldCurve);
          if (!estimate) return;
          await saveTradeToDB({
            ...trade,
            fredEstimatedPrice: roundMarketPriceForStorage(estimate.cleanPrice),
            fredEstimatedAt: estimate.observationDate,
            fredPricingSignature: getFredPricingSignature(trade),
          });
        } catch (err) {
          console.error('更新 FRED 理論估值失敗：', trade.id, err);
          setDbError(`FRED 理論估值未能儲存；使用者市場價沒有被修改。${describeFirestoreError(err)}`);
        } finally {
          priceUpdatesInFlightRef.current.delete(trade.id);
        }
      })();
    }
  }, [yieldCurve, trades, user, isDbReady, saveTradeToDB, todayObj]);

  const handleRefreshCurve = async () => {
    setIsFetchingCurve(true);
    try {
      const curve = await fetchYieldCurve({ bypassCache: true });
      setYieldCurve(curve);
      setYieldCurveError('');
    } catch (err) {
      setYieldCurveError(err.message || '無法獲取市場收益率');
    } finally {
      setIsFetchingCurve(false);
    }
  };

  useEffect(() => {
    if (!user) return;
    // 使用 user.uid 作為個人專屬路徑 (每個 Google 帳號有獨立空間)
    const tradesRef = collection(db, 'users', user.uid, 'trades');
    const unsubscribe = onSnapshot(tradesRef, (snapshot) => {
      const fetchedTrades = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
      setTrades(fetchedTrades.filter((trade) => !trade.deletedAt));
      setDeletedTrades(fetchedTrades.filter((trade) => Boolean(trade.deletedAt)));
      setIsDbReady(true);
      setDbError('');
    }, (error) => {
      console.error("Firestore 錯誤：", error);
      setDbError(error?.code === 'permission-denied'
        ? '此帳號未獲授權讀取帳本，或 Firestore 安全規則拒絕存取。'
        : `無法同步 Firestore。${describeFirestoreError(error)}`);
      setIsDbReady(true);
    });
    return () => unsubscribe();
  }, [user]);


  // --- Google 登入/登出 Function ---
  const handleGoogleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("登入錯誤:", error);
      alert("登入失敗，請重試！");
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error('登出錯誤：', error);
      alert('登出失敗，請檢查網絡後重試。');
    }
  };

  // --- Derived Data ---
  const {
    active: activeTrades,
    matured: maturedTrades,
    closed: closedTrades,
  } = useMemo(() => partitionTradesByLifecycle(trades, todayObj), [trades, todayObj]);
  const unsupportedTips = useMemo(() => trades.filter(t => t.type === 'tips'), [trades]);
  const supportedActiveTrades = useMemo(() => activeTrades.filter(isSupportedTreasuryType), [activeTrades]);
  const supportedMaturedTrades = useMemo(() => maturedTrades.filter(isSupportedTreasuryType), [maturedTrades]);
  const supportedClosedTrades = useMemo(() => closedTrades.filter(isSupportedTreasuryType), [closedTrades]);
  const allCoupons = useMemo(() => trades.filter(isSupportedTreasuryType).flatMap(generateAllCoupons), [trades]);
  const receivedCoupons = useMemo(() => allCoupons.filter(c => c.date <= todayObj), [allCoupons, todayObj]);
  const upcomingCouponsList = useMemo(() => allCoupons.filter(c => c.date > todayObj && c.date.getFullYear() === todayObj.getFullYear()), [allCoupons, todayObj]);

  // --- PnL Calculations ---
  const portfolioMetrics = useMemo(() => calculatePortfolioMetrics({
    activeTrades: supportedActiveTrades,
    maturedTrades: supportedMaturedTrades,
    closedTrades: supportedClosedTrades,
    receivedCoupons,
    valuationDate: todayObj,
  }), [supportedActiveTrades, supportedMaturedTrades, supportedClosedTrades, receivedCoupons, todayObj]);
  const stalePriceTrades = useMemo(
    () => supportedActiveTrades.filter((trade) => isMarketPriceStale(trade, todayObj)),
    [supportedActiveTrades, todayObj],
  );

  // --- Chart Data ---
  const yieldCurveChartData = useMemo(() => {
    if (!yieldCurve?.points?.length) return null;
    const sourceCurvePoints = yieldCurve.points
      .map(p => ({ years: Number(p.years), yield: Number(p.yield) }))
      .filter(p => Number.isFinite(p.years) && Number.isFinite(p.yield))
      .sort((a, b) => a.years - b.years);
    if (!sourceCurvePoints.length) return null;

    const interactiveCurvePoints = [...sourceCurvePoints];
    const firstYear = sourceCurvePoints[0].years;
    const lastYear = sourceCurvePoints[sourceCurvePoints.length - 1].years;
    const firstSampleYear = Math.ceil(firstYear / 0.05) * 0.05;
    for (let years = firstSampleYear; years <= lastYear; years += 0.05) {
      const normalizedYears = Number(years.toFixed(2));
      const interpolatedYield = getMarketYTMFromCurve(yieldCurve, normalizedYears);
      if (Number.isFinite(interpolatedYield)) {
        interactiveCurvePoints.push({ years: normalizedYears, yield: interpolatedYield });
      }
    }
    const curvePoints = Array.from(
      new Map(interactiveCurvePoints.map(point => [point.years, point])).values(),
    ).sort((a, b) => a.years - b.years);
    const twoYearYield = sourceCurvePoints.find(p => p.years === 2)?.yield;
    const tenYearYield = sourceCurvePoints.find(p => p.years === 10)?.yield;
    const bondDots = supportedActiveTrades.map(t => {
      const days = calculateForwardDaysBetween(todayObj, t.maturityDate);
      if (!days || days <= 0) return null;
      const remainingYears = days / 365.25;
      const marketYtm = getMarketYTMFromCurve(yieldCurve, remainingYears);
      return { id: t.id, cusip: t.cusip || t.type.toUpperCase(), x: remainingYears, y: marketYtm, side: t.side };
    }).filter(d => d?.y != null);
    return {
      curvePoints,
      bondDots,
      spread2s10s: Number.isFinite(twoYearYield) && Number.isFinite(tenYearYield) ? tenYearYield - twoYearYield : null,
    };
  }, [yieldCurve, supportedActiveTrades, todayObj]);

  const couponCalendar = useMemo(() => {
    const year = todayObj.getFullYear();
    const byMonth = Array.from({ length: 12 }, () => 0);
    allCoupons.filter(c => c.date.getFullYear() === year).forEach(c => { byMonth[c.date.getMonth()] += c.amount; });
    return byMonth;
  }, [allCoupons, todayObj]);

  const benchmarkMetrics = useMemo(() => {
    const benchmarkYearsMap = { SGOV: 0.25, SHY: 2, IEF: 7, TLT: 20, UST10Y: 10 };
    const benchmarkYears = benchmarkYearsMap[selectedBenchmark] ?? 10;
    const benchmarkYield = getMarketYTMFromCurve(yieldCurve, benchmarkYears);
    const portfolioYield = Number.isFinite(portfolioMetrics.totalWeightYTM) ? portfolioMetrics.totalWeightYTM : null;
    const spread = benchmarkYield == null || portfolioYield == null ? null : (portfolioYield - benchmarkYield);
    return { benchmarkYears, benchmarkYield, portfolioYield, spread };
  }, [selectedBenchmark, yieldCurve, portfolioMetrics.totalWeightYTM]);

  const ytmQuote = useMemo(() => {
    const faceValue = toFiniteNumber(ytmForm.faceValue);
    const cleanPrice = toFiniteNumber(ytmForm.cleanPrice);
    const commission = toFiniteNumber(ytmForm.commission);
    const couponRate = ytmForm.type === 't-bill' ? 0 : toFiniteNumber(ytmForm.couponRate);
    const couponFrequency = ytmForm.type === 't-bill' ? 0 : toFiniteNumber(ytmForm.couponFrequency, 2);
    const tradeDate = toDateAtMidnight(ytmForm.tradeDate);
    const maturityDate = toDateAtMidnight(ytmForm.maturityDate);

    if (!isSupportedTreasuryType(ytmForm) || !ytmForm.tradeDate || !ytmForm.maturityDate || !tradeDate || !maturityDate || maturityDate <= tradeDate || faceValue <= 0 || cleanPrice <= 0) {
      return { isValid: false };
    }

    const days = calculateForwardDaysBetween(tradeDate, maturityDate);
    if (!days || days <= 0) return { isValid: false };
    const years = days / 365.25;
    const trade = { type: ytmForm.type, tradeDate: ytmForm.tradeDate, couponRate, couponFrequency, maturityDate: ytmForm.maturityDate, accruedInterestPer100: ytmForm.accruedInterestPer100 };
    const maturityQuote = calculateHoldToMaturityQuote({
      ...trade,
      faceValue,
      cleanPrice,
      commission,
    }, tradeDate);
    if (!maturityQuote) return { isValid: false };
    const grossYtm = solveYTMFromPrice(trade, maturityQuote.dirtyPrice, tradeDate);
    const netYtm = solveYTMFromPrice(trade, maturityQuote.priceWithCommission, tradeDate);
    const marketYield = getMarketYTMFromCurve(yieldCurve, years);

    return {
      isValid: true,
      days,
      years,
      faceValue,
      cleanPrice,
      ...maturityQuote,
      grossYtm,
      netYtm,
      marketYield,
      spreadToCurve: marketYield == null || netYtm == null ? null : netYtm - marketYield,
    };
  }, [ytmForm, yieldCurve]);
  const handleAddYtmToLedger = async () => {
    if (!ytmQuote.isValid) return;
    if (!user) {
      alert('未能加入債券帳本，請先確認已登入。');
      return;
    }
    const tradeData = normalizeTradeForStorage({
      id: makeTradeId(),
      cusip: `${ytmForm.type.toUpperCase()} ${ytmForm.maturityDate}`,
      type: ytmForm.type,
      side: 'buy',
      tradeDate: ytmForm.tradeDate,
      maturityDate: ytmForm.maturityDate,
      faceValue: ytmForm.faceValue,
      cleanPrice: ytmForm.cleanPrice,
      couponRate: ytmForm.type === 't-bill' ? 0 : ytmForm.couponRate,
      couponFrequency: ytmForm.type === 't-bill' ? 0 : ytmForm.couponFrequency,
      commission: ytmForm.commission,
      accruedInterestPer100: ytmForm.accruedInterestPer100,
      currentMarketPrice: ytmForm.cleanPrice,
      priceUpdatedAt: ytmForm.tradeDate,
      status: 'active',
    });
    if (!await saveTradeWithFeedback(tradeData, '加入帳本')) return;
    setLedgerSubTab('active');
    setActiveTab('trades');
  };

  const handleDeleteTrade = async (trade) => {
    if (!user || !window.confirm(`將 ${trade.cusip || '這筆交易'} 移至回收桶？之後仍可復原。`)) return;
    try {
      await saveTradeToDB(markTradeDeleted(trade));
    } catch (error) {
      console.error('移至回收桶失敗：', trade.id, error);
      alert(`未能刪除交易，資料沒有變更。${describeFirestoreError(error)}`);
    }
  };

  const handleRestoreTrade = async (trade) => {
    try {
      await saveTradeToDB(restoreDeletedTrade(trade));
    } catch (error) {
      console.error('復原交易失敗：', trade.id, error);
      alert(`未能復原交易。${describeFirestoreError(error)}`);
    }
  };

  const handleSaveTrade = async (e) => {
    e.preventDefault();
    if (!isSupportedTreasuryType(formData)) {
      alert('TIPS 暫未支援，請選擇 T-Bill、T-Note 或 T-Bond。');
      return;
    }
    if (!isValidISODate(formData.tradeDate) || !isValidISODate(formData.maturityDate) || toDateAtMidnight(formData.maturityDate) <= toDateAtMidnight(formData.tradeDate)) {
      alert('請輸入有效交收日及較後的到期日。');
      return;
    }
    const faceValue = Number(formData.faceValue);
    const cleanPrice = Number(formData.cleanPrice);
    const commission = Number(formData.commission || 0);
    const couponRate = Number(formData.couponRate || 0);
    const couponFrequency = Number(formData.couponFrequency);
    if (!Number.isFinite(faceValue) || faceValue <= 0 || !Number.isFinite(cleanPrice) || cleanPrice <= 0 || !Number.isFinite(commission) || commission < 0) {
      alert('面值及價格必須大於 0，手續費不可為負數。');
      return;
    }
    if (isCouponTreasury(formData) && (!Number.isFinite(couponRate) || couponRate < 0 || couponFrequency !== 2)) {
      alert('美國國債票息率必須有效，派息頻率必須為每半年一次。');
      return;
    }
    const existingTrade = editingTradeId ? trades.find(t => t.id === editingTradeId) : null;
    if (editingTradeId && !existingTrade) {
      alert('這筆交易已不在帳本（可能已在其他裝置移至回收桶），資料沒有變更。');
      return;
    }
    if (
      existingTrade?.status === 'closed'
      && (formData.tradeDate > existingTrade.closeDate || formData.maturityDate < existingTrade.closeDate)
    ) {
      alert(`平倉交收日（${existingTrade.closeDate}）必須介乎開倉交收日與到期日之間，請調整日期。`);
      return;
    }
    const tradeData = normalizeTradeForStorage({
      ...existingTrade,
      ...formData,
      status: editingTradeId ? (formData.status || existingTrade?.status || 'active') : 'active',
    });
    if (!editingTradeId) {
      tradeData.id = makeTradeId();
      tradeData.currentMarketPrice = tradeData.cleanPrice;
      tradeData.priceUpdatedAt = tradeData.tradeDate;
    } else {
      tradeData.id = editingTradeId;
      tradeData.currentMarketPrice = toFiniteNumber(existingTrade.currentMarketPrice, tradeData.cleanPrice);
      if (isValidISODate(existingTrade.priceUpdatedAt)) tradeData.priceUpdatedAt = existingTrade.priceUpdatedAt;
      else delete tradeData.priceUpdatedAt;
    }
    if (!await saveTradeWithFeedback(tradeData, '儲存交易')) return;
    setIsFormOpen(false); setEditingTradeId(null);
  };

  const handleClosePosition = async (e) => {
    e.preventDefault();
    const trade = trades.find(t => t.id === closingTradeId);
    if (!trade) return;
    if (!isValidISODate(closeData.closeDate) || toDateAtMidnight(closeData.closeDate) < toDateAtMidnight(trade.tradeDate) || toDateAtMidnight(closeData.closeDate) > toDateAtMidnight(trade.maturityDate)) {
      alert('平倉交收日必須介乎開倉交收日與到期日之間。');
      return;
    }
    const closePrice = Number(closeData.closePrice);
    const closeCommission = Number(closeData.closeCommission || 0);
    const closeAccruedInterest = closeData.closeAccruedInterestPer100 === '' ? null : Number(closeData.closeAccruedInterestPer100);
    if (!Number.isFinite(closePrice) || closePrice <= 0 || !Number.isFinite(closeCommission) || closeCommission < 0 || (closeAccruedInterest != null && (!Number.isFinite(closeAccruedInterest) || closeAccruedInterest < 0))) {
      alert('平倉價格必須大於 0，手續費及應計利息不可為負數。');
      return;
    }
    const updatedTrade = normalizeTradeForStorage({
      ...trade,
      status: 'closed',
      closeDate: closeData.closeDate,
      closePrice: closeData.closePrice,
      closeCommission: closeData.closeCommission,
      closeAccruedInterestPer100: closeData.closeAccruedInterestPer100,
      currentMarketPrice: closeData.closePrice,
      priceUpdatedAt: closeData.closeDate,
    });
    if (!await saveTradeWithFeedback(updatedTrade, '平倉')) return;
    setIsCloseModalOpen(false);
  };

  const handleUpdatePrice = async (id) => {
    const n = Number(newPrice);
    if (!Number.isFinite(n) || n <= 0) {
      alert('請輸入有效價格');
      return;
    }
    const trade = trades.find(t => t.id === id);
    if (trade && !await saveTradeWithFeedback({
      ...trade,
      currentMarketPrice: roundMarketPriceForStorage(n),
      priceUpdatedAt: formatDateOnly(todayObj),
    }, '更新市場價格')) return;
    setEditingPriceId(null);
  };

  const handleAdoptFredPrice = async (trade) => {
    if (!hasCurrentFredEstimate(trade)) return;
    await saveTradeWithFeedback({
      ...trade,
      currentMarketPrice: Number(trade.fredEstimatedPrice),
      priceUpdatedAt: trade.fredEstimatedAt,
    }, '採用 FRED 理論價');
  };

  // --- 匯出 / 匯入 ---
  const handleExport = () => {
    const backupTrades = buildTradeBackup(trades, deletedTrades);
    if (backupTrades.length === 0) return;
    downloadJson(JSON.stringify(backupTrades, null, 2), `treasury-backup-${formatDateOnly(new Date())}.json`);
  };

  const handleImport = () => {
    if (!user) {
      alert('請先登入再匯入交易。');
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > MAX_IMPORT_BYTES) {
        alert('匯入檔案不可超過 1 MB。');
        return;
      }
      try {
        const text = await file.text();
        const imported = JSON.parse(text);
        if (!Array.isArray(imported)) { alert('檔案格式錯誤：需要為交易陣列。'); return; }
        if (imported.length > MAX_IMPORT_TRADES) { alert(`每次最多匯入 ${MAX_IMPORT_TRADES} 筆交易。`); return; }
        const existingIds = new Set([...trades, ...deletedTrades].map(t => t.id));
        const errors = [];
        const pendingTrades = [];

        for (let i = 0; i < imported.length; i++) {
          const prefix = `第 ${i + 1} 筆`;
          const rawTrade = imported[i];
          let trade;
          try {
            trade = normalizeTradeBackupEntry(rawTrade);
          } catch (error) {
            errors.push(`${prefix}：${error.message}`);
            continue;
          }
          if (existingIds.has(trade.id)) { errors.push(`${prefix}：交易識別碼（id）重複`); continue; }

          existingIds.add(trade.id);
          pendingTrades.push(trade);
        }

        if (pendingTrades.length > 0) {
          const batch = writeBatch(db);
          pendingTrades.forEach((trade) => {
            batch.set(doc(db, 'users', user.uid, 'trades', trade.id), trade);
          });
          try {
            await batch.commit();
          } catch (error) {
            console.error('批次匯入 Firestore 失敗：', error);
            alert(`匯入失敗，沒有任何交易寫入。${describeFirestoreError(error)}`);
            return;
          }
        }

        const added = pendingTrades.length;
        const skipped = imported.length - added;
        setImportAuditLog(prev => [{
          id: Date.now().toString(),
          ts: new Date().toISOString(),
          total: imported.length,
          added,
          skipped,
          errors: errors.slice(0, 10),
        }, ...prev].slice(0, 10));

        alert(`匯入完成：新增 ${added} 筆交易，略過 ${skipped} 筆。`);
      } catch { alert('匯入失敗：無法讀取或解析檔案。'); }
    };
    input.click();
  };

  // --- 登入畫面 UI ---
  if (authLoading) return <div className="app-loading min-h-screen flex items-center justify-center"><Loader2 className="animate-spin" size={42}/></div>;

  if (!user) {
    return (
      <div className="auth-screen min-h-screen flex flex-col items-center justify-center p-4">
        <div className="auth-card p-8 rounded-2xl max-w-md w-full text-center">
          <div className="brand-mark w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <Landmark size={32} className="text-white" />
          </div>
          <h1 className="auth-title text-2xl font-bold mb-2">美國國債帳本</h1>
          <p className="text-slate-500 mb-8 text-sm">請登入以管理你的專屬債券帳本，數據將安全同步至雲端，隨時隨地查閱。</p>
          <button onClick={handleGoogleLogin} className="google-signin w-full font-medium py-3 px-4 rounded-xl flex items-center justify-center">
            <svg className="w-5 h-5 mr-3" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
            使用 Google 帳號登入
          </button>
        </div>
      </div>
    );
  }

  // --- 主畫面 UI ---
  if (!isDbReady) return <div className="app-loading min-h-screen flex items-center justify-center"><Loader2 className="animate-spin" size={42}/></div>;

  const renderDashboard = () => {
    const year = todayObj.getFullYear();
    const sortedActiveTrades = [...activeTrades].sort((a, b) => String(a.maturityDate).localeCompare(String(b.maturityDate)));
    const maxDays = Math.max(...sortedActiveTrades.map(t => calculateDaysBetween(todayObj, t.maturityDate) ?? 0), 1);
    const receivedThisYear = receivedCoupons.filter(c => c.date.getFullYear() === year).reduce((sum, c) => sum + c.amount, 0);
    const upcomingThisYear = upcomingCouponsList.reduce((sum, c) => sum + c.amount, 0);
    const formatCountdown = (d) => {
      if (d < 30) return `${d} 天`;
      if (d < 365) return `${Math.floor(d / 30)} 個月 ${d % 30} 天`;
      return `${Math.floor(d / 365)} 年 ${Math.floor((d % 365) / 30)} 個月`;
    };
    const valueTone = (value) => (value >= 0 ? 'value-gain' : 'value-loss');

    return (
      <div className="dashboard-view space-y-4 sm:space-y-5">
        <section className="summary-grid" aria-label="組合摘要">
          <div className="hero-card rounded-2xl">
            <p className="hero-kicker">美債組合市值（全價）</p>
            <p className="hero-value">${formatUsd(portfolioMetrics.totalFullMarketValue)}</p>
            <p className="hero-detail">淨價 ${formatUsd(portfolioMetrics.totalMarketValue)} · 應計利息 ${formatUsd(portfolioMetrics.totalAccruedInterest)} · {supportedActiveTrades.length} 筆活躍持倉</p>
            <dl className="hero-figures">
              <div>
                <dt>未實現盈虧</dt>
                <dd className={valueTone(portfolioMetrics.totalUnrealizedPnL)}>{formatSignedUsd(portfolioMetrics.totalUnrealizedPnL)}</dd>
              </div>
              <div>
                <dt>累計已實現利潤</dt>
                <dd className={valueTone(portfolioMetrics.totalRealizedPnL)}>{formatSignedUsd(portfolioMetrics.totalRealizedPnL)}</dd>
                <dd className="hero-figure-note">包括平倉、到期結算及已收派息</dd>
              </div>
            </dl>
          </div>
          <div className="summary-side">
            <div className="stat-card">
              <p className="stat-label" title="按全價市值加權；賣空倉位以負收益計入">美債加權平均 YTM</p>
              <p className="stat-value">{portfolioMetrics.totalWeightYTM == null ? '--' : `${portfolioMetrics.totalWeightYTM.toFixed(2)}%`}</p>
              <div className="benchmark-row">
                <label htmlFor="benchmark-select" className="sr-only">對比基準</label>
                <select id="benchmark-select" value={selectedBenchmark} onChange={(e) => setSelectedBenchmark(e.target.value)} className="compact-select">
                  <option value="UST10Y">對比 UST 10 年</option>
                  <option value="SGOV">對比 SGOV（約 3 個月）</option>
                  <option value="SHY">對比 SHY（約 2 年）</option>
                  <option value="IEF">對比 IEF（約 7 年）</option>
                  <option value="TLT">對比 TLT（約 20 年）</option>
                </select>
                <p className="stat-detail">
                  <span className="whitespace-nowrap">基準 {benchmarkMetrics.benchmarkYield == null ? '--' : `${benchmarkMetrics.benchmarkYield.toFixed(2)}%`}</span>
                  {' · '}
                  <span className="whitespace-nowrap">利差 <span className={benchmarkMetrics.spread == null ? '' : valueTone(benchmarkMetrics.spread)}>
                    {benchmarkMetrics.spread == null ? '--' : `${benchmarkMetrics.spread >= 0 ? '+' : '−'}${Math.abs(benchmarkMetrics.spread).toFixed(2)}%`}
                  </span></span>
                </p>
              </div>
            </div>
            <div className="stat-card">
              <p className="stat-label">平均每月利息</p>
              <p className="stat-value">${formatUsd(portfolioMetrics.monthlyAvgIncome)}</p>
              <p className="stat-detail">按活躍持倉票息年化後平均</p>
            </div>
          </div>
        </section>

        <section className="glass-panel chart-panel rounded-xl" aria-labelledby="yield-curve-title">
          <div className="panel-heading">
            <div className="min-w-0">
              <h3 id="yield-curve-title"><TrendingUp size={18} /> 美債收益率曲線</h3>
              <p className="panel-subtitle">
                {yieldCurve?.observationDate ? `FRED 觀察日 ${yieldCurve.observationDate}` : 'FRED 收益率曲線'}
                {yieldCurveChartData?.spread2s10s != null && ` · 10Y–2Y ${yieldCurveChartData.spread2s10s >= 0 ? '+' : '−'}${Math.abs(yieldCurveChartData.spread2s10s).toFixed(2)}%`}
              </p>
            </div>
            <div className="panel-actions">
              <ul className="chart-legend" aria-label="圖例">
                <li><span className="legend-line" aria-hidden="true" />收益率曲線</li>
                <li><span className="legend-dot legend-dot--buy" aria-hidden="true" />買入持倉</li>
                <li><span className="legend-dot legend-dot--sell" aria-hidden="true" />賣空持倉</li>
              </ul>
              <button type="button" onClick={handleRefreshCurve} disabled={isFetchingCurve} title="重新讀取市場收益率" aria-label="重新讀取市場收益率" className="icon-button icon-button--small">
                {isFetchingCurve ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              </button>
            </div>
          </div>
          {yieldCurveError && <p className="inline-error" role="alert"><AlertCircle size={14} />{yieldCurveError}</p>}
          {yieldCurveChartData ? (
            <div className="yield-chart" aria-label="美債收益率曲線圖；移動滑鼠或觸控曲線可查看年期、收益率及附近持倉">
              <Suspense fallback={<div className="chart-placeholder" role="status">正在載入收益率曲線…</div>}>
                <YieldCurveChart {...yieldCurveChartData} />
              </Suspense>
            </div>
          ) : (
            <div className="chart-placeholder" role="status">{isFetchingCurve ? '正在載入收益率曲線…' : '暫時未有收益率曲線資料。'}</div>
          )}
        </section>

        <section className="income-grid">
          <div className="glass-panel rounded-xl" aria-labelledby="coupon-calendar-title">
            <div className="panel-heading">
              <div className="min-w-0">
                <h3 id="coupon-calendar-title"><Calendar size={18} /> {year} 年度派息</h3>
                <p className="panel-subtitle">全年 ${formatUsd(couponCalendar.reduce((sum, value) => sum + value, 0))} · 已收 ${formatUsd(receivedThisYear)} · 尚餘 ${formatUsd(upcomingThisYear)}</p>
              </div>
              <ul className="chart-legend" aria-label="圖例">
                <li><span className="legend-swatch" aria-hidden="true" />已收／本月</li>
                <li><span className="legend-swatch legend-swatch--expected" aria-hidden="true" />預計</li>
              </ul>
            </div>
            <CouponCalendar monthlyTotals={couponCalendar} currentMonth={todayObj.getMonth()} />
          </div>
          <div className="glass-panel rounded-xl" aria-labelledby="upcoming-coupons-title">
            <div className="panel-heading">
              <h3 id="upcoming-coupons-title"><Wallet size={18} /> 今年尚餘派息</h3>
              {upcomingCouponsList.length > 0 && <span className="panel-count">{upcomingCouponsList.length} 筆</span>}
            </div>
            {upcomingCouponsList.length === 0 ? <p className="empty-note">今年內暫無剩餘派息。</p> : (
              <ul className="coupon-list">
                {upcomingCouponsList.map(c => (
                  <li key={c.id}>
                    <span className="coupon-date">{c.dateStr.slice(5).replace('-', '/')}</span>
                    <span className="coupon-cusip">{c.cusip}</span>
                    <strong className={valueTone(c.amount)}>{formatSignedUsd(c.amount)}</strong>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="glass-panel rounded-xl" aria-labelledby="maturity-title">
          <div className="panel-heading">
            <div className="min-w-0">
              <h3 id="maturity-title"><Clock size={18} /> 持倉到期概覽</h3>
              <p className="panel-subtitle">現價 YTM 以自訂市場淨價加應計利息，按該價格的報價日計算；曲線 YTM 為 FRED 曲線於相同剩餘年期的插值。</p>
            </div>
          </div>
          {sortedActiveTrades.length === 0 ? <p className="empty-note">暫無活躍持倉。</p> : (
            <ul className="maturity-list">
              {sortedActiveTrades.map(trade => {
                const days = calculateDaysBetween(todayObj, trade.maturityDate);
                const forwardDays = calculateForwardDaysBetween(todayObj, trade.maturityDate);
                const ytm = getTradeYTM(trade, todayObj);
                const marketYtm = forwardDays && forwardDays > 0 ? getMarketYTMFromCurve(yieldCurve, forwardDays / 365.25) : null;
                const delta = marketYtm != null && ytm != null ? ytm - marketYtm : null;
                const tone = days < 30 ? 'critical' : days < 90 ? 'warning' : 'normal';
                return (
                  <li key={trade.id} className="maturity-row">
                    <div className="maturity-id">
                      <p className="maturity-cusip">{trade.cusip || trade.type.toUpperCase()}</p>
                      <p className="maturity-meta">{TREASURY_TYPE_LABELS[trade.type] || trade.type} · {trade.maturityDate} 到期</p>
                    </div>
                    <div className={`maturity-time maturity-time--${tone}`}>
                      <span className="maturity-countdown">{formatCountdown(days)}{tone !== 'normal' && <em>即將到期</em>}</span>
                      <progress max="100" value={Math.min((days / maxDays) * 100, 100)} aria-label={`${trade.cusip || trade.type} 剩餘年期`} />
                    </div>
                    <div className="maturity-yield">
                      <span>現價 YTM</span>
                      <strong>{ytm == null ? '--' : `${ytm.toFixed(2)}%`}</strong>
                    </div>
                    <div className="maturity-yield">
                      <span>曲線 YTM</span>
                      <strong>{marketYtm == null ? '--' : `${marketYtm.toFixed(2)}%`}</strong>
                      {delta != null && <em className={valueTone(delta)}>{delta >= 0 ? '+' : '−'}{Math.abs(delta).toFixed(2)}</em>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {importAuditLog.length > 0 && (
          <section className="glass-panel rounded-xl" aria-labelledby="import-audit-title">
            <div className="panel-heading">
              <h3 id="import-audit-title"><History size={18} /> 匯入稽核記錄</h3>
            </div>
            <ul className="audit-list">
              {importAuditLog.map(log => (
                <li key={log.id}>
                  <p className="audit-title">{new Date(log.ts).toLocaleString('zh-HK')} · 新增 {log.added} / {log.total}</p>
                  {log.skipped > 0 && <p className="audit-warning">略過 {log.skipped} 筆（詳見驗證規則）</p>}
                  {log.errors?.length > 0 && <p className="audit-detail" title={log.errors.join(' | ')}>例子：{log.errors[0]}</p>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  };

  const renderYtmCalculator = () => {
    const update = (field, value) => setYtmForm(prev => ({ ...prev, [field]: value }));
    const pct = (value) => value == null || !Number.isFinite(value) ? '--' : `${value.toFixed(3)}%`;

    return (
      <div className="calculator-view space-y-4 sm:space-y-6">
        <div className="glass-panel calculator-panel rounded-xl overflow-hidden">
          <div className="panel-heading p-4 sm:p-5 flex flex-wrap justify-between items-center gap-3">
            <div>
              <h3 className="text-base sm:text-lg font-bold text-slate-800 flex items-center gap-2"><Calculator size={18} className="text-blue-600"/> 買入前 YTM 試算器</h3>
              <p className="text-xs text-slate-500 mt-1">買入美債前，估算未計及已計入手續費後的到期收益率。</p>
            </div>
            <button onClick={() => setYtmForm(defaultYtmForm)} className="text-xs sm:text-sm bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-2 rounded-lg font-semibold transition-colors">重設</button>
          </div>

          <div className="p-4 sm:p-5 grid grid-cols-1 lg:grid-cols-[1fr_1.1fr] gap-5">
            <div className="grid grid-cols-2 gap-3 content-start">
              <div>
                <label htmlFor="ytm-type" className="block text-xs font-medium text-slate-500 mb-1">債券類型</label>
                <select id="ytm-type" value={ytmForm.type} onChange={(e) => setYtmForm(prev => ({ ...prev, type: e.target.value, accruedInterestPer100: e.target.value === 't-bill' ? '' : prev.accruedInterestPer100 }))} className="w-full p-2 border rounded-lg text-sm bg-white">
                  <option value="t-bill">短期國庫券（T-Bill）</option>
                  <option value="t-note">中期國庫券（T-Note）</option>
                  <option value="t-bond">長期國庫券（T-Bond）</option>
                  <option value="tips" disabled>通脹保值國債（TIPS，暫未支援）</option>
                </select>
              </div>
              <div>
                <label htmlFor="ytm-face-value" className="block text-xs font-medium text-slate-500 mb-1">面值</label>
                <input id="ytm-face-value" type="number" min="1" step="100" value={ytmForm.faceValue} onChange={(e) => update('faceValue', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
              </div>
              <div>
                <label htmlFor="ytm-trade-date" className="block text-xs font-medium text-slate-500 mb-1">交收日期</label>
                <input id="ytm-trade-date" type="date" value={ytmForm.tradeDate} onChange={(e) => update('tradeDate', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
              </div>
              <div>
                <label htmlFor="ytm-maturity-date" className="block text-xs font-medium text-slate-500 mb-1">到期日</label>
                <input id="ytm-maturity-date" type="date" value={ytmForm.maturityDate} onChange={(e) => update('maturityDate', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
              </div>
              <div>
                <label htmlFor="ytm-clean-price" className="block text-xs font-medium text-slate-500 mb-1">市場報價（潔淨價格）</label>
                <input id="ytm-clean-price" type="number" min="0.001" step="0.001" value={ytmForm.cleanPrice} onChange={(e) => update('cleanPrice', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
              </div>
              <div>
                <label htmlFor="ytm-commission" className="block text-xs font-medium text-slate-500 mb-1">手續費</label>
                <input id="ytm-commission" type="number" min="0" step="0.01" value={ytmForm.commission} onChange={(e) => update('commission', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
              </div>
              {ytmForm.type !== 't-bill' && (
                <>
                  <div>
                    <label htmlFor="ytm-coupon-rate" className="block text-xs font-medium text-slate-500 mb-1">票息率 (%)</label>
                    <input id="ytm-coupon-rate" type="number" min="0" step="0.125" value={ytmForm.couponRate} onChange={(e) => update('couponRate', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
                  </div>
                  <div>
                    <label htmlFor="ytm-coupon-frequency" className="block text-xs font-medium text-slate-500 mb-1">派息頻率</label>
                    <select id="ytm-coupon-frequency" value={ytmForm.couponFrequency} onChange={(e) => update('couponFrequency', e.target.value)} className="w-full p-2 border rounded-lg text-sm bg-white">
                      <option value="2">半年一次</option>
                    </select>
                  </div>
                  {isCouponTreasury(ytmForm) && (
                    <div className="col-span-2">
                      <label htmlFor="ytm-accrued-interest" className="block text-xs font-medium text-slate-500 mb-1">每 100 元面值的應計利息（可選）</label>
                      <input id="ytm-accrued-interest" type="number" min="0" step="0.001" value={ytmForm.accruedInterestPer100} onChange={(e) => update('accruedInterestPer100', e.target.value)} placeholder="自動計算" className="w-full p-2 border rounded-lg text-sm" />
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="space-y-3">
              {!ytmQuote.isValid ? (
                <div className="empty-state h-full min-h-[220px] rounded-xl flex items-center justify-center text-sm text-slate-500 px-4 text-center">
                  請輸入有效的到期日、價格及面值以計算 YTM。
                </div>
              ) : (
                <>
                  <div className="quote-hero">
                    <div>
                      <p className="quote-hero-label">扣除結算成本後 YTM</p>
                      <p className="quote-hero-value">{pct(ytmQuote.netYtm)}</p>
                    </div>
                    <dl className="quote-hero-side">
                      <div><dt>未計手續費 YTM</dt><dd>{pct(ytmQuote.grossYtm)}</dd></div>
                      <div>
                        <dt>對比 FRED 曲線</dt>
                        <dd className={ytmQuote.spreadToCurve == null ? '' : ytmQuote.spreadToCurve >= 0 ? 'value-gain' : 'value-loss'}>
                          {ytmQuote.spreadToCurve == null ? '--' : `${ytmQuote.spreadToCurve >= 0 ? '+' : '−'}${Math.abs(ytmQuote.spreadToCurve).toFixed(3)}%`}
                        </dd>
                      </div>
                    </dl>
                  </div>
                  {ytmQuote.marketYield != null && (
                    <p className="quote-curve-note">FRED 曲線於 {ytmQuote.years.toFixed(2)} 年的插值收益率為 {ytmQuote.marketYield.toFixed(3)}%</p>
                  )}

                  <dl className="quote-list">
                    <div><dt>淨價</dt><dd>{ytmQuote.cleanPrice.toFixed(3)}</dd></div>
                    <div><dt>每 100 元面值應計利息</dt><dd>{ytmQuote.accruedInterestPer100.toFixed(3)}</dd></div>
                    <div><dt>全價</dt><dd>{ytmQuote.dirtyPrice.toFixed(3)}</dd></div>
                    <div><dt>全價連手續費（每 100 元面值）</dt><dd>{ytmQuote.priceWithCommission.toFixed(3)}</dd></div>
                    <div><dt>距離到期</dt><dd>{ytmQuote.days.toLocaleString()} 日</dd></div>
                    <div><dt>總成本</dt><dd>${formatUsd(ytmQuote.totalCost)}</dd></div>
                    <div><dt>估算票息收入</dt><dd>${formatUsd(ytmQuote.couponEstimate)}</dd></div>
                    <div><dt>到期估算利潤</dt><dd className={ytmQuote.maturityProfit >= 0 ? 'value-gain' : 'value-loss'}>{formatSignedUsd(ytmQuote.maturityProfit)}</dd></div>
                    <div><dt>打和淨價</dt><dd>{ytmQuote.breakevenPrice.toFixed(3)}</dd></div>
                  </dl>

                  <button
                    type="button"
                    onClick={handleAddYtmToLedger}
                    className="primary-button w-full px-4 py-3 rounded-lg text-sm font-semibold flex items-center justify-center gap-2"
                  >
                    <Plus size={16} /> 加入債券帳本
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderTrades = () => {
    let displayedTrades = [];
    if (ledgerSubTab === 'active') displayedTrades = activeTrades;
    else if (ledgerSubTab === 'closed') displayedTrades = [...maturedTrades, ...closedTrades].sort((a,b) => String(b.tradeDate).localeCompare(String(a.tradeDate)));

    return (
      <div className="glass-panel trades-panel rounded-xl overflow-hidden">
        <div className="panel-heading p-4 flex justify-between items-center">
          <h3 className="text-base sm:text-lg font-bold text-slate-800">債券交易總帳</h3>
          <button onClick={() => { setFormData(defaultForm); setIsFormOpen(true); }} className="primary-button px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold flex items-center"><Plus size={15} className="mr-1" /> 新增交易</button>
        </div>
        <div className="ledger-tabs flex gap-1 sm:gap-6 px-2 sm:px-4 pt-2 overflow-x-auto" role="tablist" aria-label="帳本分類">
          <button id="ledger-tab-active" role="tab" aria-selected={ledgerSubTab === 'active'} aria-controls="ledger-panel" onClick={() => setLedgerSubTab('active')} className={`pb-2.5 px-2 text-xs sm:text-sm font-bold flex items-center border-b-2 whitespace-nowrap transition-colors ${ledgerSubTab === 'active' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}><Activity size={14} className="mr-1.5"/> 活躍 ({activeTrades.length})</button>
          <button id="ledger-tab-closed" role="tab" aria-selected={ledgerSubTab === 'closed'} aria-controls="ledger-panel" onClick={() => setLedgerSubTab('closed')} className={`pb-2.5 px-2 text-xs sm:text-sm font-bold flex items-center border-b-2 whitespace-nowrap transition-colors ${ledgerSubTab === 'closed' ? 'border-slate-800 text-slate-800' : 'border-transparent text-slate-500 hover:text-slate-700'}`}><Archive size={14} className="mr-1.5"/> 已結算 ({maturedTrades.length + closedTrades.length})</button>
          <button id="ledger-tab-coupons" role="tab" aria-selected={ledgerSubTab === 'coupons'} aria-controls="ledger-panel" onClick={() => setLedgerSubTab('coupons')} className={`pb-2.5 px-2 text-xs sm:text-sm font-bold flex items-center border-b-2 whitespace-nowrap transition-colors ${ledgerSubTab === 'coupons' ? 'border-emerald-600 text-emerald-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}><History size={14} className="mr-1.5"/> 收息 ({receivedCoupons.length})</button>
          <button id="ledger-tab-deleted" role="tab" aria-selected={ledgerSubTab === 'deleted'} aria-controls="ledger-panel" onClick={() => setLedgerSubTab('deleted')} className={`pb-2.5 px-2 text-xs sm:text-sm font-bold flex items-center border-b-2 whitespace-nowrap transition-colors ${ledgerSubTab === 'deleted' ? 'border-red-500 text-red-500' : 'border-transparent text-slate-500 hover:text-slate-700'}`}><Trash2 size={14} className="mr-1.5"/> 回收桶 ({deletedTrades.length})</button>
        </div>
        <div id="ledger-panel" role="tabpanel" aria-labelledby={`ledger-tab-${ledgerSubTab}`} className="table-shell">
          {ledgerSubTab === 'coupons' ? (
             <table className="data-table coupon-table w-full text-left text-sm whitespace-nowrap"><thead><tr><th className="p-4">派息日期</th><th className="p-4">CUSIP／類型</th><th className="p-4 text-right">派息金額（美元）</th></tr></thead><tbody>{receivedCoupons.length === 0 ? <tr><td colSpan="3" className="p-8 text-center text-slate-400">尚未有派息紀錄。</td></tr> : [...receivedCoupons].sort((a,b) => b.date - a.date).map(c => (<tr key={c.id}><td data-label="派息日期" className="p-4 font-medium text-slate-700">{c.dateStr}</td><td data-label="CUSIP" className="cell-primary p-4 text-slate-600">{c.cusip}</td><td data-label="金額" className={`p-4 text-right font-bold ${c.amount >= 0 ? 'value-gain' : 'value-loss'}`}>{formatSignedUsd(c.amount)}</td></tr>))}</tbody></table>
          ) : ledgerSubTab === 'deleted' ? (
            <table className="data-table holdings-table w-full text-left text-sm whitespace-nowrap">
              <thead><tr><th className="p-4">CUSIP</th><th className="p-4">類型</th><th className="p-4 text-right">面值</th><th className="p-4">刪除時間</th><th className="p-4 text-center">操作</th></tr></thead>
              <tbody>{deletedTrades.length === 0 ? <tr><td colSpan="5" className="p-8 text-center text-slate-400">回收桶沒有交易。</td></tr> : [...deletedTrades].sort((a,b) => String(b.deletedAt).localeCompare(String(a.deletedAt))).map(trade => (<tr key={trade.id}><td data-label="CUSIP" className="cell-primary p-4 font-medium">{trade.cusip || '--'}</td><td data-label="類型" className="p-4">{TREASURY_TYPE_LABELS[trade.type] || trade.type}</td><td data-label="面值" className="p-4 text-right">${toFiniteNumber(trade.faceValue).toLocaleString()}</td><td data-label="刪除時間" className="p-4">{new Date(trade.deletedAt).toLocaleString('zh-HK')}</td><td data-label="操作" className="cell-actions p-4 text-center"><button type="button" onClick={() => handleRestoreTrade(trade)} className="secondary-button px-3 py-2 text-xs font-semibold rounded-lg inline-flex items-center gap-1"><RotateCcw size={14}/> 復原</button></td></tr>))}</tbody>
            </table>
          ) : (
            <table className="data-table holdings-table w-full text-left text-sm whitespace-nowrap">
              <thead>
                <tr><th className="p-4">CUSIP</th><th className="p-4">方向／類型</th><th className="p-4 text-right">面值</th><th className="p-4 text-right">成本（淨價）</th>{ledgerSubTab === 'active' ? <><th className="p-4 text-right">自訂市場淨價</th><th className="p-4 text-right">FRED 理論淨價</th><th className="p-4 text-right">未實現損益</th></> : <><th className="p-4 text-right">平倉價</th><th className="p-4 text-right text-emerald-600">已實現損益</th></>}<th className="p-4 text-center">操作</th></tr>
              </thead>
              <tbody>
                {displayedTrades.length === 0 ? <tr><td colSpan="8" className="p-8 text-center text-slate-400">無紀錄。</td></tr> : displayedTrades.map(trade => {
                  const isMaturedBond = isMatured(trade.maturityDate, todayObj) && trade.status !== 'closed';
                  const isUnsupported = !isSupportedTreasuryType(trade);
                  const pnl = calculateTradePricePnl(trade, todayObj);
                  const faceValue = toFiniteNumber(trade.faceValue);
                  const cleanPrice = toFiniteNumber(trade.cleanPrice);
                  const marketPrice = toFiniteNumber(trade.currentMarketPrice, cleanPrice);
                  const fredEstimateIsCurrent = hasCurrentFredEstimate(trade);
                  const fredEstimatedPrice = fredEstimateIsCurrent ? Number(trade.fredEstimatedPrice) : NaN;
                  const priceAsOf = getMarketPriceAsOf(trade);
                  const priceAgeDays = getMarketPriceAgeDays(trade, todayObj);
                  const priceIsStale = isMarketPriceStale(trade, todayObj);
                  const canAdoptFredPrice = fredEstimateIsCurrent && !isUnsupported
                    && (!priceAsOf || trade.fredEstimatedAt > priceAsOf)
                    && Math.abs(fredEstimatedPrice - marketPrice) >= 0.0005;
                  const accruedInterestPer100 = calculateAccruedInterestPer100(trade, todayObj);
                  const dirtyPrice = getDirtyPrice(marketPrice, accruedInterestPer100) || marketPrice;
                  const closePrice = toFiniteNumber(trade.closePrice, marketPrice);
                  return (
                    <tr key={trade.id}>
                      <td data-label="CUSIP" className="cell-primary p-4 font-medium">{trade.cusip || '--'}<div className="text-[10px] text-slate-400">到期：{trade.maturityDate}</div></td>
                      <td data-label="類型" className="p-4"><span className={`trade-side ${trade.side === 'sell' ? 'trade-side--sell' : 'trade-side--buy'} px-2 py-0.5 rounded text-[10px] font-bold mr-1`}>{trade.side === 'sell' ? '賣空' : '買入'}</span><span className={`treasury-badge treasury-badge--${trade.type} px-2 py-0.5 rounded text-[10px] font-bold`}>{TREASURY_TYPE_LABELS[trade.type] || trade.type}</span>{isUnsupported && <div className="text-[10px] text-red-600 mt-1 font-bold">暫不支援計算</div>}{isMaturedBond && <div className="text-[10px] text-amber-600 mt-1 font-bold">已到期</div>}{trade.status === 'closed' && <div className="text-[10px] text-slate-500 mt-1">已平倉（{trade.closeDate}）</div>}</td>
                      <td data-label="面值" className="p-4 text-right">${faceValue.toLocaleString()}</td><td data-label="成本淨價" className="p-4 text-right">{cleanPrice.toFixed(3)}</td>
                      {ledgerSubTab === 'active' ? (
                        <><td data-label="市場淨價" className="p-4 text-right">{editingPriceId === trade.id ? (<div className="flex items-center justify-end"><input aria-label="新市場價格" type="number" step="0.001" className="w-20 border rounded px-1 text-right" value={newPrice} onChange={e=>setNewPrice(e.target.value)}/><button onClick={()=>handleUpdatePrice(trade.id)} className="text-green-600 text-xs ml-1 font-bold">儲存</button></div>) : (<div className="text-right"><button type="button" className="text-blue-600 font-medium flex items-center justify-end ml-auto" onClick={()=>{setEditingPriceId(trade.id); setNewPrice(marketPrice);}}>{marketPrice.toFixed(3)} <Edit2 size={12} className="ml-1 opacity-50"/></button>{isCouponTreasury(trade) && <div className="text-[10px] text-slate-400">應計利息 {accruedInterestPer100.toFixed(3)} · 全價 {dirtyPrice.toFixed(3)}</div>}<div className={`text-[10px] ${priceIsStale ? 'text-amber-600 font-semibold' : 'text-slate-400'}`}>{priceAsOf ? `報價日 ${priceAsOf}${priceAgeDays > 0 ? `（${priceAgeDays} 日前）` : ''}` : '報價日未記錄'}</div></div>)}</td><td data-label="FRED 理論淨價" className="p-4 text-right"><div className="font-medium text-slate-700">{Number.isFinite(fredEstimatedPrice) && fredEstimatedPrice > 0 ? fredEstimatedPrice.toFixed(3) : '--'}</div>{fredEstimateIsCurrent && <div className="text-[10px] text-slate-400">觀察日 {trade.fredEstimatedAt}</div>}{canAdoptFredPrice && <button type="button" onClick={() => handleAdoptFredPrice(trade)} title="以 FRED 理論淨價作為自訂市場淨價，報價日為 FRED 觀察日" className="text-[10px] text-amber-600 font-semibold underline underline-offset-2 mt-0.5">採用為市場價</button>}</td><td data-label="損益" className={`p-4 text-right font-bold ${pnl == null ? 'text-slate-400' : pnl>=0?'value-gain':'value-loss'}`}>{pnl == null ? '--' : formatSignedUsd(pnl)}</td></>
                      ) : (
                        <><td data-label="平倉價" className="p-4 text-right font-medium">{trade.status === 'closed' ? closePrice.toFixed(3) : '100.000（面值）'}</td><td data-label="損益" className={`p-4 text-right font-bold ${pnl == null ? 'text-slate-400' : pnl>=0?'value-gain':'value-loss'}`}>{pnl == null ? '--' : formatSignedUsd(pnl)}</td></>
                      )}
                      <td data-label="操作" className="cell-actions p-4 text-center"><div className="flex items-center justify-center space-x-2"><button aria-label="編輯交易" title="編輯交易" onClick={()=>{setFormData(trade); setEditingTradeId(trade.id); setIsFormOpen(true);}} className="icon-button text-blue-500 p-1 rounded"><Edit2 size={16} /></button>{ledgerSubTab === 'active' && <button aria-label="平倉" onClick={()=>{setClosingTradeId(trade.id); setCloseData({ closeDate: formatDateOnly(new Date()), closePrice: trade.currentMarketPrice, closeCommission: 0, closeAccruedInterestPer100: '' }); setIsCloseModalOpen(true);}} className="icon-button text-orange-500 p-1 rounded" title="平倉"><LogOut size={16} /></button>}<button aria-label="移至回收桶" title="移至回收桶" onClick={() => handleDeleteTrade(trade)} className="icon-button text-red-500 p-1 rounded"><Trash2 size={16} /></button></div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="app-shell min-h-screen font-sans pb-20">
      <nav className="app-nav text-white px-3 sm:px-4 py-2.5 sm:py-3 sticky top-0 z-20">
        <div className="app-container mx-auto flex justify-between items-center gap-3">
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className="brand-mark brand-mark--small w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm flex-shrink-0">債</div>
            <h1 className="app-title text-base sm:text-xl font-bold tracking-tight truncate">美國國債帳本</h1>
          </div>
          {user && (
            <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
              <span className="text-xs text-slate-300 hidden lg:inline truncate max-w-[160px]" title={`UID：${user.uid}`}>{user.email}</span>
              <button onClick={handleExport} disabled={trades.length + deletedTrades.length === 0} className="nav-action text-xs sm:text-sm px-2.5 py-1.5 rounded-md flex items-center gap-1" title="匯出資料">
                <Download size={14}/><span className="hidden sm:inline">匯出</span>
              </button>
              <button onClick={handleImport} className="nav-action text-xs sm:text-sm px-2.5 py-1.5 rounded-md flex items-center gap-1" title="匯入資料">
                <Upload size={14}/><span className="hidden sm:inline">匯入</span>
              </button>
              <button onClick={handleLogout} className="nav-action nav-action--danger text-xs sm:text-sm px-2.5 py-1.5 rounded-md flex items-center gap-1" title="登出">
                <LogOut size={14}/><span className="hidden sm:inline">登出</span>
              </button>
            </div>
          )}
        </div>
      </nav>
      <main className="app-main app-container mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-6">
        {dbError && (
          <div role="alert" className="status-banner status-banner--danger mb-4 rounded-xl px-4 py-3 text-sm flex items-start gap-2">
            <AlertCircle size={17} className="mt-0.5 flex-shrink-0" />
            <span>{dbError}</span>
          </div>
        )}
        {stalePriceTrades.length > 0 && (
          <div role="status" className="status-banner status-banner--warning mb-4 rounded-xl px-4 py-3 text-sm flex flex-wrap items-start gap-2">
            <AlertCircle size={17} className="mt-0.5 flex-shrink-0" />
            <span className="flex-1 min-w-[200px]">有 {stalePriceTrades.length} 筆持倉的自訂市場價超過 {STALE_MARKET_PRICE_DAYS} 日未更新或沒有報價日期。YTM 會按報價日計算，但市值及未實現損益仍沿用舊價。</span>
            {(activeTab !== 'trades' || ledgerSubTab !== 'active') && (
              <button type="button" onClick={() => { setActiveTab('trades'); setLedgerSubTab('active'); }} className="text-xs font-semibold underline underline-offset-2">前往帳本更新</button>
            )}
          </div>
        )}
        {unsupportedTips.length > 0 && (
          <div role="status" className="status-banner status-banner--warning mb-4 rounded-xl px-4 py-3 text-sm flex items-start gap-2">
            <AlertCircle size={17} className="mt-0.5 flex-shrink-0" />
            <span>偵測到 {unsupportedTips.length} 筆既有 TIPS。資料仍保留在帳本，但在加入 CPI 指數比率模型前不會計入估值、YTM、利息或損益。</span>
          </div>
        )}
        <div className="primary-nav-wrap mb-5">
        <div className="primary-tabs grid grid-cols-3 gap-1 p-1 rounded-xl" role="tablist" aria-label="主要功能">
          <button id="primary-tab-dashboard" role="tab" aria-selected={activeTab === 'dashboard'} aria-controls="primary-panel" onClick={() => setActiveTab('dashboard')} className={`primary-tab px-2 sm:px-5 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${activeTab === 'dashboard' ? 'is-active' : ''}`}>
            <TrendingUp size={15}/> 債券分析
          </button>
          <button id="primary-tab-trades" role="tab" aria-selected={activeTab === 'trades'} aria-controls="primary-panel" onClick={() => setActiveTab('trades')} className={`primary-tab px-2 sm:px-5 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${activeTab === 'trades' ? 'is-active' : ''}`}>
            <History size={15}/> 債券帳本
          </button>
          <button id="primary-tab-ytm" role="tab" aria-selected={activeTab === 'ytm'} aria-controls="primary-panel" onClick={() => setActiveTab('ytm')} className={`primary-tab px-2 sm:px-5 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${activeTab === 'ytm' ? 'is-active' : ''}`}>
            <Calculator size={15}/> 到期收益率試算
          </button>
        </div>
        </div>
        <div id="primary-panel" role="tabpanel" aria-labelledby={`primary-tab-${activeTab}`}>
          {activeTab === 'dashboard' ? renderDashboard() : activeTab === 'ytm' ? renderYtmCalculator() : renderTrades()}
        </div>
      </main>

      {isFormOpen && (
        <div className="modal-backdrop fixed inset-0 flex items-center justify-center p-3 sm:p-4 z-50">
          <div ref={tradeDialogRef} role="dialog" aria-modal="true" aria-labelledby="trade-dialog-title" className="modal-panel rounded-2xl w-full max-w-md overflow-hidden">
            <div className="modal-header p-5 flex justify-between items-center"><h2 id="trade-dialog-title" className="text-lg font-bold">{editingTradeId ? '編輯交易' : '新增債券交易'}</h2><button onClick={() => setIsFormOpen(false)} className="modal-close text-xl font-bold" aria-label="關閉">&times;</button></div>
            <div className="p-5 overflow-y-auto max-h-[60vh]">
              <form id="tradeForm" onSubmit={handleSaveTrade} className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="col-span-2">
                      <label htmlFor="trade-cusip" className="block text-xs font-medium text-slate-500 mb-1">CUSIP／名稱</label>
                      <input id="trade-cusip" required name="cusip" value={formData.cusip} onChange={(e)=>setFormData({...formData, cusip: e.target.value})} className="w-full p-2 border rounded-lg text-sm" />
                    </div>
                    <div>
                      <label htmlFor="trade-type" className="block text-xs font-medium text-slate-500 mb-1">債券類型</label>
                      <select id="trade-type" required name="type" value={formData.type} onChange={(e)=>setFormData({...formData, type: e.target.value, couponRate: e.target.value==='t-bill'?0:formData.couponRate, couponFrequency: e.target.value==='t-bill'?0:2})} className="w-full p-2 border rounded-lg text-sm"><option value="t-bill">短期國庫券（T-Bill）</option><option value="t-note">中期國庫券（T-Note）</option><option value="t-bond">長期國庫券（T-Bond）</option><option value="tips" disabled>通脹保值國債（TIPS，暫未支援）</option></select>
                    </div>
                    <div>
                      <label htmlFor="trade-side" className="block text-xs font-medium text-slate-500 mb-1">交易方向</label>
                      <select id="trade-side" required name="side" value={formData.side} onChange={(e)=>setFormData({...formData, side: e.target.value})} className="w-full p-2 border rounded-lg text-sm"><option value="buy">買入</option><option value="sell">賣空</option></select>
                    </div>
                    <div>
                      <label htmlFor="trade-date" className="block text-xs font-medium text-slate-500 mb-1">買入／開倉交收日</label>
                      <input id="trade-date" required type="date" name="tradeDate" value={formData.tradeDate} onChange={(e)=>setFormData({...formData, tradeDate: e.target.value})} className="w-full p-2 border rounded-lg text-sm" />
                    </div>
                    <div>
                      <label htmlFor="trade-maturity-date" className="block text-xs font-medium text-slate-500 mb-1">到期日</label>
                      <input id="trade-maturity-date" required type="date" name="maturityDate" value={formData.maturityDate} onChange={(e)=>setFormData({...formData, maturityDate: e.target.value})} className="w-full p-2 border rounded-lg text-sm" />
                    </div>
                    <div>
                      <label htmlFor="trade-face-value" className="block text-xs font-medium text-slate-500 mb-1">面值（美元）</label>
                      <input id="trade-face-value" required type="number" name="faceValue" value={formData.faceValue} onChange={(e)=>setFormData({...formData, faceValue: e.target.value})} className="w-full p-2 border rounded-lg text-sm" />
                    </div>
                    <div>
                      <label htmlFor="trade-clean-price" className="block text-xs font-medium text-slate-500 mb-1">淨價</label>
                      <input id="trade-clean-price" required type="number" step="0.001" name="cleanPrice" value={formData.cleanPrice} onChange={(e)=>setFormData({...formData, cleanPrice: e.target.value})} className="w-full p-2 border rounded-lg text-sm" />
                    </div>
                    <div>
                      <label htmlFor="trade-commission" className="block text-xs font-medium text-slate-500 mb-1">手續費（美元）</label>
                      <input id="trade-commission" type="number" step="0.01" name="commission" value={formData.commission} onChange={(e)=>setFormData({...formData, commission: e.target.value})} className="w-full p-2 border rounded-lg text-sm" />
                    </div>
                    {formData.type !== 't-bill' && (<>
                      <div className="col-span-2">
                        <label htmlFor="trade-coupon-rate" className="block text-xs font-medium text-slate-500 mb-1">票息率（%）</label>
                        <input id="trade-coupon-rate" required type="number" step="0.125" name="couponRate" value={formData.couponRate} onChange={(e)=>setFormData({...formData, couponRate: e.target.value})} className="w-full p-2 border rounded-lg text-sm" />
                      </div>
                      <div className="col-span-2">
                        <label htmlFor="trade-coupon-frequency" className="block text-xs font-medium text-slate-500 mb-1">派息頻率</label>
                        <select id="trade-coupon-frequency" name="couponFrequency" value={formData.couponFrequency} onChange={(e)=>setFormData({...formData, couponFrequency: e.target.value})} className="w-full p-2 border rounded-lg text-sm">
                          {Number(formData.couponFrequency) !== 2 && <option value={formData.couponFrequency} disabled>舊資料頻率不受支援，請改為半年一次</option>}
                          <option value="2">半年一次</option>
                        </select>
                      </div>
                    </>)}
                  </div>
              </form>
              {isCouponTreasury(formData) && (
                <div className="mt-4">
                  <label htmlFor="trade-accrued-interest" className="block text-xs font-medium text-slate-500 mb-1">每 100 元面值的應計利息（可選）</label>
                  <input id="trade-accrued-interest" type="number" min="0" step="0.001" value={formData.accruedInterestPer100 || ''} onChange={(e)=>setFormData({...formData, accruedInterestPer100: e.target.value})} placeholder="自動計算" className="w-full p-2 border rounded-lg text-sm" />
                </div>
              )}
            </div>
            <div className="modal-footer p-5 flex justify-end space-x-3"><button onClick={() => setIsFormOpen(false)} className="secondary-button px-4 py-2 text-sm font-medium rounded-lg">取消</button><button type="submit" form="tradeForm" className="primary-button px-4 py-2 text-sm font-medium rounded-lg">儲存交易</button></div>
          </div>
        </div>
      )}
      
      {/* 平倉彈出視窗 */}
      {isCloseModalOpen && (
        <div className="modal-backdrop fixed inset-0 flex items-center justify-center p-3 sm:p-4 z-50">
          <div ref={closeDialogRef} role="dialog" aria-modal="true" aria-labelledby="close-dialog-title" className="modal-panel rounded-2xl w-full max-w-sm overflow-hidden">
            <div className="modal-header modal-header--warning p-5 flex justify-between items-center"><h2 id="close-dialog-title" className="text-lg font-bold flex items-center"><LogOut size={20} className="mr-2"/> 平倉結算</h2></div>
            <form id="closeForm" onSubmit={handleClosePosition} className="p-5 space-y-4">
              <p className="text-sm text-slate-600 mb-4">平倉後，該筆債券會移入「已結算區」，利潤會按全價（淨價加應計利息）鎖定。</p>
              <div><label htmlFor="close-date" className="block text-xs font-medium text-slate-500 mb-1">賣出／平倉交收日</label><input id="close-date" required type="date" value={closeData.closeDate} onChange={(e)=>setCloseData({...closeData, closeDate: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div>
              <div><label htmlFor="close-price" className="block text-xs font-medium text-slate-500 mb-1">成交淨價</label><input id="close-price" required type="number" step="0.001" value={closeData.closePrice} onChange={(e)=>setCloseData({...closeData, closePrice: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div>
              {isCouponTreasury(trades.find((trade) => trade.id === closingTradeId)) && <div><label htmlFor="close-accrued-interest" className="block text-xs font-medium text-slate-500 mb-1">每 100 元面值的平倉應計利息（可選）</label><input id="close-accrued-interest" type="number" min="0" step="0.001" value={closeData.closeAccruedInterestPer100} onChange={(e)=>setCloseData({...closeData, closeAccruedInterestPer100: e.target.value})} placeholder="自動計算" className="w-full p-2 border rounded-lg text-sm" /></div>}
              <div><label htmlFor="close-commission" className="block text-xs font-medium text-slate-500 mb-1">平倉手續費（美元）</label><input id="close-commission" type="number" step="0.01" value={closeData.closeCommission} onChange={(e)=>setCloseData({...closeData, closeCommission: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div>
            </form>
            <div className="modal-footer p-5 flex justify-end space-x-3"><button onClick={() => setIsCloseModalOpen(false)} className="secondary-button px-4 py-2 text-sm font-medium rounded-lg">取消</button><button type="submit" form="closeForm" className="danger-button px-4 py-2 text-sm font-medium rounded-lg">確認平倉</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
