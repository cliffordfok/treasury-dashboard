import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Plus, Trash2, Edit2, TrendingUp, DollarSign, Activity, Calendar, Bot, Loader2, AlertCircle, Archive, Wallet, Clock, LogOut, History, Landmark, Download, Upload, RefreshCw, Calculator, KeyRound } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceDot } from 'recharts';
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, onSnapshot, doc, setDoc, deleteDoc } from 'firebase/firestore';
import {
  calculateAccruedInterestPer100,
  calculateActiveUnrealizedPnl,
  calculateClosedTradePricePnl,
  calculateDaysBetween,
  calculateForwardDaysBetween,
  calculateMaturedTradePricePnl,
  calculateTradePricePnl,
  formatDateOnly,
  generateAllCoupons,
  getDirtyPrice,
  getMarketYTMFromCurve,
  getQuotedAccruedInterestPer100,
  getTradeYTM,
  isCouponTreasury,
  isMatured,
  isSupportedTreasuryType,
  isValidISODate,
  makeTradeId,
  normalizeTradeForStorage,
  solveYTMFromPrice,
  toDateAtMidnight,
  toFiniteNumber,
  yieldToPrice,
} from './lib/treasuryMath.js';

// --- 真實環境 Firebase 設定 (使用環境變數) ---
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

// --- AI Proxy Configuration ---
// The key is supplied by the signed-in user and kept in memory for this page session only.
const aiProxyUrl = import.meta.env.VITE_AI_PROXY_URL || import.meta.env.VITE_GEMINI_PROXY_URL || "";
const AI_ANALYSIS_MODEL = 'deepseek-v4-pro';
const DEEPSEEK_CHAT_API_URL = 'https://api.deepseek.com/chat/completions';

const fetchYieldCurve = async ({ bypassCache = false } = {}) => {
  const base = import.meta.env.BASE_URL || '/';
  const suffix = bypassCache ? `?refresh=${Date.now()}` : '';
  const res = await fetch(`${base}yield-curve.json${suffix}`, { cache: bypassCache ? 'no-store' : 'default' });
  if (!res.ok) throw new Error(`收益率曲線資料請求失敗（HTTP ${res.status}）`);
  const data = await res.json();
  if (!data.points || data.points.length === 0) throw new Error('yield-curve.json 無資料');
  return data;
};

const fetchWithRetry = async (url, options, retries = 3, timeoutMs = 15000) => {
  const delays = [1000, 2000, 4000];
  for (let i = 0; i < retries; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        const error = new Error(`HTTP error! status: ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      return await response.json();
    } catch (e) {
      if (i === retries - 1 || e.retryable === false) throw e;
      await new Promise(res => setTimeout(res, delays[i]));
    } finally {
      clearTimeout(timeoutId);
    }
  }
};

const getAiRequestHeaders = (userApiKey = '') => {
  const headers = { 'Content-Type': 'application/json' };
  const key = String(userApiKey || '').trim();
  if (key) headers['X-DeepSeek-API-Key'] = key;
  return headers;
};

const stripCodeFence = (text) =>
  String(text || '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();

const parseJsonObject = (text) => {
  const cleaned = stripCodeFence(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('人工智能回應未包含 JSON');
    return JSON.parse(match[0]);
  }
};

const buildTradeExtractionPrompt = (rawText) => `Extract one US Treasury trade from the text.

Return only valid JSON with these fields:
{
  "cusip": string,
  "type": "t-bill" | "t-note" | "t-bond",
  "side": "buy" | "sell",
  "tradeDate": "YYYY-MM-DD",
  "maturityDate": "YYYY-MM-DD",
  "faceValue": number,
  "cleanPrice": number,
  "couponRate": number,
  "couponFrequency": number,
  "commission": number,
  "accruedInterestPer100": number | ""
}

Rules:
- Use "buy" unless the text clearly says sell/short.
- Use clean price, not dirty price, when both are present.
- T-Bill couponRate must be 0 and couponFrequency must be 0.
- For T-Note/T-Bond, default couponFrequency to 2 when not stated.
- Use an empty string for unknown optional accruedInterestPer100.
- Do not include markdown or explanatory text.

Trade text:
${rawText}`;

const callDeepSeekDirect = async ({ messages, userApiKey, temperature = 0.2, responseFormat }) => {
  const key = String(userApiKey || '').trim();
  if (!key) throw new Error('未設定 DeepSeek API Key');

  const payload = {
    model: AI_ANALYSIS_MODEL,
    messages,
    temperature,
  };
  if (responseFormat) payload.response_format = responseFormat;

  const result = await fetchWithRetry(DEEPSEEK_CHAT_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = result?.choices?.[0]?.message?.content;
  if (!text) throw new Error('DeepSeek 沒有回傳內容');
  return text;
};

const extractTradeData = async (rawText, userApiKey = '') => {
  if (!aiProxyUrl && String(userApiKey || '').trim()) {
    const text = await callDeepSeekDirect({
      userApiKey,
      messages: [
        { role: 'system', content: 'Extract structured Treasury trade data. Return JSON only.' },
        { role: 'user', content: buildTradeExtractionPrompt(String(rawText || '')) },
      ],
      temperature: 0,
      responseFormat: { type: 'json_object' },
    });
    return parseJsonObject(text);
  }
  if (aiProxyUrl) {
    const result = await fetchWithRetry(aiProxyUrl, {
      method: 'POST',
      headers: getAiRequestHeaders(userApiKey),
      body: JSON.stringify({ task: 'extractTradeData', rawText }),
    });
    return result.trade || result.data || result;
  }
  throw new Error('未提供 DeepSeek API Key');
};

const roundMarketPriceForStorage = (price) => Math.round(price * 1000) / 1000;

const YieldCurveTooltip = ({ active, label, payload }) => {
  const years = Number(label ?? payload?.[0]?.payload?.years);
  const yieldValue = Number(payload?.[0]?.value ?? payload?.[0]?.payload?.yield);
  if (!active || !Number.isFinite(years) || !Number.isFinite(yieldValue)) return null;

  return (
    <div className="yield-tooltip" role="tooltip">
      <div className="yield-tooltip-row">
        <span>年期</span>
        <strong>{years.toFixed(2)} 年</strong>
      </div>
      <div className="yield-tooltip-row">
        <span>收益率</span>
        <strong>{yieldValue.toFixed(3)}%</strong>
      </div>
    </div>
  );
};

export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [trades, setTrades] = useState([]);
  const [isDbReady, setIsDbReady] = useState(false);
  const [dbError, setDbError] = useState('');

  const [activeTab, setActiveTab] = useState('trades');
  const [ledgerSubTab, setLedgerSubTab] = useState('active'); 
  
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingTradeId, setEditingTradeId] = useState(null);
  const [smartInputMode, setSmartInputMode] = useState(false);
  
  const [isCloseModalOpen, setIsCloseModalOpen] = useState(false);
  const [closingTradeId, setClosingTradeId] = useState(null);
  
  const [editingPriceId, setEditingPriceId] = useState(null);
  const [newPrice, setNewPrice] = useState('');

  const [rawTradeText, setRawTradeText] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  const [userDeepSeekApiKey, setUserDeepSeekApiKey] = useState('');
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [isApiKeyOpen, setIsApiKeyOpen] = useState(false);

  // --- FRED Yield Curve ---
  const [yieldCurve, setYieldCurve] = useState(null);
  const [yieldCurveError, setYieldCurveError] = useState('');
  const [isFetchingCurve, setIsFetchingCurve] = useState(true);

  const defaultForm = { cusip: '', type: 't-note', side: 'buy', tradeDate: formatDateOnly(new Date()), maturityDate: '', faceValue: 1000, cleanPrice: 100, couponRate: 0, commission: 0, couponFrequency: 2, accruedInterestPer100: '' };
  const defaultYtmForm = { type: 't-note', tradeDate: formatDateOnly(new Date()), maturityDate: '', faceValue: 1000, cleanPrice: 100, couponRate: 4, couponFrequency: 2, commission: 0, accruedInterestPer100: '' };
  const [formData, setFormData] = useState(defaultForm);
  const [ytmForm, setYtmForm] = useState(defaultYtmForm);
  const [closeData, setCloseData] = useState({ closeDate: formatDateOnly(new Date()), closePrice: '', closeCommission: 0, closeAccruedInterestPer100: '' });
  const [selectedBenchmark, setSelectedBenchmark] = useState('UST10Y');
  const [importAuditLog, setImportAuditLog] = useState([]);
  const hasUserDeepSeekApiKey = Boolean(userDeepSeekApiKey.trim());
  const hasAiTransport = hasUserDeepSeekApiKey;

  const saveTradeToDB = useCallback(async (tradeData) => {
    if (!user) return;
    const tradeRef = doc(db, 'users', user.uid, 'trades', tradeData.id);
    await setDoc(tradeRef, tradeData);
  }, [user]);

  // --- Firebase Auth 監聽 (改為 Google 登入) ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (!currentUser) {
        setTrades([]);
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

  // --- 當 yield curve 載入後，自動用市場 yield 計算理論價格更新所有活躍持倉 ---
  const priceUpdatesInFlightRef = useRef(new Set());
  useEffect(() => {
    if (!yieldCurve?.points?.length || !user || !isDbReady) return;
    const curveDate = yieldCurve.updatedAt;
    if (!curveDate) return;
    const toUpdate = trades.filter(t =>
      isSupportedTreasuryType(t)
      && t.status !== 'closed'
      && !isMatured(t.maturityDate)
      && t.priceUpdatedAt !== curveDate
      && !priceUpdatesInFlightRef.current.has(t.id)
    );
    for (const trade of toUpdate) {
      priceUpdatesInFlightRef.current.add(trade.id);
      (async () => {
        try {
          const valuationDate = toDateAtMidnight(new Date());
          const days = calculateForwardDaysBetween(valuationDate, trade.maturityDate);
          if (!days || days <= 0) return;
          const remainingYears = days / 365.25;
          const marketYield = getMarketYTMFromCurve(yieldCurve, remainingYears);
          if (marketYield == null) return;
          const newMktPrice = yieldToPrice(trade, marketYield, valuationDate);
          if (newMktPrice == null || !Number.isFinite(newMktPrice) || newMktPrice <= 0) return;
          const accruedInterestPer100 = calculateAccruedInterestPer100(trade, valuationDate);
          const cleanMarketPrice = isCouponTreasury(trade) ? newMktPrice - accruedInterestPer100 : newMktPrice;
          if (!Number.isFinite(cleanMarketPrice) || cleanMarketPrice <= 0) return;
          await saveTradeToDB({ ...trade, currentMarketPrice: roundMarketPriceForStorage(cleanMarketPrice), priceUpdatedAt: curveDate });
        } catch (err) {
          console.error('更新市場價格失敗：', trade.id, err);
        } finally {
          priceUpdatesInFlightRef.current.delete(trade.id);
        }
      })();
    }
  }, [yieldCurve, trades, user, isDbReady, saveTradeToDB]);

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
      const fetchedTrades = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setTrades(fetchedTrades);
      setIsDbReady(true);
      setDbError('');
    }, (error) => {
      console.error("Firestore 錯誤：", error);
      setDbError('無法同步 Firestore。請檢查網絡、Firebase 設定及安全規則後重試。');
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

  const handleLogout = () => {
    signOut(auth);
  };

  // --- Derived Data ---
  const activeTrades = useMemo(() => trades.filter(t => t.status !== 'closed' && !isMatured(t.maturityDate)), [trades]);
  const maturedTrades = useMemo(() => trades.filter(t => t.status !== 'closed' && isMatured(t.maturityDate)), [trades]);
  const closedTrades = useMemo(() => trades.filter(t => t.status === 'closed'), [trades]);
  const unsupportedTips = useMemo(() => trades.filter(t => t.type === 'tips'), [trades]);
  const supportedActiveTrades = useMemo(() => activeTrades.filter(isSupportedTreasuryType), [activeTrades]);
  const supportedMaturedTrades = useMemo(() => maturedTrades.filter(isSupportedTreasuryType), [maturedTrades]);
  const supportedClosedTrades = useMemo(() => closedTrades.filter(isSupportedTreasuryType), [closedTrades]);
  const allCoupons = useMemo(() => trades.filter(isSupportedTreasuryType).flatMap(generateAllCoupons), [trades]);
  // Dashboard valuation date is fixed at page load; reload the app to refresh it.
  const todayObj = useMemo(() => { const d = new Date(); d.setHours(0,0,0,0); return d; }, []);
  const receivedCoupons = useMemo(() => allCoupons.filter(c => c.date <= todayObj), [allCoupons, todayObj]);
  const upcomingCouponsList = useMemo(() => allCoupons.filter(c => c.date > todayObj && c.date.getFullYear() === todayObj.getFullYear()), [allCoupons, todayObj]);

  // --- PnL Calculations ---
  const portfolioMetrics = useMemo(() => {
    let totalMarketValue = 0; let totalUnrealizedPnL = 0; let totalWeightYTM = 0; let totalFace = 0; let totalAccruedInterest = 0; let totalYtmMarketValue = 0; let totalRealizedPnL = 0; let annualCouponIncome = 0;
    receivedCoupons.forEach(c => totalRealizedPnL += c.amount);
    supportedClosedTrades.forEach(t => { totalRealizedPnL += calculateClosedTradePricePnl(t) ?? 0; });
    supportedMaturedTrades.forEach(t => { totalRealizedPnL += calculateMaturedTradePricePnl(t) ?? 0; });
    supportedActiveTrades.forEach(trade => {
      const price = Number(trade.currentMarketPrice);
      if (!Number.isFinite(price) || price <= 0) return;
      const faceValue = Number(trade.faceValue) || 0;
      const mult = trade.side === 'sell' ? -1 : 1;
      const marketVal = ((price * faceValue) / 100) * mult;
      const accruedInterestPer100 = calculateAccruedInterestPer100(trade, todayObj);
      const accruedValue = ((accruedInterestPer100 * faceValue) / 100) * mult;
      totalMarketValue += marketVal;
      totalAccruedInterest += accruedValue;
      totalUnrealizedPnL += calculateActiveUnrealizedPnl(trade, todayObj) ?? 0;
      totalFace += faceValue * mult;
      if (isCouponTreasury(trade) && trade.couponRate) {
        annualCouponIncome += (faceValue * (Number(trade.couponRate) / 100)) * mult;
      }
    });
    const totalFullMarketValue = totalMarketValue + totalAccruedInterest;
    supportedActiveTrades.forEach(trade => {
      const cleanPrice = Number(trade.currentMarketPrice);
      if (!Number.isFinite(cleanPrice) || cleanPrice <= 0) return;
      const mult = trade.side === 'sell' ? -1 : 1;
      const accruedInterestPer100 = calculateAccruedInterestPer100(trade, todayObj);
      const dirtyPrice = isCouponTreasury(trade) ? getDirtyPrice(cleanPrice, accruedInterestPer100) : cleanPrice;
      if (!Number.isFinite(dirtyPrice) || dirtyPrice <= 0) return;
      const marketVal = ((dirtyPrice * (Number(trade.faceValue) || 0)) / 100) * mult;
      const ytm = getTradeYTM(trade, todayObj);
      if (ytm == null) return;
      const absoluteMarketVal = Math.abs(marketVal);
      totalWeightYTM += ytm * absoluteMarketVal;
      totalYtmMarketValue += absoluteMarketVal;
    });
    totalWeightYTM = totalYtmMarketValue > 0 ? totalWeightYTM / totalYtmMarketValue : null;
    return { totalMarketValue, totalUnrealizedPnL, totalWeightYTM, totalFace, totalAccruedInterest, totalFullMarketValue, totalRealizedPnL, monthlyAvgIncome: annualCouponIncome / 12 };
  }, [supportedActiveTrades, supportedMaturedTrades, supportedClosedTrades, receivedCoupons, todayObj]);

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
      return { cusip: t.cusip || t.type.toUpperCase(), x: remainingYears, y: marketYtm, side: t.side };
    }).filter(d => d?.y != null);
    return {
      curvePoints,
      bondDots,
      spread2s10s: Number.isFinite(twoYearYield) && Number.isFinite(tenYearYield) ? tenYearYield - twoYearYield : null,
      spreadPoints: sourceCurvePoints.filter(p => p.years === 2 || p.years === 10),
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
    const accruedInterestPer100 = getQuotedAccruedInterestPer100(trade, tradeDate);
    const dirtyPrice = getDirtyPrice(cleanPrice, accruedInterestPer100);
    if (dirtyPrice == null) return { isValid: false };
    const priceWithCommission = dirtyPrice + ((commission / faceValue) * 100);
    const grossYtm = solveYTMFromPrice(trade, dirtyPrice, tradeDate);
    const netYtm = solveYTMFromPrice(trade, priceWithCommission, tradeDate);
    const cleanPrincipalCost = (cleanPrice * faceValue) / 100;
    const accruedInterestValue = (accruedInterestPer100 * faceValue) / 100;
    const principalCost = (dirtyPrice * faceValue) / 100;
    const totalCost = principalCost + commission;
    const redemptionValue = faceValue;
    const annualCoupon = ytmForm.type === 't-bill' ? 0 : faceValue * (couponRate / 100);
    const couponEstimate = annualCoupon * years;
    const maturityProfit = redemptionValue + couponEstimate - totalCost;
    const breakevenPrice = 100 + ((couponEstimate - commission) / faceValue) * 100;
    const marketYield = getMarketYTMFromCurve(yieldCurve, years);

    return {
      isValid: true,
      days,
      years,
      faceValue,
      cleanPrice,
      accruedInterestPer100,
      accruedInterestValue,
      dirtyPrice,
      priceWithCommission,
      cleanPrincipalCost,
      principalCost,
      totalCost,
      redemptionValue,
      couponEstimate,
      maturityProfit,
      breakevenPrice,
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
      status: 'active',
    });
    await saveTradeToDB(tradeData);
    setLedgerSubTab('active');
    setActiveTab('trades');
  };

  const deleteTradeFromDB = async (id) => {
    if (!user) return;
    await deleteDoc(doc(db, 'users', user.uid, 'trades', id));
  };

  const handleSaveTrade = async (e) => {
    e.preventDefault();
    if (!isSupportedTreasuryType(formData)) {
      alert('TIPS 暫未支援，請選擇 T-Bill、T-Note 或 T-Bond。');
      return;
    }
    if (!isValidISODate(formData.tradeDate) || !isValidISODate(formData.maturityDate) || toDateAtMidnight(formData.maturityDate) <= toDateAtMidnight(formData.tradeDate)) {
      alert('請輸入有效交易日及較後的到期日。');
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
    if (isCouponTreasury(formData) && (!Number.isFinite(couponRate) || couponRate < 0 || ![1, 2, 4, 12].includes(couponFrequency))) {
      alert('請輸入有效票息率及派息頻率。');
      return;
    }
    const existingTrade = editingTradeId ? trades.find(t => t.id === editingTradeId) : null;
    const tradeData = normalizeTradeForStorage({
      ...existingTrade,
      ...formData,
      status: editingTradeId ? (formData.status || existingTrade?.status || 'active') : 'active',
    });
    if (!editingTradeId) {
      tradeData.id = makeTradeId();
      tradeData.currentMarketPrice = tradeData.cleanPrice;
    } else {
      tradeData.id = editingTradeId;
      tradeData.currentMarketPrice = toFiniteNumber(existingTrade?.currentMarketPrice, tradeData.cleanPrice);
    }
    await saveTradeToDB(tradeData);
    setIsFormOpen(false); setEditingTradeId(null);
  };

  const handleClosePosition = async (e) => {
    e.preventDefault();
    const trade = trades.find(t => t.id === closingTradeId);
    if (!trade) return;
    if (!isValidISODate(closeData.closeDate) || toDateAtMidnight(closeData.closeDate) < toDateAtMidnight(trade.tradeDate) || toDateAtMidnight(closeData.closeDate) > toDateAtMidnight(trade.maturityDate)) {
      alert('平倉日期必須介乎交易日與到期日之間。');
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
    });
    await saveTradeToDB(updatedTrade);
    setIsCloseModalOpen(false);
  };

  const handleUpdatePrice = async (id) => {
    const n = Number(newPrice);
    if (!Number.isFinite(n) || n <= 0) {
      alert('請輸入有效價格');
      return;
    }
    const trade = trades.find(t => t.id === id);
    if (trade) await saveTradeToDB({ ...trade, currentMarketPrice: roundMarketPriceForStorage(n) });
    setEditingPriceId(null);
  };

  const openApiKeySettings = () => {
    setApiKeyDraft(userDeepSeekApiKey);
    setIsApiKeyOpen(true);
  };

  const handleSaveApiKey = () => {
    const key = apiKeyDraft.trim();
    setUserDeepSeekApiKey(key);
    setIsApiKeyOpen(false);
  };

  const handleClearApiKey = () => {
    setUserDeepSeekApiKey('');
    setApiKeyDraft('');
    setIsApiKeyOpen(false);
  };

  const handleSmartParse = async () => {
    if (!rawTradeText.trim()) return;
    if (!hasAiTransport) { alert("請先按「設定 API Key」輸入 DeepSeek 金鑰。"); return; }
    setIsParsing(true);
    try {
      const parsedData = await extractTradeData(rawTradeText, userDeepSeekApiKey);
      if (!isSupportedTreasuryType(parsedData)) throw new Error('暫未支援 TIPS');
      setFormData({ ...defaultForm, ...parsedData });
      setSmartInputMode(false); setRawTradeText('');
    } catch { alert("無法解析文字，請檢查格式。"); } finally { setIsParsing(false); }
  };

  // --- 匯出 / 匯入 ---
  const handleExport = () => {
    if (trades.length === 0) return;
    const data = JSON.stringify(trades, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `treasury-backup-${formatDateOnly(new Date())}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const imported = JSON.parse(text);
        if (!Array.isArray(imported)) { alert('檔案格式錯誤：需要為交易陣列。'); return; }
        const existingIds = new Set(trades.map(t => t.id));
        const existingFingerprints = new Set(trades.map(t => `${t.cusip || ''}|${t.tradeDate || ''}|${Number(t.faceValue) || 0}`));
        const validTypes = new Set(['t-bill', 't-note', 't-bond']);
        const validSides = new Set(['buy', 'sell']);
        const validFreq = new Set([1, 2, 4, 12]);
        const validStatus = new Set(['active', 'closed', undefined, null, '']);
        const errors = [];
        let added = 0;

        for (let i = 0; i < imported.length; i++) {
          const prefix = `第 ${i + 1} 筆`;
          const rawTrade = imported[i];
          if (!rawTrade || typeof rawTrade !== 'object' || Array.isArray(rawTrade)) { errors.push(`${prefix}：格式不是物件`); continue; }
          const trade = normalizeTradeForStorage(rawTrade);
          if (existingIds.has(trade.id)) { errors.push(`${prefix}：交易識別碼（id）重複`); continue; }
          if (trade.type === 'tips') { errors.push(`${prefix}：TIPS 暫未支援，資料未匯入`); continue; }
          if (!validTypes.has(trade.type)) { errors.push(`${prefix}：債券類型（type）無效`); continue; }
          if (!validSides.has(trade.side)) { errors.push(`${prefix}：交易方向（side）無效`); continue; }
          if (!validStatus.has(imported[i]?.status)) { errors.push(`${prefix}：狀態（status）無效`); continue; }
          if (!isValidISODate(trade.tradeDate) || !isValidISODate(trade.maturityDate)) { errors.push(`${prefix}：日期格式或日期值無效`); continue; }
          if (toDateAtMidnight(trade.maturityDate) <= toDateAtMidnight(trade.tradeDate)) { errors.push(`${prefix}：到期日（maturityDate）必須晚於交易日（tradeDate）`); continue; }
          if (!Number.isFinite(trade.faceValue) || trade.faceValue <= 0) { errors.push(`${prefix}：面值（faceValue）無效`); continue; }
          if (!Number.isFinite(trade.cleanPrice) || trade.cleanPrice <= 0) { errors.push(`${prefix}：淨價（cleanPrice）無效`); continue; }
          if (!Number.isFinite(trade.currentMarketPrice) || trade.currentMarketPrice <= 0) { errors.push(`${prefix}：目前市場價格（currentMarketPrice）無效`); continue; }
          if (!Number.isFinite(trade.commission) || trade.commission < 0) { errors.push(`${prefix}：手續費（commission）無效`); continue; }
          if (trade.type !== 't-bill' && (!Number.isFinite(trade.couponRate) || trade.couponRate < 0)) { errors.push(`${prefix}：票息率（couponRate）無效`); continue; }
          if (trade.type !== 't-bill' && !validFreq.has(trade.couponFrequency)) { errors.push(`${prefix}：派息頻率（couponFrequency）無效`); continue; }
          if (trade.status === 'closed' && (!isValidISODate(trade.closeDate) || toDateAtMidnight(trade.closeDate) < toDateAtMidnight(trade.tradeDate) || toDateAtMidnight(trade.closeDate) > toDateAtMidnight(trade.maturityDate) || !Number.isFinite(trade.closePrice) || trade.closePrice <= 0 || trade.closeCommission < 0)) { errors.push(`${prefix}：已平倉交易缺少有效 closeDate／closePrice`); continue; }

          const fp = `${trade.cusip || ''}|${trade.tradeDate || ''}|${trade.faceValue || 0}`;
          if (existingFingerprints.has(fp)) { errors.push(`${prefix}：疑似重複交易（CUSIP＋交易日期＋面值）`); continue; }

          try {
            await saveTradeToDB(trade);
            existingIds.add(trade.id);
            existingFingerprints.add(fp);
            added++;
          } catch (error) {
            console.error('匯入資料寫入失敗：', trade.id, error);
            errors.push(`${prefix}：Firestore 寫入失敗`);
          }
        }

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

  const renderDashboard = () => (
    <div className="dashboard-view space-y-4 sm:space-y-6">
      <div className="hero-card rounded-2xl p-5 sm:p-6 text-white relative overflow-hidden">
        <div className="absolute -top-2 -right-2 opacity-15 pointer-events-none"><Landmark size={140} /></div>
        <p className="hero-kicker text-xs sm:text-sm font-medium mb-1.5">美債累計已實現利潤</p>
        <p className={`hero-value font-bold tracking-tight ${portfolioMetrics.totalRealizedPnL >= 0 ? 'is-positive' : 'is-negative'}`}>{portfolioMetrics.totalRealizedPnL >= 0 ? '+' : ''}${portfolioMetrics.totalRealizedPnL.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p>
        <span className="hero-chip inline-block text-[11px] sm:text-xs px-2.5 py-1 rounded-md mt-2.5">已包含所有平倉、到期結算及歷史收息</span>
      </div>
      <div className="stats-grid grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <div className="stat-card p-4 sm:p-5 rounded-xl flex items-center gap-3 sm:gap-4">
          <div className="stat-icon stat-icon--cool p-2.5 sm:p-3 rounded-lg flex-shrink-0"><DollarSign size={20} className="sm:hidden" /><DollarSign size={24} className="hidden sm:block" /></div>
          <div className="min-w-0"><p className="text-[11px] sm:text-xs text-slate-500 font-medium">美債淨價市值</p><p className="metric-value text-base sm:text-xl font-bold text-slate-800">${portfolioMetrics.totalMarketValue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p><p className="metric-detail text-[10px] text-slate-400">全價 ${portfolioMetrics.totalFullMarketValue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} · 應計利息 ${portfolioMetrics.totalAccruedInterest.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p></div>
        </div>
        <div className="stat-card p-4 sm:p-5 rounded-xl flex items-center gap-3 sm:gap-4">
          <div className={`stat-icon p-2.5 sm:p-3 rounded-lg flex-shrink-0 ${portfolioMetrics.totalUnrealizedPnL >= 0 ? 'stat-icon--gain' : 'stat-icon--loss'}`}><Activity size={20} className="sm:hidden" /><Activity size={24} className="hidden sm:block" /></div>
          <div className="min-w-0"><p className="text-[11px] sm:text-xs text-slate-500 font-medium">美債未實現盈虧</p><p className={`metric-value text-base sm:text-xl font-bold ${portfolioMetrics.totalUnrealizedPnL >= 0 ? 'text-green-600' : 'text-red-600'}`}>{portfolioMetrics.totalUnrealizedPnL >= 0 ? '+' : ''}${portfolioMetrics.totalUnrealizedPnL.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p></div>
        </div>
        <div className="stat-card p-4 sm:p-5 rounded-xl flex items-center gap-3 sm:gap-4">
          <div className="stat-icon stat-icon--gold p-2.5 sm:p-3 rounded-lg flex-shrink-0"><TrendingUp size={20} className="sm:hidden" /><TrendingUp size={24} className="hidden sm:block" /></div>
          <div className="min-w-0"><p className="text-[11px] sm:text-xs text-slate-500 font-medium">美債加權平均 YTM</p><p className={`metric-value text-base sm:text-xl font-bold ${portfolioMetrics.totalWeightYTM == null ? 'text-slate-400' : 'text-slate-800'}`}>{portfolioMetrics.totalWeightYTM == null ? '--' : `${portfolioMetrics.totalWeightYTM.toFixed(2)}%`}</p></div>
        </div>
        <div className="stat-card p-4 sm:p-5 rounded-xl flex items-center gap-3 sm:gap-4">
          <div className="stat-icon stat-icon--gain p-2.5 sm:p-3 rounded-lg flex-shrink-0"><Wallet size={20} className="sm:hidden" /><Wallet size={24} className="hidden sm:block" /></div>
          <div className="min-w-0"><p className="text-[11px] sm:text-xs text-slate-500 font-medium">平均每月利息</p><p className="metric-value text-base sm:text-xl font-bold text-emerald-600">${portfolioMetrics.monthlyAvgIncome.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p></div>
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        <div className="glass-panel p-4 sm:p-5 rounded-xl">
          <h3 className="text-sm sm:text-base font-bold text-slate-800 mb-3 flex items-center"><TrendingUp size={16} className="mr-2 text-blue-500"/> 基準對比</h3>
          <div className="flex items-center gap-2 mb-3">
            <select value={selectedBenchmark} onChange={(e) => setSelectedBenchmark(e.target.value)} className="text-xs sm:text-sm border rounded-md px-2 py-1">
              <option value="UST10Y">UST 10 年</option>
              <option value="SGOV">SGOV（約 3 個月）</option>
              <option value="SHY">SHY（約 2 年）</option>
              <option value="IEF">IEF（約 7 年）</option>
              <option value="TLT">TLT（約 20 年）</option>
            </select>
            <span className="text-[11px] text-slate-500">曲線年期：{benchmarkMetrics.benchmarkYears} 年</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="micro-stat p-3 rounded-lg"><p className="text-[11px] text-slate-500">美債組合 YTM</p><p className={`font-bold ${benchmarkMetrics.portfolioYield == null ? 'text-slate-400' : ''}`}>{benchmarkMetrics.portfolioYield == null ? '--' : `${benchmarkMetrics.portfolioYield.toFixed(2)}%`}</p></div>
            <div className="micro-stat p-3 rounded-lg"><p className="text-[11px] text-slate-500">基準 YTM</p><p className="font-bold">{benchmarkMetrics.benchmarkYield == null ? '—' : `${benchmarkMetrics.benchmarkYield.toFixed(2)}%`}</p></div>
            <div className="micro-stat p-3 rounded-lg"><p className="text-[11px] text-slate-500">利差</p><p className={`font-bold ${benchmarkMetrics.spread == null ? 'text-slate-400' : benchmarkMetrics.spread >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{benchmarkMetrics.spread == null ? '—' : `${benchmarkMetrics.spread >= 0 ? '+' : ''}${benchmarkMetrics.spread.toFixed(2)}%`}</p></div>
          </div>
        </div>
        <div className="glass-panel p-4 sm:p-5 rounded-xl">
          <h3 className="text-sm sm:text-base font-bold text-slate-800 mb-3 flex items-center"><History size={16} className="mr-2 text-slate-600"/> 匯入稽核記錄</h3>
          {importAuditLog.length === 0 ? <p className="text-sm text-slate-500 bg-slate-50 rounded-lg p-3">尚未有匯入記錄。</p> : (
            <div className="space-y-2">
              {importAuditLog.map(log => (
                <div key={log.id} className="text-xs border rounded-lg p-2.5 bg-slate-50">
                  <p className="font-semibold text-slate-700">{new Date(log.ts).toLocaleString()} · 新增 {log.added} / {log.total}</p>
                  {log.skipped > 0 && <p className="text-amber-700">略過 {log.skipped} 筆（詳見驗證規則）</p>}
                  {log.errors?.length > 0 && <p className="text-slate-500 truncate" title={log.errors.join(' | ')}>例子：{log.errors[0]}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {yieldCurveChartData && (
        <div className="glass-panel chart-panel p-4 sm:p-6 rounded-xl">
          <div className="panel-heading flex justify-between items-center mb-4 pb-3">
            <h3 className="text-base sm:text-lg font-bold text-slate-800 flex items-center"><TrendingUp className="mr-2 text-blue-500" size={18}/> 美債收益率曲線</h3>
            <div className="chart-legend flex items-center gap-3 text-[10px]">
              {yieldCurveChartData.spread2s10s != null && <span className="spread-chip">10Y–2Y {yieldCurveChartData.spread2s10s >= 0 ? '+' : ''}{yieldCurveChartData.spread2s10s.toFixed(2)}%</span>}
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block"></span>買入</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400 inline-block"></span>賣空</span>
            </div>
          </div>
          <div className="yield-chart" aria-label="美債收益率曲線圖；移動滑鼠或觸控曲線可查看年期及收益率">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={yieldCurveChartData.curvePoints} margin={{ top: 22, right: 16, bottom: 0, left: -14 }}>
                <defs>
                  <linearGradient id="yieldLine" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="#4F8DF7" />
                    <stop offset="52%" stopColor="#E8B84B" />
                    <stop offset="100%" stopColor="#F4D477" />
                  </linearGradient>
                  <linearGradient id="yieldArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#E8B84B" stopOpacity={0.28} />
                    <stop offset="100%" stopColor="#4F8DF7" stopOpacity={0.01} />
                  </linearGradient>
                  <filter id="yieldGlow" x="-20%" y="-40%" width="140%" height="180%">
                    <feGaussianBlur stdDeviation="3" result="blur" />
                    <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                  </filter>
                </defs>
                <CartesianGrid vertical={false} strokeDasharray="3 5" stroke="rgba(148, 163, 184, 0.12)" />
                <XAxis dataKey="years" type="number" tick={{ fontSize: 10, fill: '#94A3B8' }} tickLine={false} axisLine={false} unit="年" domain={[0, 30]} />
                <YAxis tick={{ fontSize: 10, fill: '#94A3B8' }} tickLine={false} axisLine={false} tickCount={5} domain={['auto', 'auto']} unit="%" />
                <Tooltip cursor={{ stroke: 'rgba(232, 184, 75, 0.3)', strokeWidth: 1 }} content={<YieldCurveTooltip />} />
                <Area type="monotone" dataKey="yield" stroke="url(#yieldLine)" strokeWidth={2.5} fill="url(#yieldArea)" filter="url(#yieldGlow)" dot={false} activeDot={{ r: 5, fill: '#E8B84B', stroke: '#0A0E17', strokeWidth: 2 }} />
                {yieldCurveChartData.spreadPoints.map(point => (
                  <ReferenceDot key={`spread-${point.years}`} x={point.years} y={point.yield} r={5} fill="#E8B84B" stroke="#0A0E17" strokeWidth={2} label={{ value: `${point.years}Y`, position: 'top', fontSize: 9, fill: '#E8B84B', fontWeight: 700 }} />
                ))}
                {yieldCurveChartData.bondDots.map(d => (
                  <ReferenceDot key={d.cusip} x={d.x} y={d.y} r={6} fill={d.side === 'sell' ? '#F87171' : '#34D399'} stroke="#101624" strokeWidth={2.5} label={{ value: d.cusip, position: 'top', fontSize: 9, fill: '#CBD5E1', fontWeight: 600 }} />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
      <div className="glass-panel p-4 sm:p-6 rounded-xl">
        <div className="panel-heading flex justify-between items-center mb-4 pb-3">
          <h3 className="text-base sm:text-lg font-bold text-slate-800 flex items-center"><Wallet className="mr-2 text-emerald-500" size={18}/> 今年剩餘應收派息</h3>
          {upcomingCouponsList.length > 0 && <span className="text-[11px] text-slate-400 font-medium">{upcomingCouponsList.length} 筆</span>}
        </div>
        {upcomingCouponsList.length === 0 ? <p className="text-sm text-slate-500 py-6 text-center bg-slate-50 rounded-lg">今年內暫無剩餘派息。</p> : (
          <div className="payment-grid grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5 sm:gap-3">
            {upcomingCouponsList.map(c => (
              <div key={c.id} className="payment-card p-3 rounded-lg">
                <p className="text-[10px] font-semibold text-emerald-700 tracking-wide">{c.dateStr}</p>
                <p className="text-[11px] text-slate-500 truncate mt-0.5">{c.cusip}</p>
                <p className={`font-bold text-sm sm:text-base mt-1 ${c.amount >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>{c.amount >= 0 ? '+' : ''}${c.amount.toLocaleString(undefined, {minimumFractionDigits:2})}</p>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="glass-panel p-4 sm:p-6 rounded-xl">
        <div className="panel-heading flex justify-between items-center mb-4 pb-3">
          <h3 className="text-base sm:text-lg font-bold text-slate-800 flex items-center"><Calendar className="mr-2 text-emerald-500" size={18}/> 年度收息日曆 · {todayObj.getFullYear()}</h3>
          <span className="text-[11px] text-slate-400 font-medium">${couponCalendar.reduce((s, v) => s + v, 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
        </div>
        <div className="month-grid grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
          {['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'].map((label, m) => {
            const total = couponCalendar[m];
            const has = total !== 0;
            const past = m < todayObj.getMonth();
            const current = m === todayObj.getMonth();
            return (
              <div key={m} className={`month-cell p-2.5 sm:p-3 rounded-lg text-center ${has ? 'month-cell--funded' : ''} ${past ? 'month-cell--past' : ''} ${current ? 'month-cell--current' : ''}`}>
                <p className={`text-[10px] font-semibold uppercase tracking-wide ${current ? 'text-blue-600' : 'text-slate-400'}`}>{label}</p>
                <p className={`text-sm font-bold mt-1 ${has ? (total >= 0 ? 'text-emerald-600' : 'text-red-500') : 'text-slate-300'}`}>
                  {has ? `$${Math.abs(total).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '—'}
                </p>
              </div>
            );
          })}
        </div>
      </div>
      <div className="glass-panel p-4 sm:p-6 rounded-xl">
        <div className="panel-heading flex flex-wrap justify-between items-center gap-2 mb-4 pb-3">
          <div>
            <h3 className="text-base sm:text-lg font-bold text-slate-800 flex items-center"><Clock className="mr-2 text-blue-500" size={18}/> 債券到期倒數</h3>
            <p className="text-[10px] sm:text-[11px] text-slate-400 mt-1">現時 YTM 以目前市場淨價加應計利息計算，並以今日作為估值日。</p>
          </div>
          <div className="flex items-center gap-2 text-[10px] sm:text-[11px] text-slate-500">
            {yieldCurve?.updatedAt && <span className="bg-slate-100 px-2 py-0.5 rounded-md">FRED · {yieldCurve.updatedAt}</span>}
            {yieldCurveError && <span className="text-red-500 flex items-center max-w-[180px] truncate" title={yieldCurveError}><AlertCircle size={11} className="mr-1 flex-shrink-0"/>{yieldCurveError}</span>}
            <button onClick={handleRefreshCurve} disabled={isFetchingCurve} title="重新讀取市場收益率" aria-label="重新讀取市場收益率" className="p-1.5 hover:bg-slate-100 rounded-md disabled:opacity-40 transition-colors">
              {isFetchingCurve ? <Loader2 size={14} className="animate-spin"/> : <RefreshCw size={14}/>}
            </button>
          </div>
        </div>
        {activeTrades.length === 0 ? <p className="text-sm text-slate-500 py-4 text-center bg-slate-50 rounded">暫無活躍持倉。</p> : (() => {
          const sorted = [...activeTrades].sort((a, b) => String(a.maturityDate).localeCompare(String(b.maturityDate)));
          const maxDays = Math.max(...sorted.map(t => calculateDaysBetween(todayObj, t.maturityDate)), 1);
          const formatCountdown = (d) => {
            if (d < 30) return `${d} 天`;
            if (d < 365) return `${Math.floor(d/30)} 個月 ${d%30} 天`;
            return `${Math.floor(d/365)} 年 ${Math.floor((d%365)/30)} 個月`;
          };
          const getColor = (d) => {
            if (d < 30) return 'danger';
            if (d < 90) return 'warning';
            if (d < 365) return 'cool';
            return 'gain';
          };
          return (
            <div className="countdown-list space-y-2.5">
              {sorted.map(trade => {
                const days = calculateDaysBetween(todayObj, trade.maturityDate);
                const forwardDays = calculateForwardDaysBetween(todayObj, trade.maturityDate);
                const ytm = getTradeYTM(trade, todayObj);
                const pct = Math.min((days / maxDays) * 100, 100);
                const color = getColor(days);
                const marketYtm = forwardDays && forwardDays > 0 ? getMarketYTMFromCurve(yieldCurve, forwardDays / 365.25) : null;
                const delta = marketYtm != null && ytm != null ? ytm - marketYtm : null;
                return (
                  <div key={trade.id} className="countdown-row p-2.5 sm:p-0 rounded-lg space-y-2 sm:space-y-0 sm:flex sm:items-center sm:gap-3">
                    {/* Mobile：上排為 CUSIP + YTM/Market；Desktop 保持橫向 */}
                    <div className="flex items-center justify-between sm:w-32 sm:flex-shrink-0 sm:block">
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-slate-800 truncate">{trade.cusip || trade.type.toUpperCase()}</p>
                        <p className="text-[10px] text-slate-400 mt-0.5">{trade.maturityDate}</p>
                      </div>
                      {/* Mobile-only YTM / Market 顯示喺右上 */}
                      <div className="flex items-center gap-3 sm:hidden">
                        <div className="text-right">
                          <p className="text-[9px] text-slate-400 font-semibold uppercase tracking-wide leading-none mb-0.5">現價 YTM</p>
                          <p className={`text-xs font-bold ${ytm == null ? 'text-slate-300' : 'text-amber-600'}`}>{ytm == null ? '--' : `${ytm.toFixed(2)}%`}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-[9px] text-slate-400 font-semibold uppercase tracking-wide leading-none mb-0.5">曲線 YTM</p>
                          {marketYtm != null ? (
                            <p className="text-xs font-bold text-slate-700 whitespace-nowrap">
                              {marketYtm.toFixed(2)}%
                              {delta != null && (
                                <span className={`ml-1 text-[10px] ${delta >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                                  {delta >= 0 ? '+' : ''}{delta.toFixed(2)}
                                </span>
                              )}
                            </p>
                          ) : (
                            <p className="text-xs text-slate-300">—</p>
                          )}
                        </div>
                      </div>
                    </div>
                    {/* 倒數 bar：mobile 全寬，desktop flex-1 */}
                    <div className={`countdown-track countdown-track--${color} w-full sm:flex-1 h-7 rounded-md overflow-hidden relative`}>
                      <progress className="countdown-progress" max="100" value={pct} aria-label={`${trade.cusip || trade.type} 到期進度`} />
                      <span className="absolute inset-0 flex items-center px-3 text-xs font-bold">{formatCountdown(days)}</span>
                    </div>
                    {/* Desktop-only YTM / Market columns */}
                    <div className="hidden sm:block w-16 flex-shrink-0 text-right">
                      <p className="text-[9px] text-slate-400 font-semibold uppercase tracking-wide">現價 YTM</p>
                      <p className={`text-xs font-bold ${ytm == null ? 'text-slate-300' : 'text-amber-600'}`}>{ytm == null ? '--' : `${ytm.toFixed(2)}%`}</p>
                    </div>
                    <div className="hidden sm:block w-24 flex-shrink-0 text-right">
                      <p className="text-[9px] text-slate-400 font-semibold uppercase tracking-wide">曲線 YTM</p>
                      {marketYtm != null ? (
                        <p className="text-xs font-bold text-slate-700">
                          {marketYtm.toFixed(2)}%
                          {delta != null && (
                            <span className={`ml-1 text-[10px] ${delta >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                              {delta >= 0 ? '+' : ''}{delta.toFixed(2)}
                            </span>
                          )}
                        </p>
                      ) : (
                        <p className="text-xs text-slate-300">—</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>
    </div>
  );

  const renderYtmCalculator = () => {
    const update = (field, value) => setYtmForm(prev => ({ ...prev, [field]: value }));
    const money = (value) => Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
                <label className="block text-xs font-medium text-slate-500 mb-1">債券類型</label>
                <select value={ytmForm.type} onChange={(e) => setYtmForm(prev => ({ ...prev, type: e.target.value, accruedInterestPer100: e.target.value === 't-bill' ? '' : prev.accruedInterestPer100 }))} className="w-full p-2 border rounded-lg text-sm bg-white">
                  <option value="t-bill">短期國庫券（T-Bill）</option>
                  <option value="t-note">中期國庫券（T-Note）</option>
                  <option value="t-bond">長期國庫券（T-Bond）</option>
                  <option value="tips" disabled>通脹保值國債（TIPS，暫未支援）</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">面值</label>
                <input type="number" min="1" step="100" value={ytmForm.faceValue} onChange={(e) => update('faceValue', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">交易日期</label>
                <input type="date" value={ytmForm.tradeDate} onChange={(e) => update('tradeDate', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">到期日</label>
                <input type="date" value={ytmForm.maturityDate} onChange={(e) => update('maturityDate', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">市場報價（潔淨價格）</label>
                <input type="number" min="0.001" step="0.001" value={ytmForm.cleanPrice} onChange={(e) => update('cleanPrice', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">手續費</label>
                <input type="number" min="0" step="0.01" value={ytmForm.commission} onChange={(e) => update('commission', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
              </div>
              {ytmForm.type !== 't-bill' && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">票息率 (%)</label>
                    <input type="number" min="0" step="0.125" value={ytmForm.couponRate} onChange={(e) => update('couponRate', e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">派息頻率</label>
                    <select value={ytmForm.couponFrequency} onChange={(e) => update('couponFrequency', e.target.value)} className="w-full p-2 border rounded-lg text-sm bg-white">
                      <option value="2">半年一次</option>
                      <option value="1">每年一次</option>
                      <option value="4">每季一次</option>
                      <option value="12">每月一次</option>
                    </select>
                  </div>
                  {isCouponTreasury(ytmForm) && (
                    <div className="col-span-2">
                      <label className="block text-xs font-medium text-slate-500 mb-1">每 100 元面值的應計利息（可選）</label>
                      <input type="number" min="0" step="0.001" value={ytmForm.accruedInterestPer100} onChange={(e) => update('accruedInterestPer100', e.target.value)} placeholder="自動計算" className="w-full p-2 border rounded-lg text-sm" />
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
                  <div className="quote-grid grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <div className="quote-card quote-card--primary p-3 rounded-lg">
                      <p className="text-[11px] text-blue-700 font-semibold">扣除結算成本後 YTM</p>
                      <p className="text-xl font-bold text-blue-700 mt-1">{pct(ytmQuote.netYtm)}</p>
                    </div>
                    <div className="quote-card p-3 rounded-lg">
                      <p className="text-[11px] text-slate-500 font-semibold">淨價參考 YTM</p>
                      <p className="text-xl font-bold text-slate-800 mt-1">{pct(ytmQuote.grossYtm)}</p>
                    </div>
                    <div className="quote-card quote-card--gain p-3 rounded-lg">
                      <p className="text-[11px] text-emerald-700 font-semibold">曲線息差</p>
                      <p className={`text-xl font-bold mt-1 ${ytmQuote.spreadToCurve == null ? 'text-slate-400' : ytmQuote.spreadToCurve >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                        {ytmQuote.spreadToCurve == null ? '--' : `${ytmQuote.spreadToCurve >= 0 ? '+' : ''}${ytmQuote.spreadToCurve.toFixed(3)}%`}
                      </p>
                    </div>
                  </div>

                  <div className="calculator-details grid grid-cols-2 gap-3 text-sm">
                    <div className="p-3 rounded-lg border bg-white">
                      <p className="text-[11px] text-slate-500 font-semibold">淨價</p>
                      <p className="font-bold text-slate-800">{ytmQuote.cleanPrice.toFixed(3)}</p>
                    </div>
                    <div className="p-3 rounded-lg border bg-white">
                      <p className="text-[11px] text-slate-500 font-semibold">每 100 元面值的應計利息</p>
                      <p className="font-bold text-slate-800">{ytmQuote.accruedInterestPer100.toFixed(3)}</p>
                    </div>
                    <div className="p-3 rounded-lg border bg-white">
                      <p className="text-[11px] text-slate-500 font-semibold">全價</p>
                      <p className="font-bold text-slate-800">{ytmQuote.dirtyPrice.toFixed(3)}</p>
                    </div>
                    <div className="p-3 rounded-lg border bg-white">
                      <p className="text-[11px] text-slate-500 font-semibold">每 100 元面值的全價連手續費</p>
                      <p className="font-bold text-slate-800">{ytmQuote.priceWithCommission.toFixed(3)}</p>
                    </div>
                    <div className="p-3 rounded-lg border bg-white">
                      <p className="text-[11px] text-slate-500 font-semibold">距離到期</p>
                      <p className="font-bold text-slate-800">{ytmQuote.days.toLocaleString()} 日</p>
                    </div>
                    <div className="p-3 rounded-lg border bg-white">
                      <p className="text-[11px] text-slate-500 font-semibold">總成本</p>
                      <p className="font-bold text-slate-800">${money(ytmQuote.totalCost)}</p>
                    </div>
                    <div className="p-3 rounded-lg border bg-white">
                      <p className="text-[11px] text-slate-500 font-semibold">到期估算利潤</p>
                      <p className={`font-bold ${ytmQuote.maturityProfit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{ytmQuote.maturityProfit >= 0 ? '+' : ''}${money(ytmQuote.maturityProfit)}</p>
                    </div>
                    <div className="p-3 rounded-lg border bg-white">
                      <p className="text-[11px] text-slate-500 font-semibold">估算票息收入</p>
                      <p className="font-bold text-slate-800">${money(ytmQuote.couponEstimate)}</p>
                    </div>
                    <div className="p-3 rounded-lg border bg-white">
                      <p className="text-[11px] text-slate-500 font-semibold">打和價格</p>
                      <p className="font-bold text-slate-800">{ytmQuote.breakevenPrice.toFixed(3)}</p>
                    </div>
                  </div>

                  {ytmQuote.marketYield != null && (
                    <div className="curve-strip p-3 rounded-lg text-white text-sm flex flex-wrap justify-between gap-2">
                      <span className="text-slate-300">FRED 曲線插值（{ytmQuote.years.toFixed(2)} 年）</span>
                      <span className="font-bold">{ytmQuote.marketYield.toFixed(3)}%</span>
                    </div>
                  )}

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
        <div className="ledger-tabs flex gap-1 sm:gap-6 px-2 sm:px-4 pt-2">
          <button onClick={() => setLedgerSubTab('active')} className={`pb-2.5 px-2 text-xs sm:text-sm font-bold flex items-center border-b-2 whitespace-nowrap transition-colors ${ledgerSubTab === 'active' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}><Activity size={14} className="mr-1.5"/> 活躍 ({activeTrades.length})</button>
          <button onClick={() => setLedgerSubTab('closed')} className={`pb-2.5 px-2 text-xs sm:text-sm font-bold flex items-center border-b-2 whitespace-nowrap transition-colors ${ledgerSubTab === 'closed' ? 'border-slate-800 text-slate-800' : 'border-transparent text-slate-500 hover:text-slate-700'}`}><Archive size={14} className="mr-1.5"/> 已結算 ({maturedTrades.length + closedTrades.length})</button>
          <button onClick={() => setLedgerSubTab('coupons')} className={`pb-2.5 px-2 text-xs sm:text-sm font-bold flex items-center border-b-2 whitespace-nowrap transition-colors ${ledgerSubTab === 'coupons' ? 'border-emerald-600 text-emerald-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}><History size={14} className="mr-1.5"/> 收息 ({receivedCoupons.length})</button>
        </div>
        <div className="table-shell">
          {ledgerSubTab === 'coupons' ? (
             <table className="data-table coupon-table w-full text-left text-sm whitespace-nowrap"><thead><tr><th className="p-4">派息日期</th><th className="p-4">CUSIP／類型</th><th className="p-4 text-right">派息金額（美元）</th></tr></thead><tbody>{receivedCoupons.length === 0 ? <tr><td colSpan="3" className="p-8 text-center text-slate-400">尚未有派息紀錄。</td></tr> : [...receivedCoupons].sort((a,b) => b.date - a.date).map(c => (<tr key={c.id}><td data-label="DATE" className="p-4 font-medium text-slate-700">{c.dateStr}</td><td data-label="CUSIP" className="p-4 text-slate-600">{c.cusip}</td><td data-label="AMOUNT" className={`p-4 text-right font-bold ${c.amount >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>{c.amount >= 0 ? '+' : ''}${c.amount.toLocaleString(undefined, {minimumFractionDigits:2})}</td></tr>))}</tbody></table>
          ) : (
            <table className="data-table holdings-table w-full text-left text-sm whitespace-nowrap">
              <thead>
                <tr><th className="p-4">CUSIP</th><th className="p-4">方向／類型</th><th className="p-4 text-right">面值</th><th className="p-4 text-right">成本（淨價）</th>{ledgerSubTab === 'active' ? <><th className="p-4 text-right text-blue-600">市場淨價</th><th className="p-4 text-right">未實現損益</th></> : <><th className="p-4 text-right">平倉價</th><th className="p-4 text-right text-emerald-600">已實現損益</th></>}<th className="p-4 text-center">操作</th></tr>
              </thead>
              <tbody>
                {displayedTrades.length === 0 ? <tr><td colSpan="8" className="p-8 text-center text-slate-400">無紀錄。</td></tr> : displayedTrades.map(trade => {
                  const isMaturedBond = isMatured(trade.maturityDate) && trade.status !== 'closed';
                  const isUnsupported = !isSupportedTreasuryType(trade);
                  const pnl = calculateTradePricePnl(trade, todayObj);
                  const faceValue = toFiniteNumber(trade.faceValue);
                  const cleanPrice = toFiniteNumber(trade.cleanPrice);
                  const marketPrice = toFiniteNumber(trade.currentMarketPrice, cleanPrice);
                  const accruedInterestPer100 = calculateAccruedInterestPer100(trade, todayObj);
                  const dirtyPrice = getDirtyPrice(marketPrice, accruedInterestPer100) || marketPrice;
                  const closePrice = toFiniteNumber(trade.closePrice, marketPrice);
                  return (
                    <tr key={trade.id}>
                      <td data-label="CUSIP" className="p-4 font-medium">{trade.cusip || '--'}<div className="text-[10px] text-slate-400">到期：{trade.maturityDate}</div></td>
                      <td data-label="TYPE" className="p-4"><span className={`trade-side ${trade.side === 'sell' ? 'trade-side--sell' : 'trade-side--buy'} px-2 py-0.5 rounded text-[10px] font-bold mr-1`}>{trade.side === 'sell' ? '賣空' : '買入'}</span><span className={`treasury-badge treasury-badge--${trade.type} px-2 py-0.5 rounded text-[10px] font-bold`}>{{ 't-bill': '短期國庫券', 't-note': '中期國庫券', 't-bond': '長期國庫券', tips: '通脹保值國債' }[trade.type] || trade.type}</span>{isUnsupported && <div className="text-[10px] text-red-600 mt-1 font-bold">暫不支援計算</div>}{isMaturedBond && <div className="text-[10px] text-amber-600 mt-1 font-bold">已到期</div>}{trade.status === 'closed' && <div className="text-[10px] text-slate-500 mt-1">已平倉（{trade.closeDate}）</div>}</td>
                      <td data-label="FACE" className="p-4 text-right">${faceValue.toLocaleString()}</td><td data-label="COST" className="p-4 text-right">{cleanPrice.toFixed(3)}</td>
                      {ledgerSubTab === 'active' ? (
                        <><td data-label="MARKET" className="p-4 text-right">{editingPriceId === trade.id ? (<div className="flex items-center justify-end"><input aria-label="新市場價格" type="number" step="0.001" className="w-20 border rounded px-1 text-right" value={newPrice} onChange={e=>setNewPrice(e.target.value)}/><button onClick={()=>handleUpdatePrice(trade.id)} className="text-green-600 text-xs ml-1 font-bold">儲存</button></div>) : (<div className="text-right"><button type="button" className="text-blue-600 font-medium flex items-center justify-end ml-auto" onClick={()=>{setEditingPriceId(trade.id); setNewPrice(marketPrice);}}>{marketPrice.toFixed(3)} <Edit2 size={12} className="ml-1 opacity-50"/></button>{isCouponTreasury(trade) && <div className="text-[10px] text-slate-400">應計利息 {accruedInterestPer100.toFixed(3)} · 全價 {dirtyPrice.toFixed(3)}</div>}</div>)}</td><td data-label="P&L" className={`p-4 text-right font-bold ${pnl == null ? 'text-slate-400' : pnl>=0?'text-green-600':'text-red-600'}`}>{pnl == null ? '--' : <>{pnl>=0?'+':''}${pnl.toLocaleString(undefined,{minimumFractionDigits:2})}</>}</td></>
                      ) : (
                        <><td data-label="CLOSE" className="p-4 text-right font-medium">{trade.status === 'closed' ? closePrice.toFixed(3) : '100.000（面值）'}</td><td data-label="P&L" className={`p-4 text-right font-bold ${pnl == null ? 'text-slate-400' : pnl>=0?'text-emerald-600':'text-red-600'}`}>{pnl == null ? '--' : <>{pnl>=0?'+':''}${pnl.toLocaleString(undefined,{minimumFractionDigits:2})}</>}</td></>
                      )}
                      <td data-label="ACTIONS" className="p-4 text-center"><div className="flex items-center justify-center space-x-2"><button aria-label="編輯交易" title="編輯交易" onClick={()=>{setFormData(trade); setEditingTradeId(trade.id); setIsFormOpen(true);}} className="icon-button text-blue-500 p-1 rounded"><Edit2 size={16} /></button>{ledgerSubTab === 'active' && <button aria-label="平倉" onClick={()=>{setClosingTradeId(trade.id); setCloseData({ closeDate: formatDateOnly(new Date()), closePrice: trade.currentMarketPrice, closeCommission: 0, closeAccruedInterestPer100: '' }); setIsCloseModalOpen(true);}} className="icon-button text-orange-500 p-1 rounded" title="平倉"><LogOut size={16} /></button>}<button aria-label="刪除交易" title="刪除交易" onClick={() => deleteTradeFromDB(trade.id)} className="icon-button text-red-500 p-1 rounded"><Trash2 size={16} /></button></div></td>
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
              <span className="text-xs text-slate-300 hidden lg:inline truncate max-w-[160px]">{user.email}</span>
              <button onClick={handleExport} disabled={trades.length === 0} className="nav-action text-xs sm:text-sm px-2.5 py-1.5 rounded-md flex items-center gap-1" title="匯出資料">
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
        {unsupportedTips.length > 0 && (
          <div role="status" className="status-banner status-banner--warning mb-4 rounded-xl px-4 py-3 text-sm flex items-start gap-2">
            <AlertCircle size={17} className="mt-0.5 flex-shrink-0" />
            <span>偵測到 {unsupportedTips.length} 筆既有 TIPS。資料仍保留在帳本，但在加入 CPI 指數比率模型前不會計入估值、YTM、利息或損益。</span>
          </div>
        )}
        <div className="primary-nav-wrap mb-5">
        <div className="primary-tabs grid grid-cols-3 gap-1 p-1 rounded-xl">
          <button onClick={() => setActiveTab('trades')} className={`primary-tab px-2 sm:px-5 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${activeTab === 'trades' ? 'is-active' : ''}`}>
            <History size={15}/> 債券帳本
          </button>
          <button onClick={() => setActiveTab('ytm')} className={`primary-tab px-2 sm:px-5 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${activeTab === 'ytm' ? 'is-active' : ''}`}>
            <Calculator size={15}/> 到期收益率試算
          </button>
          <button onClick={() => setActiveTab('dashboard')} className={`primary-tab px-2 sm:px-5 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 ${activeTab === 'dashboard' ? 'is-active' : ''}`}>
            <TrendingUp size={15}/> 債券分析
          </button>
        </div>
        </div>
        {activeTab === 'dashboard' ? renderDashboard() : activeTab === 'ytm' ? renderYtmCalculator() : renderTrades()}
      </main>

      {isFormOpen && (
        <div className="modal-backdrop fixed inset-0 flex items-center justify-center p-3 sm:p-4 z-50">
          <div className="modal-panel rounded-2xl w-full max-w-md overflow-hidden">
            <div className="modal-header p-5 flex justify-between items-center"><h2 className="text-lg font-bold">{editingTradeId ? '編輯交易' : '新增債券交易'}</h2><button onClick={() => setIsFormOpen(false)} className="modal-close text-xl font-bold" aria-label="關閉">&times;</button></div>
            {!editingTradeId && (<div className="px-5 pt-4"><div className="flex bg-slate-100 p-1 rounded-lg"><button type="button" onClick={() => setSmartInputMode(false)} className={`flex-1 py-1.5 text-sm font-medium rounded-md ${!smartInputMode ? 'bg-white shadow text-slate-800' : 'text-slate-500'}`}>手動輸入</button><button type="button" onClick={() => setSmartInputMode(true)} className={`flex-1 py-1.5 text-sm font-medium rounded-md ${smartInputMode ? 'bg-indigo-500 text-white shadow' : 'text-slate-500'}`}>✨ 智能貼上</button></div></div>)}
            <div className="p-5 overflow-y-auto max-h-[60vh]">
              {smartInputMode && !editingTradeId ? (
                <div className="space-y-4">
                  <div className="ai-panel rounded-lg p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-slate-800">人工智能交易單據解析</p>
                        <p className="text-xs text-slate-500 mt-0.5">只用於把債券交易文字轉成目前債券表單格式。</p>
                      </div>
                      <button type="button" onClick={openApiKeySettings} className={`border px-3 py-2 rounded-lg text-xs font-semibold transition-colors flex items-center ${hasUserDeepSeekApiKey ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-white border-indigo-200 text-indigo-700'}`}>
                        <KeyRound size={14} className="mr-1.5" /> {hasUserDeepSeekApiKey ? '個人金鑰已設定' : '設定 API Key'}
                      </button>
                    </div>
                    {isApiKeyOpen && (
                      <div className="mt-3 space-y-2">
                        <input type="password" value={apiKeyDraft} onChange={(e) => setApiKeyDraft(e.target.value)} placeholder="貼上你的 DeepSeek API Key" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" autoComplete="off" />
                        <div className="flex flex-wrap gap-2">
                          <button type="button" onClick={handleSaveApiKey} className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-2 rounded-lg text-xs font-semibold">儲存</button>
                          {hasUserDeepSeekApiKey && <button type="button" onClick={handleClearApiKey} className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-2 rounded-lg text-xs font-semibold">清除</button>}
                          <button type="button" onClick={() => setIsApiKeyOpen(false)} className="bg-white hover:bg-slate-50 text-slate-600 border border-slate-200 px-3 py-2 rounded-lg text-xs font-semibold">取消</button>
                        </div>
                        <p className="text-[11px] text-slate-500">金鑰只保留在目前頁面的記憶體；重新載入或關閉頁面後會自動清除，不會寫入 Firestore 或備份檔。</p>
                      </div>
                    )}
                  </div>
                  <textarea value={rawTradeText} onChange={(e) => setRawTradeText(e.target.value)} placeholder="貼上債券交易單據..." className="w-full h-32 p-3 border rounded-lg text-sm" />
                  <button type="button" onClick={handleSmartParse} disabled={isParsing || !rawTradeText.trim() || !hasAiTransport} className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center justify-center">{isParsing ? <Loader2 size={16} className="animate-spin mr-2" /> : <Bot size={16} className="mr-2" />} 讀取單據</button>
                </div>
              ) : (<>
                <form id="tradeForm" onSubmit={handleSaveTrade} className="space-y-4"><div className="grid grid-cols-2 gap-4"><div className="col-span-2"><label className="block text-xs font-medium text-slate-500 mb-1">CUSIP／名稱</label><input required name="cusip" value={formData.cusip} onChange={(e)=>setFormData({...formData, cusip: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div><div><label className="block text-xs font-medium text-slate-500 mb-1">債券類型</label><select required name="type" value={formData.type} onChange={(e)=>setFormData({...formData, type: e.target.value, couponRate: e.target.value==='t-bill'?0:formData.couponRate})} className="w-full p-2 border rounded-lg text-sm"><option value="t-bill">短期國庫券（T-Bill）</option><option value="t-note">中期國庫券（T-Note）</option><option value="t-bond">長期國庫券（T-Bond）</option><option value="tips" disabled>通脹保值國債（TIPS，暫未支援）</option></select></div><div><label className="block text-xs font-medium text-slate-500 mb-1">交易方向</label><select required name="side" value={formData.side} onChange={(e)=>setFormData({...formData, side: e.target.value})} className="w-full p-2 border rounded-lg text-sm"><option value="buy">買入</option><option value="sell">賣空</option></select></div><div><label className="block text-xs font-medium text-slate-500 mb-1">交易日期</label><input required type="date" name="tradeDate" value={formData.tradeDate} onChange={(e)=>setFormData({...formData, tradeDate: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div><div><label className="block text-xs font-medium text-slate-500 mb-1">到期日</label><input required type="date" name="maturityDate" value={formData.maturityDate} onChange={(e)=>setFormData({...formData, maturityDate: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div><div><label className="block text-xs font-medium text-slate-500 mb-1">面值（美元）</label><input required type="number" name="faceValue" value={formData.faceValue} onChange={(e)=>setFormData({...formData, faceValue: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div><div><label className="block text-xs font-medium text-slate-500 mb-1">淨價</label><input required type="number" step="0.001" name="cleanPrice" value={formData.cleanPrice} onChange={(e)=>setFormData({...formData, cleanPrice: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div><div><label className="block text-xs font-medium text-slate-500 mb-1">手續費（美元）</label><input type="number" step="0.01" name="commission" value={formData.commission} onChange={(e)=>setFormData({...formData, commission: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div>{formData.type !== 't-bill' && (<><div className="col-span-2"><label className="block text-xs font-medium text-slate-500 mb-1">票息率（%）</label><input required type="number" step="0.125" name="couponRate" value={formData.couponRate} onChange={(e)=>setFormData({...formData, couponRate: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div><div className="col-span-2"><label className="block text-xs font-medium text-slate-500 mb-1">派息頻率</label><select name="couponFrequency" value={formData.couponFrequency} onChange={(e)=>setFormData({...formData, couponFrequency: e.target.value})} className="w-full p-2 border rounded-lg text-sm"><option value="12">每月一次</option><option value="4">每季一次</option><option value="2">半年一次</option><option value="1">每年一次</option></select></div></>)}</div></form>
                {isCouponTreasury(formData) && (
                  <div className="mt-4">
                    <label className="block text-xs font-medium text-slate-500 mb-1">每 100 元面值的應計利息（可選）</label>
                    <input type="number" min="0" step="0.001" value={formData.accruedInterestPer100 || ''} onChange={(e)=>setFormData({...formData, accruedInterestPer100: e.target.value})} placeholder="自動計算" className="w-full p-2 border rounded-lg text-sm" />
                  </div>
                )}
              </>)}
            </div>
            <div className="modal-footer p-5 flex justify-end space-x-3"><button onClick={() => setIsFormOpen(false)} className="secondary-button px-4 py-2 text-sm font-medium rounded-lg">取消</button>{!smartInputMode && <button type="submit" form="tradeForm" className="primary-button px-4 py-2 text-sm font-medium rounded-lg">儲存交易</button>}</div>
          </div>
        </div>
      )}
      
      {/* 平倉彈出視窗 */}
      {isCloseModalOpen && (
        <div className="modal-backdrop fixed inset-0 flex items-center justify-center p-3 sm:p-4 z-50">
          <div className="modal-panel rounded-2xl w-full max-w-sm overflow-hidden">
            <div className="modal-header modal-header--warning p-5 flex justify-between items-center"><h2 className="text-lg font-bold flex items-center"><LogOut size={20} className="mr-2"/> 平倉結算</h2></div>
            <form id="closeForm" onSubmit={handleClosePosition} className="p-5 space-y-4">
              <p className="text-sm text-slate-600 mb-4">平倉後，該筆債券會移入「已結算區」，利潤會按全價（淨價加應計利息）鎖定。</p>
              <div><label className="block text-xs font-medium text-slate-500 mb-1">賣出/平倉日期</label><input required type="date" value={closeData.closeDate} onChange={(e)=>setCloseData({...closeData, closeDate: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div>
              <div><label className="block text-xs font-medium text-slate-500 mb-1">成交淨價</label><input required type="number" step="0.001" value={closeData.closePrice} onChange={(e)=>setCloseData({...closeData, closePrice: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div>
              {isCouponTreasury(trades.find((trade) => trade.id === closingTradeId)) && <div><label className="block text-xs font-medium text-slate-500 mb-1">每 100 元面值的平倉應計利息（可選）</label><input type="number" min="0" step="0.001" value={closeData.closeAccruedInterestPer100} onChange={(e)=>setCloseData({...closeData, closeAccruedInterestPer100: e.target.value})} placeholder="自動計算" className="w-full p-2 border rounded-lg text-sm" /></div>}
              <div><label className="block text-xs font-medium text-slate-500 mb-1">平倉手續費（美元）</label><input type="number" step="0.01" value={closeData.closeCommission} onChange={(e)=>setCloseData({...closeData, closeCommission: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div>
            </form>
            <div className="modal-footer p-5 flex justify-end space-x-3"><button onClick={() => setIsCloseModalOpen(false)} className="secondary-button px-4 py-2 text-sm font-medium rounded-lg">取消</button><button type="submit" form="closeForm" className="danger-button px-4 py-2 text-sm font-medium rounded-lg">確認平倉</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
