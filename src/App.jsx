import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Plus, Trash2, Edit2, TrendingUp, DollarSign, Activity, Calendar, PieChart, Sparkles, Bot, Loader2, CheckCircle2, AlertCircle, BellRing, Archive, Wallet, Clock, LogOut, History, Landmark, Download, Upload, RefreshCw, Calculator, KeyRound, Briefcase, Banknote, Copy, FileJson, ShieldAlert, XCircle } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceDot } from 'recharts';
import { initializeApp } from 'firebase/app';
// --- 更新咗呢度：引入 Google 登入相關功能 ---
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, onSnapshot, doc, setDoc, deleteDoc } from 'firebase/firestore';
import StockDashboard from './features/stocks/StockDashboard';
import CashDashboard from './features/cash/CashDashboard';
import PortfolioOverview from './features/portfolio/PortfolioOverview';
import ImportPreviewDashboard from './features/import/ImportPreviewDashboard';
import { subscribeStockTrades } from './features/stocks/stockFirestore';
import { calculateStockPositions, normalizeSymbol } from './features/stocks/stockCalculations';
import { subscribeCashMovements } from './features/cash/cashFirestore';
import { subscribeStockPrices } from './features/prices/stockPriceFirestore';
import { buildPortfolioAiSnapshot } from './features/ai/portfolioAiSnapshot';
import { AI_MODE_LABELS, buildPortfolioAiMessages } from './features/ai/portfolioAiPrompts';
import { buildAiSnapshotSummary, detectForbiddenAdvice, isSingleStockModeReady, parseAiReportSections, sanitizeAiSnapshotForCopy } from './features/ai/portfolioAiReport';

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
const googleProvider = new GoogleAuthProvider(); // 初始化 Google 登入

// --- AI Proxy Configuration ---
// Production builds must call a backend/proxy so provider keys never ship to browsers.
const aiProxyUrl = import.meta.env.VITE_AI_PROXY_URL || import.meta.env.VITE_GEMINI_PROXY_URL || "";
const isAiConfigured = Boolean(aiProxyUrl);
const AI_ANALYSIS_MODEL = 'deepseek-v4-pro';
const AI_USER_KEY_STORAGE_KEY = 'treasuryDashboard.deepseekApiKey';
const DEEPSEEK_CHAT_API_URL = 'https://api.deepseek.com/chat/completions';

// --- FRED API Configuration ---
const fredApiKey = import.meta.env.VITE_FRED_API_KEY || "";

// FRED Treasury constant-maturity series. years = 到期年期對應的 curve point。
const FRED_YIELD_SERIES = [
  { id: 'DGS1MO', years: 1 / 12 },
  { id: 'DGS3MO', years: 3 / 12 },
  { id: 'DGS6MO', years: 6 / 12 },
  { id: 'DGS1',   years: 1 },
  { id: 'DGS2',   years: 2 },
  { id: 'DGS3',   years: 3 },
  { id: 'DGS5',   years: 5 },
  { id: 'DGS7',   years: 7 },
  { id: 'DGS10',  years: 10 },
  { id: 'DGS20',  years: 20 },
  { id: 'DGS30',  years: 30 },
];

// Dev: Vite proxy 即時拉 FRED
// Prod: 讀 GitHub Actions 預生成嘅 static JSON（完全無 CORS 問題）
const fetchYieldCurveFromFRED = async () => {
  if (!fredApiKey) throw new Error('未設定 VITE_FRED_API_KEY');
  const FRED_BASE = '/fred-proxy/fred';
  const attempts = await Promise.all(FRED_YIELD_SERIES.map(async ({ id, years }) => {
    const url = `${FRED_BASE}/series/observations?series_id=${id}&api_key=${fredApiKey}&file_type=json&sort_order=desc&limit=1`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, id, error: `HTTP ${res.status} ${text.slice(0, 80)}` };
      }
      const data = await res.json();
      const obs = data.observations?.[0];
      const v = Number(obs?.value);
      if (!Number.isFinite(v)) return { ok: false, id, error: 'no observation value' };
      return { ok: true, id, years, yield: v, date: obs.date };
    } catch (e) {
      return { ok: false, id, error: e.message || String(e) };
    }
  }));
  const points = attempts.filter(a => a.ok).sort((a, b) => a.years - b.years);
  const failures = attempts.filter(a => !a.ok);
  if (failures.length) console.warn('[FRED] failures:', failures);
  if (points.length === 0) {
    const reason = failures[0]?.error || 'unknown';
    throw new Error(`FRED 無回傳資料 (${reason})`);
  }
  return { points, updatedAt: points[0].date };
};

const fetchYieldCurveFromStatic = async () => {
  const base = import.meta.env.BASE_URL || '/';
  const res = await fetch(`${base}yield-curve.json`);
  if (!res.ok) throw new Error(`yield-curve.json HTTP ${res.status}`);
  const data = await res.json();
  if (!data.points || data.points.length === 0) throw new Error('yield-curve.json 無資料');
  return data;
};

const fetchYieldCurve = async () => {
  if (import.meta.env.DEV && fredApiKey) {
    return fetchYieldCurveFromFRED();
  }
  return fetchYieldCurveFromStatic();
};

// 依據 maturity 年期用 linear interpolation 在 yield curve 查出對應市場 YTM。
// 超出最短/最長期則夾在端點（flat extrapolation）。
const getMarketYTMFromCurve = (curve, years) => {
  if (!curve || !curve.points || curve.points.length === 0) return null;
  if (!Number.isFinite(years) || years <= 0) return null;
  const pts = curve.points;
  if (years <= pts[0].years) return pts[0].yield;
  if (years >= pts[pts.length - 1].years) return pts[pts.length - 1].yield;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (years >= a.years && years <= b.years) {
      const t = (years - a.years) / (b.years - a.years);
      return a.yield + t * (b.yield - a.yield);
    }
  }
  return null;
};

const fetchWithRetry = async (url, options, retries = 5) => {
  const delays = [1000, 2000, 4000, 8000, 16000];
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return await response.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(res => setTimeout(res, delays[i]));
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
    if (!match) throw new Error('AI response did not contain JSON');
    return JSON.parse(match[0]);
  }
};

const buildTradeExtractionPrompt = (rawText) => `Extract one US Treasury trade from the text.

Return only valid JSON with these fields:
{
  "cusip": string,
  "type": "t-bill" | "t-note" | "t-bond" | "tips",
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
  if (!text) throw new Error('DeepSeek response was empty');
  return text;
};

const generateText = async (promptOrMessages, userApiKey = '') => {
  const messages = Array.isArray(promptOrMessages)
    ? promptOrMessages
    : [
      { role: 'system', content: 'You are a concise fixed-income portfolio analyst.' },
      { role: 'user', content: String(promptOrMessages || '') },
    ];
  const prompt = messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n');
  if (!aiProxyUrl && String(userApiKey || '').trim()) {
    return callDeepSeekDirect({
      userApiKey,
      messages,
      temperature: 0.3,
    });
  }
  if (aiProxyUrl) {
    const result = await fetchWithRetry(aiProxyUrl, {
      method: 'POST',
      headers: getAiRequestHeaders(userApiKey),
      body: JSON.stringify({ task: 'generateText', prompt, model: AI_ANALYSIS_MODEL }),
    });
    return result.text || result.response || "無法獲取 AI 回應。";
  }
  throw new Error('未設定 AI proxy');
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
  throw new Error('未設定 AI proxy');
};

// --- Math & Date Engine ---
const isMatured = (maturityDateStr) => {
  const today = new Date(); today.setHours(0, 0, 0, 0); return new Date(maturityDateStr) < today;
};
const MS_PER_DAY = 1000 * 60 * 60 * 24;
const toDateAtMidnight = (value) => {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date;
};
const calculateDaysBetween = (date1, date2) => Math.ceil(Math.abs(new Date(date2) - new Date(date1)) / MS_PER_DAY);
const calculateForwardDaysBetween = (date1, date2) => {
  const start = toDateAtMidnight(date1);
  const end = toDateAtMidnight(date2);
  if (!start || !end) return null;
  return Math.ceil((end - start) / MS_PER_DAY);
};

const getTBillInvestmentYield = (price, days) => {
  if (!Number.isFinite(price) || price <= 0 || !days || days <= 0) return null;
  // Investment yield, not bank discount yield.
  return ((100 - price) / price) * (365 / days) * 100;
};
const roundMarketPriceForStorage = (price) => Math.round(price * 1000) / 1000;
const isCouponTreasury = (trade) => trade?.type === 't-note' || trade?.type === 't-bond';
const addMonths = (date, months) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
};
const isSameDate = (a, b) => a && b && a.getTime() === b.getTime();

const getCouponDates = (trade) => {
  if (!isCouponTreasury(trade)) return [];
  const maturityDate = toDateAtMidnight(trade.maturityDate);
  const frequency = Number(trade.couponFrequency);
  if (!maturityDate || !Number.isFinite(frequency) || frequency <= 0) return [];
  const intervalMonths = 12 / frequency;
  const dates = [];
  let d = new Date(maturityDate);
  for (let i = 0; i < frequency * 50; i++) {
    dates.push(new Date(d));
    d = addMonths(d, -intervalMonths);
  }
  return dates.sort((a, b) => a - b);
};

const getPreviousNextCouponDates = (trade, settlementDate) => {
  if (!isCouponTreasury(trade)) return null;
  const settlement = toDateAtMidnight(settlementDate);
  const maturityDate = toDateAtMidnight(trade.maturityDate);
  const frequency = Number(trade.couponFrequency);
  if (!settlement || !maturityDate || settlement >= maturityDate || !Number.isFinite(frequency) || frequency <= 0) return null;
  const intervalMonths = 12 / frequency;
  let next = new Date(maturityDate);
  for (let i = 0; i < frequency * 50; i++) {
    const previous = addMonths(next, -intervalMonths);
    if (previous <= settlement && settlement < next) return { previous, next };
    if (isSameDate(previous, settlement)) return { previous, next };
    next = previous;
  }
  return null;
};

const calculateAccruedInterestPer100 = (trade, settlementDate) => {
  if (!isCouponTreasury(trade)) return 0;
  const couponRate = Number(trade.couponRate);
  const frequency = Number(trade.couponFrequency);
  if (!Number.isFinite(couponRate) || couponRate <= 0 || !Number.isFinite(frequency) || frequency <= 0) return 0;
  const couponWindow = getPreviousNextCouponDates(trade, settlementDate);
  if (!couponWindow) return 0;
  const daysAccrued = calculateForwardDaysBetween(couponWindow.previous, settlementDate);
  const daysInPeriod = calculateForwardDaysBetween(couponWindow.previous, couponWindow.next);
  if (!daysAccrued || daysAccrued <= 0 || !daysInPeriod || daysInPeriod <= 0) return 0;
  const accruedFraction = daysAccrued / daysInPeriod;
  return (couponRate / frequency) * accruedFraction;
};

const getDirtyPrice = (cleanPrice, accruedInterestPer100) => {
  const clean = Number(cleanPrice);
  const accrued = Number(accruedInterestPer100);
  if (!Number.isFinite(clean) || clean <= 0) return null;
  return clean + (Number.isFinite(accrued) ? accrued : 0);
};

const getAccruedInterestPer100 = (trade, settlementDate) => {
  if (!isCouponTreasury(trade)) return 0;
  const manual = trade.accruedInterestPer100;
  if (manual !== undefined && manual !== null && String(manual).trim() !== '') {
    const manualNumber = Number(manual);
    return Number.isFinite(manualNumber) && manualNumber >= 0 ? manualNumber : 0;
  }
  return calculateAccruedInterestPer100(trade, settlementDate);
};

const yieldToPrice = (trade, marketYieldPercent, valuationDate) => {
  if (!Number.isFinite(marketYieldPercent)) return null;
  const matDate = toDateAtMidnight(trade.maturityDate);
  const valuation = toDateAtMidnight(valuationDate);
  const daysToMaturity = calculateForwardDaysBetween(valuation, matDate);
  if (!matDate || !valuation || !daysToMaturity || daysToMaturity <= 0) return null;
  const y = marketYieldPercent / 100;
  if (trade.type === 't-bill') {
    return 100 / (1 + y * (daysToMaturity / 365));
  }
  const freq = Number(trade.couponFrequency) || 2;
  const couponPerPeriod = (Number(trade.couponRate) || 0) / freq;
  const yPerPeriod = y / freq;
  if (yPerPeriod <= -1) return null;
  const intervalMonths = 12 / freq;
  const periods = [];
  let d = new Date(matDate);
  while (d > valuation) {
    periods.push(Math.ceil((d - valuation) / MS_PER_DAY));
    d = new Date(d); d.setMonth(d.getMonth() - intervalMonths);
  }
  if (periods.length === 0) return null;
  periods.sort((a, b) => a - b);
  const daysPerPeriod = 365.25 / freq;
  let price = 0;
  for (const dc of periods) {
    price += couponPerPeriod / Math.pow(1 + yPerPeriod, dc / daysPerPeriod);
  }
  price += 100 / Math.pow(1 + yPerPeriod, periods[periods.length - 1] / daysPerPeriod);
  return price;
};

const solveYTMFromPrice = (trade, targetPrice, valuationDate) => {
  if (!Number.isFinite(targetPrice) || targetPrice <= 0) return null;
  const daysToMaturity = calculateForwardDaysBetween(valuationDate, trade.maturityDate);
  if (!daysToMaturity || daysToMaturity <= 0) return null;
  if (trade.type === 't-bill') {
    return getTBillInvestmentYield(targetPrice, daysToMaturity);
  }

  let low = -50;
  let high = 100;
  let lowPrice = yieldToPrice(trade, low, valuationDate);
  let highPrice = yieldToPrice(trade, high, valuationDate);
  if (lowPrice == null || highPrice == null) return null;

  while (lowPrice < targetPrice && low > -95) {
    low -= 25;
    lowPrice = yieldToPrice(trade, low, valuationDate);
    if (lowPrice == null) return null;
  }
  while (highPrice > targetPrice && high < 500) {
    high += 100;
    highPrice = yieldToPrice(trade, high, valuationDate);
    if (highPrice == null) return null;
  }
  if (targetPrice > lowPrice || targetPrice < highPrice) return null;

  for (let i = 0; i < 80; i++) {
    const mid = (low + high) / 2;
    const price = yieldToPrice(trade, mid, valuationDate);
    if (price == null) return null;
    if (price > targetPrice) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
};

const getTradeYTM = (trade, valuationDate) => {
  const cleanPrice = Number(trade.currentMarketPrice);
  const daysToMaturity = calculateForwardDaysBetween(valuationDate, trade.maturityDate);
  if (!Number.isFinite(cleanPrice) || cleanPrice <= 0 || !daysToMaturity || daysToMaturity <= 0) return null;
  if (trade.type === 't-bill') return getTBillInvestmentYield(cleanPrice, daysToMaturity);
  if (trade.type === 't-note' || trade.type === 't-bond') {
    const accruedInterestPer100 = getAccruedInterestPer100(trade, valuationDate);
    const dirtyPrice = getDirtyPrice(cleanPrice, accruedInterestPer100);
    return solveYTMFromPrice(trade, dirtyPrice, valuationDate);
  }
  return null;
};

const generateAllCoupons = (trade) => {
  if (trade.type === 't-bill' || !trade.couponFrequency || !trade.couponRate) return [];
  const coupons = [];
  const matDate = new Date(trade.maturityDate);
  const tradeDate = new Date(trade.tradeDate);
  const endDate = trade.status === 'closed' ? new Date(trade.closeDate) : matDate;
  const intervalMonths = 12 / trade.couponFrequency;
  let d = new Date(matDate);

  while (d > tradeDate) {
    if (d <= endDate) {
      const amt = ((trade.faceValue * (trade.couponRate / 100)) / trade.couponFrequency) * (trade.side === 'sell' ? -1 : 1);
      coupons.push({ id: `${trade.id}-${d.getTime()}`, tradeId: trade.id, cusip: trade.cusip || trade.type.toUpperCase(), date: new Date(d), dateStr: d.toISOString().split('T')[0], amount: amt, isShort: trade.side === 'sell' });
    }
    d = new Date(d); d.setMonth(d.getMonth() - intervalMonths);
  }
  return coupons.sort((a, b) => a.date - b.date);
};

const makeTradeId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const toFiniteNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const normalizeTradeForStorage = (trade) => {
  const cleanPrice = toFiniteNumber(trade.cleanPrice);
  const status = trade.status === 'closed' ? 'closed' : 'active';
  const normalized = {
    ...trade,
    id: String(trade.id || makeTradeId()),
    cusip: String(trade.cusip || '').trim(),
    type: trade.type,
    side: trade.side,
    tradeDate: trade.tradeDate,
    maturityDate: trade.maturityDate,
    faceValue: toFiniteNumber(trade.faceValue),
    cleanPrice,
    couponRate: toFiniteNumber(trade.couponRate),
    commission: toFiniteNumber(trade.commission),
    couponFrequency: toFiniteNumber(trade.couponFrequency, trade.type === 't-bill' ? 0 : 2),
    currentMarketPrice: toFiniteNumber(trade.currentMarketPrice, cleanPrice),
    status,
  };
  if (isCouponTreasury(normalized) && trade.accruedInterestPer100 !== undefined && trade.accruedInterestPer100 !== null && String(trade.accruedInterestPer100).trim() !== '') {
    normalized.accruedInterestPer100 = Math.max(0, toFiniteNumber(trade.accruedInterestPer100));
  } else {
    delete normalized.accruedInterestPer100;
  }
  if (status === 'closed') {
    normalized.closeDate = trade.closeDate || trade.maturityDate;
    normalized.closePrice = toFiniteNumber(trade.closePrice, normalized.currentMarketPrice);
    normalized.closeCommission = toFiniteNumber(trade.closeCommission);
  }
  return normalized;
};

export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [trades, setTrades] = useState([]);
  const [isDbReady, setIsDbReady] = useState(false);

  const [activeTab, setActiveTab] = useState('dashboard');
  const [ledgerSubTab, setLedgerSubTab] = useState('active'); 
  
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingTradeId, setEditingTradeId] = useState(null);
  const [smartInputMode, setSmartInputMode] = useState(false);
  
  const [isCloseModalOpen, setIsCloseModalOpen] = useState(false);
  const [closingTradeId, setClosingTradeId] = useState(null);
  
  const [editingPriceId, setEditingPriceId] = useState(null);
  const [newPrice, setNewPrice] = useState('');

  const [aiInsights, setAiInsights] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [insightError, setInsightError] = useState('');
  const [aiAnalysisMode, setAiAnalysisMode] = useState('total_assets');
  const [aiSelectedSymbol, setAiSelectedSymbol] = useState('');
  const [aiStockTrades, setAiStockTrades] = useState([]);
  const [aiStockPrices, setAiStockPrices] = useState([]);
  const [aiCashMovements, setAiCashMovements] = useState([]);
  const [aiLastSnapshot, setAiLastSnapshot] = useState(null);
  const [aiCopyStatus, setAiCopyStatus] = useState('');
  const [isAiSnapshotOpen, setIsAiSnapshotOpen] = useState(false);
  const [rawTradeText, setRawTradeText] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  const [userDeepSeekApiKey, setUserDeepSeekApiKey] = useState(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem(AI_USER_KEY_STORAGE_KEY) || '';
  });
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [isApiKeyOpen, setIsApiKeyOpen] = useState(false);

  // --- FRED Yield Curve ---
  const [yieldCurve, setYieldCurve] = useState(null);
  const [yieldCurveError, setYieldCurveError] = useState('');
  const [isFetchingCurve, setIsFetchingCurve] = useState(false);

  const defaultForm = { cusip: '', type: 't-note', side: 'buy', tradeDate: new Date().toISOString().split('T')[0], maturityDate: '', faceValue: 1000, cleanPrice: 100, couponRate: 0, commission: 0, couponFrequency: 2, accruedInterestPer100: '' };
  const defaultYtmForm = { type: 't-note', tradeDate: new Date().toISOString().split('T')[0], maturityDate: '', faceValue: 1000, cleanPrice: 100, couponRate: 4, couponFrequency: 2, commission: 0, accruedInterestPer100: '' };
  const [formData, setFormData] = useState(defaultForm);
  const [ytmForm, setYtmForm] = useState(defaultYtmForm);
  const [closeData, setCloseData] = useState({ closeDate: new Date().toISOString().split('T')[0], closePrice: '', closeCommission: 0 });
  const [selectedBenchmark, setSelectedBenchmark] = useState('UST10Y');
  const [importAuditLog, setImportAuditLog] = useState([]);
  const hasUserDeepSeekApiKey = Boolean(userDeepSeekApiKey.trim());
  const hasAiTransport = isAiConfigured || hasUserDeepSeekApiKey;

  // --- Firebase Auth 監聽 (改為 Google 登入) ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // --- FRED Yield Curve fetch（掛載時拉一次；prod 讀 static JSON） ---
  useEffect(() => {
    let cancelled = false;
    setIsFetchingCurve(true);
    fetchYieldCurve()
      .then(curve => { if (!cancelled) { setYieldCurve(curve); setYieldCurveError(''); } })
      .catch(err => { if (!cancelled) setYieldCurveError(err.message || '無法獲取市場收益率'); })
      .finally(() => { if (!cancelled) setIsFetchingCurve(false); });
    return () => { cancelled = true; };
  }, []);

  // --- 當 yield curve 載入後，自動用市場 yield 計算理論價格更新所有活躍持倉 ---
  const priceUpdateRef = useRef(null);
  useEffect(() => {
    if (!yieldCurve?.points?.length || !user || !isDbReady) return;
    const curveDate = yieldCurve.updatedAt;
    if (!curveDate || priceUpdateRef.current === curveDate || priceUpdateRef.current === `updating:${curveDate}`) return;
    const toUpdate = trades.filter(t =>
      t.status !== 'closed' && !isMatured(t.maturityDate) && t.priceUpdatedAt !== curveDate
    );
    if (toUpdate.length === 0) { priceUpdateRef.current = curveDate; return; }
    priceUpdateRef.current = `updating:${curveDate}`;
    let cancelled = false;
    (async () => {
      let failed = false;
      for (const trade of toUpdate) {
        try {
          const valuationDate = new Date();
          valuationDate.setHours(0, 0, 0, 0);
          const days = calculateForwardDaysBetween(valuationDate, trade.maturityDate);
          if (!days || days <= 0) continue;
          const remainingYears = days / 365.25;
          const marketYield = getMarketYTMFromCurve(yieldCurve, remainingYears);
          if (marketYield == null) continue;
          const newMktPrice = yieldToPrice(trade, marketYield, valuationDate);
          if (newMktPrice == null || !Number.isFinite(newMktPrice) || newMktPrice <= 0) continue;
          const accruedInterestPer100 = getAccruedInterestPer100(trade, valuationDate);
          const cleanMarketPrice = isCouponTreasury(trade) ? newMktPrice - accruedInterestPer100 : newMktPrice;
          if (!Number.isFinite(cleanMarketPrice) || cleanMarketPrice <= 0) continue;
          await saveTradeToDB({ ...trade, currentMarketPrice: roundMarketPriceForStorage(cleanMarketPrice), priceUpdatedAt: curveDate });
        } catch (err) {
          failed = true;
          console.error('Market price update failed:', trade.id, err);
        }
      }
      if (!cancelled) priceUpdateRef.current = failed ? null : curveDate;
    })();
    return () => { cancelled = true; };
  }, [yieldCurve, trades, user, isDbReady]);

  const handleRefreshCurve = async () => {
    setIsFetchingCurve(true);
    priceUpdateRef.current = null;
    try {
      const curve = await fetchYieldCurve();
      setYieldCurve(curve);
      setYieldCurveError('');
    } catch (err) {
      setYieldCurveError(err.message || '無法獲取市場收益率');
    } finally {
      setIsFetchingCurve(false);
    }
  };

  useEffect(() => {
    if (!user) {
      setTrades([]); // 登出時清空畫面資料
      setIsDbReady(false);
      return;
    }
    // 使用 user.uid 作為個人專屬路徑 (每個 Google 帳號有獨立空間)
    const tradesRef = collection(db, 'users', user.uid, 'trades');
    const unsubscribe = onSnapshot(tradesRef, (snapshot) => {
      const fetchedTrades = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setTrades(fetchedTrades);
      setIsDbReady(true);
    }, (error) => console.error("Firestore error:", error));
    return () => unsubscribe();
  }, [user]);


  useEffect(() => {
    if (!user) {
      setAiStockTrades([]);
      return undefined;
    }
    return subscribeStockTrades(
      db,
      user.uid,
      setAiStockTrades,
      (error) => console.error('AI stock snapshot subscription failed:', error),
    );
  }, [user]);

  useEffect(() => {
    if (!user) {
      setAiStockPrices([]);
      return undefined;
    }
    return subscribeStockPrices(
      db,
      user.uid,
      setAiStockPrices,
      (error) => console.error('AI stock price subscription failed:', error),
    );
  }, [user]);

  useEffect(() => {
    if (!user) {
      setAiCashMovements([]);
      return undefined;
    }
    return subscribeCashMovements(
      db,
      user.uid,
      setAiCashMovements,
      (error) => console.error('AI cash snapshot subscription failed:', error),
    );
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
  const aiStockSymbols = useMemo(
    () => {
      const positionSymbols = calculateStockPositions(aiStockTrades)
        .filter((position) => Math.abs(Number(position.quantity || 0)) > 0.000001 || Math.abs(Number(position.remainingCost || 0)) > 0.01)
        .map((position) => position.symbol);
      const tradeSymbols = aiStockTrades.map((trade) => normalizeSymbol(trade.symbol)).filter(Boolean);
      return [...new Set([...positionSymbols, ...tradeSymbols])].sort();
    },
    [aiStockTrades],
  );

  useEffect(() => {
    if (aiAnalysisMode === 'stock_single' && !aiSelectedSymbol && aiStockSymbols.length > 0) {
      setAiSelectedSymbol(aiStockSymbols[0]);
    }
  }, [aiAnalysisMode, aiSelectedSymbol, aiStockSymbols]);

  const allCoupons = useMemo(() => trades.flatMap(generateAllCoupons), [trades]);
  // Dashboard valuation date is fixed at page load; reload the app to refresh it.
  const todayObj = useMemo(() => { const d = new Date(); d.setHours(0,0,0,0); return d; }, []);
  const receivedCoupons = useMemo(() => allCoupons.filter(c => c.date <= todayObj), [allCoupons, todayObj]);
  const upcomingCouponsList = useMemo(() => allCoupons.filter(c => c.date > todayObj && c.date.getFullYear() === todayObj.getFullYear()), [allCoupons, todayObj]);

  // --- PnL Calculations ---
  const portfolioMetrics = useMemo(() => {
    let totalMarketValue = 0; let totalUnrealizedPnL = 0; let totalWeightYTM = 0; let totalFace = 0; let totalAccruedInterest = 0; let totalFullMarketValue = 0; let totalYtmMarketValue = 0; let totalRealizedPnL = 0; let annualCouponIncome = 0;
    receivedCoupons.forEach(c => totalRealizedPnL += c.amount);
    closedTrades.forEach(t => { const mult = t.side === 'sell' ? -1 : 1; const cp = Number(t.closePrice) || 0; const bp = Number(t.cleanPrice) || 0; const fv = Number(t.faceValue) || 0; totalRealizedPnL += (((cp - bp) * fv) / 100) * mult - (Number(t.commission)||0) - (Number(t.closeCommission)||0); });
    maturedTrades.forEach(t => { const mult = t.side === 'sell' ? -1 : 1; const bp = Number(t.cleanPrice) || 0; const fv = Number(t.faceValue) || 0; totalRealizedPnL += (((100 - bp) * fv) / 100) * mult - (Number(t.commission)||0); });
    activeTrades.forEach(trade => {
      const price = Number(trade.currentMarketPrice);
      if (!Number.isFinite(price) || price <= 0) return;
      const faceValue = Number(trade.faceValue) || 0;
      const cleanPrice = Number(trade.cleanPrice) || 0;
      const mult = trade.side === 'sell' ? -1 : 1;
      const marketVal = ((price * faceValue) / 100) * mult;
      const accruedInterestPer100 = getAccruedInterestPer100(trade, todayObj);
      const accruedValue = ((accruedInterestPer100 * faceValue) / 100) * mult;
      totalMarketValue += marketVal;
      totalAccruedInterest += accruedValue;
      totalUnrealizedPnL += ((((price - cleanPrice) * faceValue) / 100) * mult) - (trade.commission||0);
      totalFace += faceValue * mult;
      if (trade.type !== 't-bill' && trade.couponRate) {
        annualCouponIncome += (faceValue * (Number(trade.couponRate) / 100)) * mult;
      }
    });
    totalFullMarketValue = totalMarketValue + totalAccruedInterest;
    activeTrades.forEach(trade => {
      const cleanPrice = Number(trade.currentMarketPrice);
      if (!Number.isFinite(cleanPrice) || cleanPrice <= 0) return;
      const mult = trade.side === 'sell' ? -1 : 1;
      const accruedInterestPer100 = getAccruedInterestPer100(trade, todayObj);
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
  }, [activeTrades, maturedTrades, closedTrades, receivedCoupons, todayObj]);

  const buildCurrentAiSnapshot = (asOf = new Date().toISOString()) => buildPortfolioAiSnapshot({
    mode: aiAnalysisMode,
    selectedSymbol: aiSelectedSymbol,
    stockTrades: aiStockTrades,
    stockPrices: aiStockPrices,
    cashMovements: aiCashMovements,
    treasuryData: { trades },
    treasurySummary: portfolioMetrics,
    asOf,
  });

  const aiPreviewSnapshot = useMemo(
    () => buildCurrentAiSnapshot(),
    [aiAnalysisMode, aiSelectedSymbol, aiStockTrades, aiStockPrices, aiCashMovements, trades, portfolioMetrics],
  );
  const aiSnapshotForDisplay = aiLastSnapshot || aiPreviewSnapshot;
  const aiSnapshotSummary = useMemo(() => buildAiSnapshotSummary(aiSnapshotForDisplay), [aiSnapshotForDisplay]);
  const aiReportSections = useMemo(() => parseAiReportSections(aiInsights || ''), [aiInsights]);
  const aiHasForbiddenAdvice = useMemo(() => detectForbiddenAdvice(aiInsights || ''), [aiInsights]);
  const aiSnapshotCopyJson = useMemo(
    () => JSON.stringify(sanitizeAiSnapshotForCopy(aiSnapshotForDisplay), null, 2),
    [aiSnapshotForDisplay],
  );
  const isSingleStockReady = isSingleStockModeReady({
    mode: aiAnalysisMode,
    selectedSymbol: aiSelectedSymbol,
    symbols: aiStockSymbols,
  });

  // --- Chart Data ---
  const yieldCurveChartData = useMemo(() => {
    if (!yieldCurve?.points?.length) return null;
    const curvePoints = yieldCurve.points.map(p => ({ years: p.years, yield: p.yield }));
    const bondDots = activeTrades.map(t => {
      const days = calculateForwardDaysBetween(todayObj, t.maturityDate);
      if (!days || days <= 0) return null;
      const remainingYears = days / 365.25;
      const marketYtm = getMarketYTMFromCurve(yieldCurve, remainingYears);
      return { cusip: t.cusip || t.type.toUpperCase(), x: remainingYears, y: marketYtm, side: t.side };
    }).filter(d => d?.y != null);
    return { curvePoints, bondDots };
  }, [yieldCurve, activeTrades, todayObj]);

  const couponCalendar = useMemo(() => {
    const year = todayObj.getFullYear();
    const byMonth = Array.from({ length: 12 }, () => 0);
    allCoupons.filter(c => c.date.getFullYear() === year).forEach(c => { byMonth[c.date.getMonth()] += c.amount; });
    return byMonth;
  }, [allCoupons]);

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

    if (!ytmForm.tradeDate || !ytmForm.maturityDate || !tradeDate || !maturityDate || maturityDate <= tradeDate || faceValue <= 0 || cleanPrice <= 0) {
      return { isValid: false };
    }

    const days = calculateForwardDaysBetween(tradeDate, maturityDate);
    if (!days || days <= 0) return { isValid: false };
    const years = days / 365.25;
    const trade = { type: ytmForm.type, couponRate, couponFrequency, maturityDate: ytmForm.maturityDate, accruedInterestPer100: ytmForm.accruedInterestPer100 };
    const accruedInterestPer100 = getAccruedInterestPer100(trade, tradeDate);
    const dirtyPrice = getDirtyPrice(cleanPrice, accruedInterestPer100);
    if (dirtyPrice == null) return { isValid: false };
    const priceWithCommission = dirtyPrice + ((commission / faceValue) * 100);
    const grossYtm = solveYTMFromPrice(trade, cleanPrice, tradeDate);
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


  // --- Database Actions ---
  const saveTradeToDB = async (tradeData) => {
    if (!user) return;
    const tradeRef = doc(db, 'users', user.uid, 'trades', tradeData.id);
    await setDoc(tradeRef, tradeData);
  };

  const handleAddYtmToPortfolio = async () => {
    if (!ytmQuote.isValid) return;
    if (!user) {
      alert('未能加入 Portfolio，請先確認已登入。');
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
    const updatedTrade = normalizeTradeForStorage({ ...trade, status: 'closed', closeDate: closeData.closeDate, closePrice: closeData.closePrice, closeCommission: closeData.closeCommission, currentMarketPrice: closeData.closePrice });
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
    if (typeof window !== 'undefined') {
      if (key) window.localStorage.setItem(AI_USER_KEY_STORAGE_KEY, key);
      else window.localStorage.removeItem(AI_USER_KEY_STORAGE_KEY);
    }
    setUserDeepSeekApiKey(key);
    setIsApiKeyOpen(false);
  };

  const handleClearApiKey = () => {
    if (typeof window !== 'undefined') window.localStorage.removeItem(AI_USER_KEY_STORAGE_KEY);
    setUserDeepSeekApiKey('');
    setApiKeyDraft('');
    setIsApiKeyOpen(false);
  };

  const handleSmartParse = async () => {
    if (!rawTradeText.trim()) return;
    if (!hasAiTransport) { alert("請先設定 AI proxy 或按 API Key 輸入 DeepSeek key。"); return; }
    setIsParsing(true);
    try {
      const parsedData = await extractTradeData(rawTradeText, userDeepSeekApiKey);
      setFormData({ ...defaultForm, ...parsedData });
      setSmartInputMode(false); setRawTradeText('');
    } catch (err) { alert("無法解析文字，請檢查格式。"); } finally { setIsParsing(false); }
  };

  const handleAnalyzePortfolio = async () => {
    if (!hasAiTransport) { setInsightError('請先設定 AI proxy 或按 API Key 輸入 DeepSeek key。'); return; }
    if (!isSingleStockReady) { setInsightError('單一股票模式需要先選擇股票代號。'); return; }
    setIsAnalyzing(true); setInsightError(''); setAiCopyStatus('');
    try {
      const snapshot = buildCurrentAiSnapshot(new Date().toISOString());
      const messages = buildPortfolioAiMessages({ snapshot, mode: aiAnalysisMode });
      const response = await generateText(messages, userDeepSeekApiKey);
      setAiLastSnapshot(snapshot);
      setAiInsights(response);
      setIsAiSnapshotOpen(false);
    } catch (err) { setInsightError('分析時發生錯誤，請稍後再試，或檢查 DeepSeek API Key / AI proxy 設定。'); } finally { setIsAnalyzing(false); }
  };

  const copyToClipboard = async (text, successMessage) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setAiCopyStatus(successMessage);
      window.setTimeout(() => setAiCopyStatus(''), 1800);
    } catch (err) {
      setAiCopyStatus('複製失敗，請檢查瀏覽器權限。');
    }
  };

  const handleClearAiResult = () => {
    setAiInsights(null);
    setInsightError('');
    setAiLastSnapshot(null);
    setAiCopyStatus('');
    setIsAiSnapshotOpen(false);
  };

  // --- 匯出 / 匯入 ---
  const handleExport = () => {
    if (trades.length === 0) return;
    const data = JSON.stringify(trades, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `treasury-backup-${new Date().toISOString().split('T')[0]}.json`;
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
        const validTypes = new Set(['t-bill', 't-note', 't-bond', 'tips']);
        const validSides = new Set(['buy', 'sell']);
        const validFreq = new Set([1, 2, 4, 12]);
        const validStatus = new Set(['active', 'closed', undefined, null, '']);
        const errors = [];
        let added = 0;

        const isISODate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

        for (let i = 0; i < imported.length; i++) {
          const trade = normalizeTradeForStorage(imported[i] || {});
          const prefix = `第 ${i + 1} 筆`;
          if (!trade || typeof trade !== 'object') { errors.push(`${prefix}: 格式不是物件`); continue; }
          if (existingIds.has(trade.id)) { errors.push(`${prefix}: 重複 id`); continue; }
          if (!validTypes.has(trade.type)) { errors.push(`${prefix}: type 無效`); continue; }
          if (!validSides.has(trade.side)) { errors.push(`${prefix}: side 無效`); continue; }
          if (!validStatus.has(imported[i]?.status)) { errors.push(`${prefix}: status 無效`); continue; }
          if (!isISODate(trade.tradeDate) || !isISODate(trade.maturityDate)) { errors.push(`${prefix}: 日期格式需為 YYYY-MM-DD`); continue; }
          if (new Date(trade.maturityDate) <= new Date(trade.tradeDate)) { errors.push(`${prefix}: maturityDate 必須晚於 tradeDate`); continue; }
          if (!Number.isFinite(trade.faceValue) || trade.faceValue <= 0) { errors.push(`${prefix}: faceValue 無效`); continue; }
          if (!Number.isFinite(trade.cleanPrice) || trade.cleanPrice <= 0) { errors.push(`${prefix}: cleanPrice 無效`); continue; }
          if (!Number.isFinite(trade.currentMarketPrice) || trade.currentMarketPrice <= 0) { errors.push(`${prefix}: currentMarketPrice 無效`); continue; }
          if (trade.type !== 't-bill' && !validFreq.has(trade.couponFrequency || 2)) { errors.push(`${prefix}: couponFrequency 無效`); continue; }
          if (trade.status === 'closed' && (!isISODate(trade.closeDate) || !Number.isFinite(trade.closePrice) || trade.closePrice <= 0)) { errors.push(`${prefix}: closed trade 缺少有效 closeDate/closePrice`); continue; }

          const fp = `${trade.cusip || ''}|${trade.tradeDate || ''}|${trade.faceValue || 0}`;
          if (existingFingerprints.has(fp)) { errors.push(`${prefix}: 疑似重複交易 (CUSIP+TradeDate+FaceValue)`); continue; }

          await saveTradeToDB(trade);
          existingIds.add(trade.id);
          existingFingerprints.add(fp);
          added++;
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
      } catch (err) { alert('匯入失敗：無法讀取或解析檔案。'); }
    };
    input.click();
  };

  // --- 登入畫面 UI ---
  if (authLoading) return <div className="min-h-screen flex items-center justify-center bg-slate-50"><Loader2 className="animate-spin text-blue-500" size={48}/></div>;

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
        <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full text-center border border-slate-100">
          <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg">
            <Landmark size={32} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-800 mb-2">Portfolio Dashboard</h1>
          <p className="text-slate-500 mb-8 text-sm">請登入以管理你的專屬美債投資組合，數據將安全同步至雲端，隨時隨地查閱。</p>
          <button onClick={handleGoogleLogin} className="w-full bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 font-medium py-3 px-4 rounded-xl flex items-center justify-center transition-all shadow-sm">
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
  if (!isDbReady) return <div className="min-h-screen flex items-center justify-center bg-slate-50"><Loader2 className="animate-spin text-blue-500" size={48}/></div>;

  const renderDashboard = () => (
    <div className="space-y-4 sm:space-y-6">
      <PortfolioOverview db={db} user={user} treasuryMetrics={portfolioMetrics} />
      <div className="bg-gradient-to-br from-emerald-600 via-emerald-700 to-teal-700 rounded-2xl shadow-lg p-5 sm:p-6 text-white relative overflow-hidden">
        <div className="absolute -top-2 -right-2 opacity-15 pointer-events-none"><Landmark size={140} /></div>
        <p className="text-emerald-100 text-xs sm:text-sm font-medium mb-1.5">美債累計已實現利潤</p>
        <p className="text-3xl sm:text-4xl font-bold tracking-tight">{portfolioMetrics.totalRealizedPnL >= 0 ? '+' : ''}${portfolioMetrics.totalRealizedPnL.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p>
        <span className="inline-block text-[11px] sm:text-xs bg-white/15 backdrop-blur-sm px-2.5 py-1 rounded-md mt-2.5 ring-1 ring-white/20">已包含所有平倉、到期結算及歷史收息</span>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <div className="bg-white p-4 sm:p-5 rounded-xl shadow-sm border border-slate-100 hover:shadow-md transition-shadow flex items-center gap-3 sm:gap-4">
          <div className="p-2.5 sm:p-3 bg-blue-50 text-blue-600 rounded-lg flex-shrink-0"><DollarSign size={20} className="sm:hidden" /><DollarSign size={24} className="hidden sm:block" /></div>
          <div className="min-w-0"><p className="text-[11px] sm:text-xs text-slate-500 font-medium">美債 Clean Market Value</p><p className="text-base sm:text-xl font-bold text-slate-800 truncate">${portfolioMetrics.totalMarketValue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p><p className="text-[10px] text-slate-400 truncate">Full ${portfolioMetrics.totalFullMarketValue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} · Accrued ${portfolioMetrics.totalAccruedInterest.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p></div>
        </div>
        <div className="bg-white p-4 sm:p-5 rounded-xl shadow-sm border border-slate-100 hover:shadow-md transition-shadow flex items-center gap-3 sm:gap-4">
          <div className={`p-2.5 sm:p-3 rounded-lg flex-shrink-0 ${portfolioMetrics.totalUnrealizedPnL >= 0 ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`}><Activity size={20} className="sm:hidden" /><Activity size={24} className="hidden sm:block" /></div>
          <div className="min-w-0"><p className="text-[11px] sm:text-xs text-slate-500 font-medium">美債未實現盈虧</p><p className={`text-base sm:text-xl font-bold truncate ${portfolioMetrics.totalUnrealizedPnL >= 0 ? 'text-green-600' : 'text-red-600'}`}>{portfolioMetrics.totalUnrealizedPnL >= 0 ? '+' : ''}${portfolioMetrics.totalUnrealizedPnL.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p></div>
        </div>
        <div className="bg-white p-4 sm:p-5 rounded-xl shadow-sm border border-slate-100 hover:shadow-md transition-shadow flex items-center gap-3 sm:gap-4">
          <div className="p-2.5 sm:p-3 bg-amber-50 text-amber-600 rounded-lg flex-shrink-0"><TrendingUp size={20} className="sm:hidden" /><TrendingUp size={24} className="hidden sm:block" /></div>
          <div className="min-w-0"><p className="text-[11px] sm:text-xs text-slate-500 font-medium">美債加權平均 YTM</p><p className={`text-base sm:text-xl font-bold ${portfolioMetrics.totalWeightYTM == null ? 'text-slate-400' : 'text-slate-800'}`}>{portfolioMetrics.totalWeightYTM == null ? '--' : `${portfolioMetrics.totalWeightYTM.toFixed(2)}%`}</p></div>
        </div>
        <div className="bg-white p-4 sm:p-5 rounded-xl shadow-sm border border-slate-100 hover:shadow-md transition-shadow flex items-center gap-3 sm:gap-4">
          <div className="p-2.5 sm:p-3 bg-emerald-50 text-emerald-600 rounded-lg flex-shrink-0"><Wallet size={20} className="sm:hidden" /><Wallet size={24} className="hidden sm:block" /></div>
          <div className="min-w-0"><p className="text-[11px] sm:text-xs text-slate-500 font-medium">平均每月利息</p><p className="text-base sm:text-xl font-bold text-emerald-600 truncate">${portfolioMetrics.monthlyAvgIncome.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p></div>
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        <div className="bg-white p-4 sm:p-5 rounded-xl shadow-sm border border-slate-100">
          <h3 className="text-sm sm:text-base font-bold text-slate-800 mb-3 flex items-center"><TrendingUp size={16} className="mr-2 text-blue-500"/> Benchmark 對比</h3>
          <div className="flex items-center gap-2 mb-3">
            <select value={selectedBenchmark} onChange={(e) => setSelectedBenchmark(e.target.value)} className="text-xs sm:text-sm border rounded-md px-2 py-1">
              <option value="UST10Y">UST 10Y</option>
              <option value="SGOV">SGOV (~3M)</option>
              <option value="SHY">SHY (~2Y)</option>
              <option value="IEF">IEF (~7Y)</option>
              <option value="TLT">TLT (~20Y)</option>
            </select>
            <span className="text-[11px] text-slate-500">Curve tenor: {benchmarkMetrics.benchmarkYears}Y</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="p-3 rounded-lg bg-slate-50 border"><p className="text-[11px] text-slate-500">美債組合 YTM</p><p className={`font-bold ${benchmarkMetrics.portfolioYield == null ? 'text-slate-400' : ''}`}>{benchmarkMetrics.portfolioYield == null ? '--' : `${benchmarkMetrics.portfolioYield.toFixed(2)}%`}</p></div>
            <div className="p-3 rounded-lg bg-slate-50 border"><p className="text-[11px] text-slate-500">Benchmark YTM</p><p className="font-bold">{benchmarkMetrics.benchmarkYield == null ? '—' : `${benchmarkMetrics.benchmarkYield.toFixed(2)}%`}</p></div>
            <div className="p-3 rounded-lg bg-slate-50 border"><p className="text-[11px] text-slate-500">Spread</p><p className={`font-bold ${benchmarkMetrics.spread == null ? 'text-slate-400' : benchmarkMetrics.spread >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{benchmarkMetrics.spread == null ? '—' : `${benchmarkMetrics.spread >= 0 ? '+' : ''}${benchmarkMetrics.spread.toFixed(2)}%`}</p></div>
          </div>
        </div>
        <div className="bg-white p-4 sm:p-5 rounded-xl shadow-sm border border-slate-100">
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
        <div className="bg-white p-4 sm:p-6 rounded-xl shadow-sm border border-slate-100">
          <div className="flex justify-between items-center mb-4 border-b border-slate-100 pb-3">
            <h3 className="text-base sm:text-lg font-bold text-slate-800 flex items-center"><TrendingUp className="mr-2 text-blue-500" size={18}/> 美債收益率曲線</h3>
            <div className="flex items-center gap-3 text-[10px]">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block"></span>Buy</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400 inline-block"></span>Short</span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={yieldCurveChartData.curvePoints} margin={{ top: 20, right: 15, bottom: 0, left: -15 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="years" type="number" tick={{ fontSize: 10 }} unit="yr" domain={[0, 30]} />
              <YAxis tick={{ fontSize: 10 }} domain={['auto', 'auto']} unit="%" />
              <Tooltip formatter={(v) => [`${Number(v).toFixed(2)}%`, '收益率']} labelFormatter={(v) => `${Number(v).toFixed(1)} 年`} />
              <Line type="monotone" dataKey="yield" stroke="#3b82f6" strokeWidth={2.5} dot={false} />
              {yieldCurveChartData.bondDots.map(d => (
                <ReferenceDot key={d.cusip} x={d.x} y={d.y} r={7} fill={d.side === 'sell' ? '#f87171' : '#10b981'} stroke="#fff" strokeWidth={2.5} label={{ value: d.cusip, position: 'top', fontSize: 9, fill: '#475569', fontWeight: 600 }} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      <div className="bg-white p-4 sm:p-6 rounded-xl shadow-sm border border-slate-100">
        <div className="flex justify-between items-center mb-4 border-b border-slate-100 pb-3">
          <h3 className="text-base sm:text-lg font-bold text-slate-800 flex items-center"><Wallet className="mr-2 text-emerald-500" size={18}/> 今年剩餘應收派息</h3>
          {upcomingCouponsList.length > 0 && <span className="text-[11px] text-slate-400 font-medium">{upcomingCouponsList.length} 筆</span>}
        </div>
        {upcomingCouponsList.length === 0 ? <p className="text-sm text-slate-500 py-6 text-center bg-slate-50 rounded-lg">今年內暫無剩餘派息。</p> : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5 sm:gap-3">
            {upcomingCouponsList.map(c => (
              <div key={c.id} className="bg-gradient-to-br from-emerald-50/70 to-emerald-50/20 border border-emerald-100 p-3 rounded-lg hover:border-emerald-300 transition-colors">
                <p className="text-[10px] font-semibold text-emerald-700 tracking-wide">{c.dateStr}</p>
                <p className="text-[11px] text-slate-500 truncate mt-0.5">{c.cusip}</p>
                <p className={`font-bold text-sm sm:text-base mt-1 ${c.amount >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>{c.amount >= 0 ? '+' : ''}${c.amount.toLocaleString(undefined, {minimumFractionDigits:2})}</p>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="bg-white p-4 sm:p-6 rounded-xl shadow-sm border border-slate-100">
        <div className="flex justify-between items-center mb-4 border-b border-slate-100 pb-3">
          <h3 className="text-base sm:text-lg font-bold text-slate-800 flex items-center"><Calendar className="mr-2 text-emerald-500" size={18}/> 年度收息日曆 · {todayObj.getFullYear()}</h3>
          <span className="text-[11px] text-slate-400 font-medium">${couponCalendar.reduce((s, v) => s + v, 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
          {['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((label, m) => {
            const total = couponCalendar[m];
            const has = total !== 0;
            const past = m < todayObj.getMonth();
            const current = m === todayObj.getMonth();
            return (
              <div key={m} className={`p-2.5 sm:p-3 rounded-lg border text-center transition-colors ${has ? (past ? 'bg-emerald-50/50 border-emerald-200/60' : 'bg-emerald-50 border-emerald-200') : (past ? 'bg-slate-50/60 border-slate-100' : 'bg-slate-50 border-slate-200')} ${current ? 'ring-2 ring-blue-400 ring-offset-1' : ''}`}>
                <p className={`text-[10px] font-semibold uppercase tracking-wide ${current ? 'text-blue-600' : 'text-slate-400'}`}>{label}</p>
                <p className={`text-sm font-bold mt-1 ${has ? (total >= 0 ? 'text-emerald-600' : 'text-red-500') : 'text-slate-300'}`}>
                  {has ? `$${Math.abs(total).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '—'}
                </p>
              </div>
            );
          })}
        </div>
      </div>
      <div className="bg-white p-4 sm:p-6 rounded-xl shadow-sm border border-slate-100">
        <div className="flex flex-wrap justify-between items-center gap-2 mb-4 border-b border-slate-100 pb-3">
          <div>
            <h3 className="text-base sm:text-lg font-bold text-slate-800 flex items-center"><Clock className="mr-2 text-blue-500" size={18}/> 債券到期倒數</h3>
            <p className="text-[10px] sm:text-[11px] text-slate-400 mt-1">Current YTM is calculated from current clean market price + accrued interest, using today as valuation date.</p>
          </div>
          <div className="flex items-center gap-2 text-[10px] sm:text-[11px] text-slate-500">
            {yieldCurve?.updatedAt && <span className="bg-slate-100 px-2 py-0.5 rounded-md">FRED · {yieldCurve.updatedAt}</span>}
            {yieldCurveError && <span className="text-red-500 flex items-center max-w-[180px] truncate" title={yieldCurveError}><AlertCircle size={11} className="mr-1 flex-shrink-0"/>{yieldCurveError}</span>}
            <button onClick={handleRefreshCurve} disabled={isFetchingCurve || !fredApiKey} title={fredApiKey ? '刷新市場收益率' : '未設定 FRED API key'} className="p-1.5 hover:bg-slate-100 rounded-md disabled:opacity-40 transition-colors">
              {isFetchingCurve ? <Loader2 size={14} className="animate-spin"/> : <RefreshCw size={14}/>}
            </button>
          </div>
        </div>
        {activeTrades.length === 0 ? <p className="text-sm text-slate-500 py-4 text-center bg-slate-50 rounded">暫無活躍持倉。</p> : (() => {
          const sorted = [...activeTrades].sort((a, b) => new Date(a.maturityDate) - new Date(b.maturityDate));
          const maxDays = Math.max(...sorted.map(t => calculateDaysBetween(todayObj, t.maturityDate)), 1);
          const formatCountdown = (d) => {
            if (d < 30) return `${d} 天`;
            if (d < 365) return `${Math.floor(d/30)} 個月 ${d%30} 天`;
            return `${Math.floor(d/365)} 年 ${Math.floor((d%365)/30)} 個月`;
          };
          const getColor = (d) => {
            if (d < 30) return { bar: 'bg-red-500', text: 'text-red-600', bg: 'bg-red-50' };
            if (d < 90) return { bar: 'bg-amber-500', text: 'text-amber-600', bg: 'bg-amber-50' };
            if (d < 365) return { bar: 'bg-blue-500', text: 'text-blue-600', bg: 'bg-blue-50' };
            return { bar: 'bg-emerald-500', text: 'text-emerald-600', bg: 'bg-emerald-50' };
          };
          return (
            <div className="space-y-2.5">
              {sorted.map(trade => {
                const days = calculateDaysBetween(todayObj, trade.maturityDate);
                const forwardDays = calculateForwardDaysBetween(todayObj, trade.maturityDate);
                const ytm = getTradeYTM(trade, todayObj);
                const pct = Math.min((days / maxDays) * 100, 100);
                const color = getColor(days);
                const marketYtm = forwardDays && forwardDays > 0 ? getMarketYTMFromCurve(yieldCurve, forwardDays / 365.25) : null;
                const delta = marketYtm != null && ytm != null ? ytm - marketYtm : null;
                return (
                  <div key={trade.id} className="p-2.5 sm:p-0 sm:bg-transparent rounded-lg bg-slate-50/60 sm:rounded-none space-y-2 sm:space-y-0 sm:flex sm:items-center sm:gap-3">
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
                    <div className={`w-full sm:flex-1 h-7 ${color.bg} rounded-md overflow-hidden relative ring-1 ring-inset ring-black/5`}>
                      <div className={`h-full ${color.bar} transition-all`} style={{ width: `${pct}%` }}></div>
                      <span className={`absolute inset-0 flex items-center px-3 text-xs font-bold ${color.text}`}>{formatCountdown(days)}</span>
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
      <div className="bg-white rounded-xl shadow-sm border border-indigo-100 overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-indigo-100 bg-gradient-to-br from-indigo-50 via-blue-50 to-white">
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-indigo-700">
                <div className="p-1.5 bg-white/80 rounded-lg shadow-sm"><Bot size={20} /></div>
                <h3 className="text-lg sm:text-xl font-semibold text-slate-900">AI 投資組合分析</h3>
              </div>
              <p className="text-xs sm:text-sm text-indigo-700/80 mt-2 max-w-3xl">以系統帳本 snapshot 生成報告，聚焦成本、現金流、美債，以及已儲存股票報價帶來的現價、市值、未實現盈虧、集中度和風險訊號。</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs sm:text-sm border border-indigo-200 bg-white/80 text-indigo-800 rounded-lg px-2.5 py-2 font-semibold shadow-sm">DeepSeek-V4-Pro</span>
              <button type="button" onClick={openApiKeySettings} className={`border px-3 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-colors flex items-center shadow-sm ${hasUserDeepSeekApiKey ? 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100' : 'bg-white/80 border-indigo-200 text-indigo-700 hover:bg-white'}`} title="Set personal DeepSeek API key">
                <KeyRound size={14} className="mr-1.5" /> {hasUserDeepSeekApiKey ? '個人 Key' : 'API Key'}
              </button>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-3 items-end">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">分析模式</label>
              <select
                value={aiAnalysisMode}
                onChange={(event) => {
                  setAiAnalysisMode(event.target.value);
                  setAiInsights(null);
                  setAiLastSnapshot(null);
                  setInsightError('');
                  setIsAiSnapshotOpen(false);
                }}
                className="w-full bg-white border border-indigo-200 text-slate-800 rounded-lg px-3 py-2 text-sm font-semibold shadow-sm"
              >
                {Object.entries(AI_MODE_LABELS).map(([mode, label]) => (
                  <option key={mode} value={mode}>{label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">股票代號</label>
              {aiAnalysisMode === 'stock_single' ? (
                <select
                  value={aiSelectedSymbol}
                  onChange={(event) => {
                    setAiSelectedSymbol(event.target.value);
                    setAiInsights(null);
                    setAiLastSnapshot(null);
                    setInsightError('');
                    setIsAiSnapshotOpen(false);
                  }}
                  className="w-full bg-white border border-indigo-200 text-slate-800 rounded-lg px-3 py-2 text-sm font-semibold shadow-sm"
                >
                  {aiStockSymbols.length === 0 ? (
                    <option value="">未有股票代號</option>
                  ) : aiStockSymbols.map((symbol) => (
                    <option key={symbol} value={symbol}>{symbol}</option>
                  ))}
                </select>
              ) : (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">只適用於單一股票模式</div>
              )}
              {aiAnalysisMode === 'stock_single' && aiStockSymbols.length === 0 && <p className="text-xs text-amber-600 mt-1">目前沒有股票交易或持倉可供選擇。</p>}
            </div>
            <button onClick={handleAnalyzePortfolio} disabled={isAnalyzing || !hasAiTransport || !isSingleStockReady} className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center justify-center shadow-sm min-h-[40px]">
              {isAnalyzing ? <Loader2 size={16} className="animate-spin mr-1.5" /> : <Sparkles size={16} className="mr-1.5" />} {isAnalyzing ? '分析中' : '產生分析'}
            </button>
          </div>
        </div>
        {isApiKeyOpen && (
          <div className="m-4 sm:m-5 bg-white border border-indigo-100 rounded-lg p-3 shadow-inner">
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="password"
                value={apiKeyDraft}
                onChange={(e) => setApiKeyDraft(e.target.value)}
                placeholder="Paste your DeepSeek API key"
                className="flex-1 min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
                autoComplete="off"
              />
              <button type="button" onClick={handleSaveApiKey} className="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-2 rounded-lg text-sm font-semibold">儲存</button>
              {hasUserDeepSeekApiKey && <button type="button" onClick={handleClearApiKey} className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-2 rounded-lg text-sm font-semibold">清除</button>}
              <button type="button" onClick={() => setIsApiKeyOpen(false)} className="bg-white hover:bg-slate-50 text-slate-600 border border-slate-200 px-3 py-2 rounded-lg text-sm font-semibold">取消</button>
            </div>
            <p className="text-[11px] text-slate-500 mt-2">Key 只會儲存在呢部機嘅瀏覽器 localStorage，不會寫入 Firestore 或備份檔。無 AI proxy 時會嘗試直接呼叫 DeepSeek；如瀏覽器封鎖請改用 proxy。</p>
          </div>
        )}
        <div className="p-4 sm:p-5 space-y-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs sm:text-sm text-amber-900">
            本 AI 分析只根據系統內已記錄資料生成；股票現價、市值及未實現盈虧只來自已儲存報價資料。不包含未記錄交易、市場新聞或外部研究資料，不構成買賣建議、目標價或預測。
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <h4 className="text-sm font-semibold text-slate-800">本次分析資料</h4>
              <span className="text-xs text-slate-500">{aiLastSnapshot ? '已生成報告 snapshot' : '預覽目前選擇範圍'}</span>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
              <div><p className="text-xs text-slate-500">Data as-of</p><p className="font-semibold text-slate-800 break-words">{aiSnapshotSummary.asOf ? new Date(aiSnapshotSummary.asOf).toLocaleString('zh-HK', { hour12: false }) : '--'}</p></div>
              <div><p className="text-xs text-slate-500">分析模式</p><p className="font-semibold text-slate-800">{aiSnapshotSummary.modeLabel}</p></div>
              <div><p className="text-xs text-slate-500">股票代號</p><p className="font-semibold text-slate-800">{aiSnapshotSummary.stockSymbolsCount}</p></div>
              <div><p className="text-xs text-slate-500">報價股票</p><p className="font-semibold text-slate-800">{aiSnapshotSummary.pricedSymbolCount} / {aiSnapshotSummary.stockSymbolsCount}</p></div>
              <div><p className="text-xs text-slate-500">缺少報價</p><p className="font-semibold text-slate-800">{aiSnapshotSummary.missingPriceCount}</p></div>
              <div><p className="text-xs text-slate-500">風險訊號</p><p className="font-semibold text-slate-800">{aiSnapshotSummary.riskSignalCount}</p></div>
              <div><p className="text-xs text-slate-500">股票市值</p><p className="font-semibold text-slate-800">{aiSnapshotSummary.stockMarketValue == null ? '--' : `USD ${Number(aiSnapshotSummary.stockMarketValue || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</p></div>
              <div><p className="text-xs text-slate-500">未實現盈虧</p><p className={`font-semibold ${(aiSnapshotSummary.stockUnrealizedPnl || 0) >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>{aiSnapshotSummary.stockUnrealizedPnl == null ? '--' : `${Number(aiSnapshotSummary.stockUnrealizedPnl || 0) >= 0 ? '+' : ''}USD ${Number(aiSnapshotSummary.stockUnrealizedPnl || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</p></div>
              <div><p className="text-xs text-slate-500">現金流水</p><p className="font-semibold text-slate-800">{aiSnapshotSummary.cashMovementCount}</p></div>
              <div><p className="text-xs text-slate-500">美債持倉</p><p className="font-semibold text-slate-800">{aiSnapshotSummary.treasuryHoldingCount}</p></div>
              <div className="col-span-2"><p className="text-xs text-slate-500">資料模組</p><p className="font-semibold text-slate-800">{aiSnapshotSummary.modules.join(' · ')}</p></div>
            </div>
            <p className="text-xs text-slate-500 mt-3">{aiSnapshotSummary.quoteStatus}</p>
          </div>
          {insightError && <p className="text-sm text-red-600 flex items-center"><AlertCircle size={16} className="mr-1"/>{insightError}</p>}
          {aiCopyStatus && <p className="text-sm text-emerald-700 flex items-center"><CheckCircle2 size={16} className="mr-1"/>{aiCopyStatus}</p>}
          {aiHasForbiddenAdvice && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 flex gap-2">
              <ShieldAlert size={17} className="mt-0.5 flex-shrink-0" />
              <span>AI 回應可能包含不應提供的建議，請忽略並重新分析。</span>
            </div>
          )}
          {aiInsights ? (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => copyToClipboard(aiInsights, '已複製分析')} className="bg-slate-900 hover:bg-slate-800 text-white px-3 py-2 rounded-lg text-xs sm:text-sm font-semibold flex items-center"><Copy size={14} className="mr-1.5" />複製分析</button>
                <button type="button" onClick={() => copyToClipboard(aiSnapshotCopyJson, '已複製分析資料 JSON')} className="bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 px-3 py-2 rounded-lg text-xs sm:text-sm font-semibold flex items-center"><FileJson size={14} className="mr-1.5" />複製分析資料 JSON</button>
                <button type="button" onClick={handleAnalyzePortfolio} disabled={isAnalyzing || !hasAiTransport || !isSingleStockReady} className="bg-indigo-50 hover:bg-indigo-100 disabled:opacity-50 text-indigo-700 border border-indigo-100 px-3 py-2 rounded-lg text-xs sm:text-sm font-semibold flex items-center"><RefreshCw size={14} className="mr-1.5" />重新分析</button>
                <button type="button" onClick={handleClearAiResult} className="bg-white hover:bg-slate-50 text-slate-600 border border-slate-200 px-3 py-2 rounded-lg text-xs sm:text-sm font-semibold flex items-center"><XCircle size={14} className="mr-1.5" />清除結果</button>
              </div>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                {aiReportSections.map((section, index) => (
                  <div key={`${section.title}-${index}`} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                    <h4 className="text-sm font-semibold text-slate-900 mb-2">{section.title}</h4>
                    <div className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap break-words">{section.content || '資料不足'}</div>
                  </div>
                ))}
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 overflow-hidden">
                <button type="button" onClick={() => setIsAiSnapshotOpen(prev => !prev)} className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-slate-700">
                  <span className="flex items-center"><FileJson size={15} className="mr-1.5" />分析資料 JSON</span>
                  <span className="text-xs text-slate-500">{isAiSnapshotOpen ? '收起' : '展開'}</span>
                </button>
                {isAiSnapshotOpen && <pre className="max-h-80 overflow-auto border-t border-slate-200 p-4 text-xs text-slate-600 whitespace-pre-wrap break-words">{aiSnapshotCopyJson}</pre>}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-indigo-200 bg-indigo-50/50 p-4 text-sm text-indigo-500">
              選擇分析範圍後按「產生分析」。系統會把帳本摘要及已儲存股票報價摘要傳給 AI，不會傳送 API key，也不會包含市場新聞。
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const renderYtmCalculator = () => {
    const update = (field, value) => setYtmForm(prev => ({ ...prev, [field]: value }));
    const money = (value) => Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const pct = (value) => value == null || !Number.isFinite(value) ? '--' : `${value.toFixed(3)}%`;

    return (
      <div className="space-y-4 sm:space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
          <div className="p-4 sm:p-5 border-b border-slate-100 flex flex-wrap justify-between items-center gap-3">
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
                  <option value="t-bill">T-Bill</option>
                  <option value="t-note">T-Note</option>
                  <option value="t-bond">T-Bond</option>
                  <option value="tips">TIPS</option>
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
                      <label className="block text-xs font-medium text-slate-500 mb-1">Accrued Interest / 100 (optional)</label>
                      <input type="number" min="0" step="0.001" value={ytmForm.accruedInterestPer100} onChange={(e) => update('accruedInterestPer100', e.target.value)} placeholder="Auto" className="w-full p-2 border rounded-lg text-sm" />
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="space-y-3">
              {!ytmQuote.isValid ? (
                <div className="h-full min-h-[220px] rounded-xl border border-dashed border-slate-200 bg-slate-50 flex items-center justify-center text-sm text-slate-500 px-4 text-center">
                  請輸入有效的到期日、價格及面值以計算 YTM。
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <div className="p-3 rounded-lg bg-blue-50 border border-blue-100">
                      <p className="text-[11px] text-blue-700 font-semibold">Net Settlement YTM</p>
                      <p className="text-xl font-bold text-blue-700 mt-1">{pct(ytmQuote.netYtm)}</p>
                    </div>
                    <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                      <p className="text-[11px] text-slate-500 font-semibold">Clean-price reference YTM</p>
                      <p className="text-xl font-bold text-slate-800 mt-1">{pct(ytmQuote.grossYtm)}</p>
                    </div>
                    <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-100">
                      <p className="text-[11px] text-emerald-700 font-semibold">曲線息差</p>
                      <p className={`text-xl font-bold mt-1 ${ytmQuote.spreadToCurve == null ? 'text-slate-400' : ytmQuote.spreadToCurve >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                        {ytmQuote.spreadToCurve == null ? '--' : `${ytmQuote.spreadToCurve >= 0 ? '+' : ''}${ytmQuote.spreadToCurve.toFixed(3)}%`}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="p-3 rounded-lg border bg-white">
                      <p className="text-[11px] text-slate-500 font-semibold">Clean Price</p>
                      <p className="font-bold text-slate-800">{ytmQuote.cleanPrice.toFixed(3)}</p>
                    </div>
                    <div className="p-3 rounded-lg border bg-white">
                      <p className="text-[11px] text-slate-500 font-semibold">Accrued Interest / 100</p>
                      <p className="font-bold text-slate-800">{ytmQuote.accruedInterestPer100.toFixed(3)}</p>
                    </div>
                    <div className="p-3 rounded-lg border bg-white">
                      <p className="text-[11px] text-slate-500 font-semibold">Dirty Price</p>
                      <p className="font-bold text-slate-800">{ytmQuote.dirtyPrice.toFixed(3)}</p>
                    </div>
                    <div className="p-3 rounded-lg border bg-white">
                      <p className="text-[11px] text-slate-500 font-semibold">Dirty + Commission / 100</p>
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
                    <div className="p-3 rounded-lg bg-slate-900 text-white text-sm flex flex-wrap justify-between gap-2">
                      <span className="text-slate-300">FRED 曲線插值（{ytmQuote.years.toFixed(2)} 年）</span>
                      <span className="font-bold">{ytmQuote.marketYield.toFixed(3)}%</span>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={handleAddYtmToPortfolio}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white px-4 py-3 rounded-lg text-sm font-semibold transition-colors flex items-center justify-center gap-2"
                  >
                    <Plus size={16} /> 加入 Portfolio
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
    else if (ledgerSubTab === 'closed') displayedTrades = [...maturedTrades, ...closedTrades].sort((a,b) => new Date(b.tradeDate) - new Date(a.tradeDate));

    return (
      <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-white">
          <h3 className="text-base sm:text-lg font-bold text-slate-800">美債交易總帳</h3>
          <button onClick={() => { setFormData(defaultForm); setIsFormOpen(true); }} className="bg-blue-600 hover:bg-blue-700 text-white px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-colors flex items-center shadow-sm"><Plus size={15} className="mr-1" /> 新增交易</button>
        </div>
        <div className="flex gap-1 sm:gap-6 px-2 sm:px-4 pt-2 bg-slate-50 border-b border-slate-200 overflow-x-auto">
          <button onClick={() => setLedgerSubTab('active')} className={`pb-2.5 px-2 text-xs sm:text-sm font-bold flex items-center border-b-2 whitespace-nowrap transition-colors ${ledgerSubTab === 'active' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}><Activity size={14} className="mr-1.5"/> 活躍 ({activeTrades.length})</button>
          <button onClick={() => setLedgerSubTab('closed')} className={`pb-2.5 px-2 text-xs sm:text-sm font-bold flex items-center border-b-2 whitespace-nowrap transition-colors ${ledgerSubTab === 'closed' ? 'border-slate-800 text-slate-800' : 'border-transparent text-slate-500 hover:text-slate-700'}`}><Archive size={14} className="mr-1.5"/> 已結算 ({maturedTrades.length + closedTrades.length})</button>
          <button onClick={() => setLedgerSubTab('coupons')} className={`pb-2.5 px-2 text-xs sm:text-sm font-bold flex items-center border-b-2 whitespace-nowrap transition-colors ${ledgerSubTab === 'coupons' ? 'border-emerald-600 text-emerald-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}><History size={14} className="mr-1.5"/> 收息 ({receivedCoupons.length})</button>
        </div>
        <div className="overflow-x-auto">
          {ledgerSubTab === 'coupons' ? (
             <table className="w-full text-left text-sm whitespace-nowrap"><thead className="bg-emerald-50 text-emerald-800 font-medium"><tr><th className="p-4">派息日期</th><th className="p-4">CUSIP / Type</th><th className="p-4 text-right">派息金額 (USD)</th></tr></thead><tbody className="divide-y divide-slate-100">{receivedCoupons.length === 0 ? <tr><td colSpan="3" className="p-8 text-center text-slate-400">尚未有派息紀錄。</td></tr> : receivedCoupons.sort((a,b) => b.date - a.date).map(c => (<tr key={c.id} className="hover:bg-slate-50"><td className="p-4 font-medium text-slate-700">{c.dateStr}</td><td className="p-4 text-slate-600">{c.cusip}</td><td className={`p-4 text-right font-bold ${c.amount >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>{c.amount >= 0 ? '+' : ''}${c.amount.toLocaleString(undefined, {minimumFractionDigits:2})}</td></tr>))}</tbody></table>
          ) : (
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-white text-slate-600 font-medium border-b border-slate-200">
                <tr><th className="p-4">CUSIP</th><th className="p-4">Action/Type</th><th className="p-4 text-right">Face Value</th><th className="p-4 text-right">Cost (Clean)</th>{ledgerSubTab === 'active' ? <><th className="p-4 text-right text-blue-600">Clean Market Price</th><th className="p-4 text-right">Unrealized PnL</th></> : <><th className="p-4 text-right">Close Price</th><th className="p-4 text-right text-emerald-600">Realized PnL</th></>}<th className="p-4 text-center">Action</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {displayedTrades.length === 0 ? <tr><td colSpan="8" className="p-8 text-center text-slate-400">無紀錄。</td></tr> : displayedTrades.map(trade => {
                  const mult = trade.side === 'sell' ? -1 : 1; const isMaturedBond = isMatured(trade.maturityDate) && trade.status !== 'closed'; let pnl = 0;
                  const faceValue = toFiniteNumber(trade.faceValue);
                  const cleanPrice = toFiniteNumber(trade.cleanPrice);
                  const marketPrice = toFiniteNumber(trade.currentMarketPrice, cleanPrice);
                  const accruedInterestPer100 = getAccruedInterestPer100(trade, todayObj);
                  const dirtyPrice = getDirtyPrice(marketPrice, accruedInterestPer100) || marketPrice;
                  const closePrice = toFiniteNumber(trade.closePrice, marketPrice);
                  if (trade.status === 'closed') pnl = (((closePrice - cleanPrice) * faceValue) / 100) * mult - (toFiniteNumber(trade.commission)) - (toFiniteNumber(trade.closeCommission)); else if (isMaturedBond) pnl = (((100 - cleanPrice) * faceValue) / 100) * mult - (toFiniteNumber(trade.commission)); else pnl = ((((marketPrice - cleanPrice) * faceValue) / 100) * mult) - (toFiniteNumber(trade.commission));
                  return (
                    <tr key={trade.id} className="hover:bg-slate-50 transition-colors">
                      <td className="p-4 font-medium">{trade.cusip || '--'}<div className="text-[10px] text-slate-400">Mat: {trade.maturityDate}</div></td>
                      <td className="p-4"><span className={`px-2 py-0.5 rounded text-[10px] font-bold text-white shadow-sm ${trade.side === 'sell' ? 'bg-red-500' : 'bg-emerald-500'} mr-1`}>{trade.side.toUpperCase()}</span><span className="px-2 py-0.5 rounded text-[10px] uppercase font-bold bg-slate-200 text-slate-700">{trade.type}</span>{isMaturedBond && <div className="text-[10px] text-amber-600 mt-1 font-bold">已到期</div>}{trade.status === 'closed' && <div className="text-[10px] text-slate-500 mt-1">已平倉 ({trade.closeDate})</div>}</td>
                      <td className="p-4 text-right">${faceValue.toLocaleString()}</td><td className="p-4 text-right">{cleanPrice.toFixed(3)}</td>
                      {ledgerSubTab === 'active' ? (
                        <><td className="p-4 text-right">{editingPriceId === trade.id ? (<div className="flex items-center justify-end"><input type="number" step="0.001" className="w-20 border rounded px-1 text-right" value={newPrice} onChange={e=>setNewPrice(e.target.value)}/><button onClick={()=>handleUpdatePrice(trade.id)} className="text-green-600 text-xs ml-1 font-bold">Save</button></div>) : (<div className="text-right"><span className="cursor-pointer text-blue-600 font-medium flex items-center justify-end" onClick={()=>{setEditingPriceId(trade.id); setNewPrice(marketPrice);}}>{marketPrice.toFixed(3)} <Edit2 size={12} className="ml-1 opacity-50"/></span>{isCouponTreasury(trade) && <div className="text-[10px] text-slate-400">Accrued {accruedInterestPer100.toFixed(3)} · Dirty {dirtyPrice.toFixed(3)}</div>}</div>)}</td><td className={`p-4 text-right font-bold ${pnl>=0?'text-green-600':'text-red-600'}`}>{pnl>=0?'+':''}${pnl.toLocaleString(undefined,{minimumFractionDigits:2})}</td></>
                      ) : (
                        <><td className="p-4 text-right font-medium">{trade.status === 'closed' ? closePrice.toFixed(3) : '100.000 (Par)'}</td><td className={`p-4 text-right font-bold ${pnl>=0?'text-emerald-600':'text-red-600'}`}>{pnl>=0?'+':''}${pnl.toLocaleString(undefined,{minimumFractionDigits:2})}</td></>
                      )}
                      <td className="p-4 text-center"><div className="flex items-center justify-center space-x-2"><button onClick={()=>{setFormData(trade); setEditingTradeId(trade.id); setIsFormOpen(true);}} className="text-blue-500 hover:bg-blue-50 p-1 rounded"><Edit2 size={16} /></button>{ledgerSubTab === 'active' && <button onClick={()=>{setClosingTradeId(trade.id); setCloseData({ ...closeData, closePrice: trade.currentMarketPrice }); setIsCloseModalOpen(true);}} className="text-orange-500 hover:bg-orange-50 p-1 rounded" title="平倉"><LogOut size={16} /></button>}<button onClick={() => deleteTradeFromDB(trade.id)} className="text-red-500 hover:bg-red-50 p-1 rounded"><Trash2 size={16} /></button></div></td>
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
    <div className="min-h-screen bg-slate-100 font-sans text-slate-900 pb-20">
      <nav className="bg-slate-900 text-white px-4 py-2.5 sm:py-3 sticky top-0 z-20 shadow-md">
        <div className="max-w-7xl mx-auto flex justify-between items-center gap-3">
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-blue-700 rounded-lg flex items-center justify-center font-bold text-sm shadow-sm flex-shrink-0">US</div>
            <h1 className="text-base sm:text-xl font-bold tracking-tight truncate">Portfolio Dashboard</h1>
          </div>
          {user && (
            <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
              <span className="text-xs text-slate-300 hidden lg:inline truncate max-w-[160px]">{user.email}</span>
              <button onClick={handleExport} disabled={trades.length === 0} className="text-xs sm:text-sm bg-slate-800 hover:bg-slate-700 disabled:opacity-40 px-2.5 py-1.5 rounded-md transition-colors flex items-center gap-1" title="匯出資料">
                <Download size={14}/><span className="hidden sm:inline">匯出</span>
              </button>
              <button onClick={handleImport} className="text-xs sm:text-sm bg-slate-800 hover:bg-slate-700 px-2.5 py-1.5 rounded-md transition-colors flex items-center gap-1" title="匯入資料">
                <Upload size={14}/><span className="hidden sm:inline">匯入</span>
              </button>
              <button onClick={handleLogout} className="text-xs sm:text-sm bg-slate-800 hover:bg-red-600 px-2.5 py-1.5 rounded-md transition-colors flex items-center gap-1" title="登出">
                <LogOut size={14}/><span className="hidden sm:inline">登出</span>
              </button>
            </div>
          )}
        </div>
      </nav>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
        <div className="-mx-4 sm:mx-0 mb-5 overflow-x-auto px-4 sm:px-0">
        <div className="flex w-max min-w-full sm:min-w-0 gap-1 bg-slate-200/70 p-1 rounded-xl shadow-inner">
          <button onClick={() => setActiveTab('dashboard')} className={`px-4 sm:px-5 py-2 rounded-lg text-sm font-semibold transition-all flex items-center justify-center gap-1.5 ${activeTab === 'dashboard' ? 'bg-white shadow text-blue-600' : 'text-slate-600 hover:text-slate-800'}`}>
            <PieChart size={15}/> 總覽
          </button>
          <button onClick={() => setActiveTab('ytm')} className={`px-4 sm:px-5 py-2 rounded-lg text-sm font-semibold transition-all flex items-center justify-center gap-1.5 ${activeTab === 'ytm' ? 'bg-white shadow text-blue-600' : 'text-slate-600 hover:text-slate-800'}`}>
            <Calculator size={15}/> YTM 試算
          </button>
          <button onClick={() => setActiveTab('trades')} className={`px-4 sm:px-5 py-2 rounded-lg text-sm font-semibold transition-all flex items-center justify-center gap-1.5 ${activeTab === 'trades' ? 'bg-white shadow text-blue-600' : 'text-slate-600 hover:text-slate-800'}`}>
            <History size={15}/> 美債
          </button>
          <button onClick={() => setActiveTab('stocks')} className={`px-4 sm:px-5 py-2 rounded-lg text-sm font-semibold transition-all flex items-center justify-center gap-1.5 ${activeTab === 'stocks' ? 'bg-white shadow text-blue-600' : 'text-slate-600 hover:text-slate-800'}`}>
            <Briefcase size={15}/> 美股 / ETF
          </button>
          <button onClick={() => setActiveTab('cash')} className={`px-4 sm:px-5 py-2 rounded-lg text-sm font-semibold transition-all flex items-center justify-center gap-1.5 ${activeTab === 'cash' ? 'bg-white shadow text-blue-600' : 'text-slate-600 hover:text-slate-800'}`}>
            <Banknote size={15}/> 現金
          </button>
          <button onClick={() => setActiveTab('import')} className={`px-4 sm:px-5 py-2 rounded-lg text-sm font-semibold transition-all flex items-center justify-center gap-1.5 ${activeTab === 'import' ? 'bg-white shadow text-blue-600' : 'text-slate-600 hover:text-slate-800'}`}>
            <Upload size={15}/> 匯入預覽
          </button>
        </div>
        </div>
        {activeTab === 'dashboard' ? renderDashboard() : activeTab === 'ytm' ? renderYtmCalculator() : activeTab === 'stocks' ? <StockDashboard db={db} user={user} /> : activeTab === 'cash' ? <CashDashboard db={db} user={user} /> : activeTab === 'import' ? <ImportPreviewDashboard db={db} user={user} /> : renderTrades()}
      </main>

      {isFormOpen && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="p-5 bg-slate-50 border-b flex justify-between items-center"><h2 className="text-lg font-bold">{editingTradeId ? '編輯交易' : '新增美債交易'}</h2><button onClick={() => setIsFormOpen(false)} className="text-slate-400 hover:text-slate-600 text-xl font-bold">&times;</button></div>
            {!editingTradeId && (<div className="px-5 pt-4"><div className="flex bg-slate-100 p-1 rounded-lg"><button type="button" onClick={() => setSmartInputMode(false)} className={`flex-1 py-1.5 text-sm font-medium rounded-md ${!smartInputMode ? 'bg-white shadow text-slate-800' : 'text-slate-500'}`}>手動輸入</button><button type="button" onClick={() => setSmartInputMode(true)} className={`flex-1 py-1.5 text-sm font-medium rounded-md ${smartInputMode ? 'bg-indigo-500 text-white shadow' : 'text-slate-500'}`}>✨ 智能貼上</button></div></div>)}
            <div className="p-5 overflow-y-auto max-h-[60vh]">
              {smartInputMode && !editingTradeId ? (<div className="space-y-4"><textarea value={rawTradeText} onChange={(e) => setRawTradeText(e.target.value)} placeholder="貼上交易單據..." className="w-full h-32 p-3 border rounded-lg text-sm" /><button type="button" onClick={handleSmartParse} disabled={isParsing || !rawTradeText.trim() || !hasAiTransport} className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center justify-center">{isParsing ? <Loader2 size={16} className="animate-spin mr-2" /> : <Bot size={16} className="mr-2" />} 讀取單據</button></div>) : (<>
                <form id="tradeForm" onSubmit={handleSaveTrade} className="space-y-4"><div className="grid grid-cols-2 gap-4"><div className="col-span-2"><label className="block text-xs font-medium text-slate-500 mb-1">CUSIP / 名稱</label><input required name="cusip" value={formData.cusip} onChange={(e)=>setFormData({...formData, cusip: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div><div><label className="block text-xs font-medium text-slate-500 mb-1">Bond Type</label><select required name="type" value={formData.type} onChange={(e)=>setFormData({...formData, type: e.target.value, couponRate: e.target.value==='t-bill'?0:formData.couponRate})} className="w-full p-2 border rounded-lg text-sm"><option value="t-bill">T-Bill</option><option value="t-note">T-Note</option><option value="t-bond">T-Bond</option><option value="tips">TIPS</option></select></div><div><label className="block text-xs font-medium text-slate-500 mb-1">Action</label><select required name="side" value={formData.side} onChange={(e)=>setFormData({...formData, side: e.target.value})} className="w-full p-2 border rounded-lg text-sm"><option value="buy">BUY (買入)</option><option value="sell">SELL (沽空)</option></select></div><div><label className="block text-xs font-medium text-slate-500 mb-1">Trade Date</label><input required type="date" name="tradeDate" value={formData.tradeDate} onChange={(e)=>setFormData({...formData, tradeDate: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div><div><label className="block text-xs font-medium text-slate-500 mb-1">Maturity Date</label><input required type="date" name="maturityDate" value={formData.maturityDate} onChange={(e)=>setFormData({...formData, maturityDate: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div><div><label className="block text-xs font-medium text-slate-500 mb-1">Face Value ($)</label><input required type="number" name="faceValue" value={formData.faceValue} onChange={(e)=>setFormData({...formData, faceValue: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div><div><label className="block text-xs font-medium text-slate-500 mb-1">Clean Price</label><input required type="number" step="0.001" name="cleanPrice" value={formData.cleanPrice} onChange={(e)=>setFormData({...formData, cleanPrice: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div><div><label className="block text-xs font-medium text-slate-500 mb-1">Commission ($)</label><input type="number" step="0.01" name="commission" value={formData.commission} onChange={(e)=>setFormData({...formData, commission: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div>{formData.type !== 't-bill' && (<><div className="col-span-2"><label className="block text-xs font-medium text-slate-500 mb-1">Coupon Rate (%)</label><input required type="number" step="0.125" name="couponRate" value={formData.couponRate} onChange={(e)=>setFormData({...formData, couponRate: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div><div className="col-span-2"><label className="block text-xs font-medium text-slate-500 mb-1">派息頻率</label><select name="couponFrequency" value={formData.couponFrequency} onChange={(e)=>setFormData({...formData, couponFrequency: e.target.value})} className="w-full p-2 border rounded-lg text-sm"><option value="12">Monthly</option><option value="4">Quarterly</option><option value="2">Semi-Annually</option><option value="1">Annually</option></select></div></>)}</div></form>
                {isCouponTreasury(formData) && (
                  <div className="mt-4">
                    <label className="block text-xs font-medium text-slate-500 mb-1">Accrued Interest / 100 (optional)</label>
                    <input type="number" min="0" step="0.001" value={formData.accruedInterestPer100 || ''} onChange={(e)=>setFormData({...formData, accruedInterestPer100: e.target.value})} placeholder="Auto" className="w-full p-2 border rounded-lg text-sm" />
                  </div>
                )}
              </>)}
            </div>
            <div className="p-5 border-t bg-slate-50 flex justify-end space-x-3"><button onClick={() => setIsFormOpen(false)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-lg">取消</button>{!smartInputMode && <button type="submit" form="tradeForm" className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm">儲存交易</button>}</div>
          </div>
        </div>
      )}
      
      {/* 平倉彈出視窗 */}
      {isCloseModalOpen && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="p-5 bg-orange-50 border-b border-orange-100 flex justify-between items-center"><h2 className="text-lg font-bold text-orange-800 flex items-center"><LogOut size={20} className="mr-2"/> 平倉結算</h2></div>
            <form id="closeForm" onSubmit={handleClosePosition} className="p-5 space-y-4"><p className="text-sm text-slate-600 mb-4">平倉後，該筆債券會移入「已結算區」，利潤將被鎖定。</p><div><label className="block text-xs font-medium text-slate-500 mb-1">賣出/平倉日期</label><input required type="date" value={closeData.closeDate} onChange={(e)=>setCloseData({...closeData, closeDate: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div><div><label className="block text-xs font-medium text-slate-500 mb-1">成交價 (Close Price)</label><input required type="number" step="0.001" value={closeData.closePrice} onChange={(e)=>setCloseData({...closeData, closePrice: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div><div><label className="block text-xs font-medium text-slate-500 mb-1">平倉手續費 ($)</label><input type="number" step="0.01" value={closeData.closeCommission} onChange={(e)=>setCloseData({...closeData, closeCommission: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div></form>
            <div className="p-5 border-t bg-slate-50 flex justify-end space-x-3"><button onClick={() => setIsCloseModalOpen(false)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-lg">取消</button><button type="submit" form="closeForm" className="px-4 py-2 text-sm font-medium text-white bg-orange-600 hover:bg-orange-700 rounded-lg shadow-sm">確認平倉</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
