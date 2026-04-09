import React, { useState, useMemo, useEffect } from 'react';
import { Plus, Trash2, Edit2, TrendingUp, DollarSign, Activity, Calendar, PieChart, Sparkles, Bot, Loader2, CheckCircle2, AlertCircle, BellRing, Archive, Wallet, Clock, LogOut, History, Landmark, Download, Upload } from 'lucide-react';
import { initializeApp } from 'firebase/app';
// --- 更新咗呢度：引入 Google 登入相關功能 ---
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, onSnapshot, doc, setDoc, deleteDoc } from 'firebase/firestore';

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

// --- Gemini API Configuration ---
const apiKey = import.meta.env.VITE_GEMINI_API_KEY || "";

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

const generateText = async (prompt) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: "You are an expert US Treasury Bond portfolio manager. Provide concise, professional insights in Traditional Chinese (Hong Kong style)." }] }
  };
  const result = await fetchWithRetry(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return result.candidates?.[0]?.content?.parts?.[0]?.text || "無法獲取 AI 回應。";
};

const extractTradeData = async (rawText) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ parts: [{ text: `Extract the US Treasury bond trade details from the following text:\n\n${rawText}` }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          cusip: { type: "STRING" }, type: { type: "STRING" }, side: { type: "STRING" }, tradeDate: { type: "STRING" }, maturityDate: { type: "STRING" },
          faceValue: { type: "NUMBER" }, cleanPrice: { type: "NUMBER" }, couponRate: { type: "NUMBER" }, commission: { type: "NUMBER" }, couponFrequency: { type: "NUMBER" }
        },
        required: ["type", "side", "faceValue", "cleanPrice", "couponRate"]
      }
    }
  };
  const result = await fetchWithRetry(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return JSON.parse(result.candidates?.[0]?.content?.parts?.[0]?.text);
};

// --- Math & Date Engine ---
const isMatured = (maturityDateStr) => {
  const today = new Date(); today.setHours(0, 0, 0, 0); return new Date(maturityDateStr) < today;
};
const calculateDaysBetween = (date1, date2) => Math.ceil(Math.abs(new Date(date2) - new Date(date1)) / (1000 * 60 * 60 * 24));

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
  const [rawTradeText, setRawTradeText] = useState('');
  const [isParsing, setIsParsing] = useState(false);

  const defaultForm = { cusip: '', type: 't-note', side: 'buy', tradeDate: new Date().toISOString().split('T')[0], maturityDate: '', faceValue: 1000, cleanPrice: 100, couponRate: 0, commission: 0, couponFrequency: 2 };
  const [formData, setFormData] = useState(defaultForm);
  const [closeData, setCloseData] = useState({ closeDate: new Date().toISOString().split('T')[0], closePrice: '', closeCommission: 0 });

  // --- Firebase Auth 監聽 (改為 Google 登入) ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

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

  const allCoupons = useMemo(() => trades.flatMap(generateAllCoupons), [trades]);
  const todayObj = new Date(); todayObj.setHours(0,0,0,0);
  const receivedCoupons = useMemo(() => allCoupons.filter(c => c.date <= todayObj), [allCoupons, todayObj]);
  const upcomingCouponsList = useMemo(() => allCoupons.filter(c => c.date > todayObj && c.date.getFullYear() === todayObj.getFullYear()), [allCoupons, todayObj]);

  // --- PnL Calculations ---
  const portfolioMetrics = useMemo(() => {
    let totalMarketValue = 0; let totalUnrealizedPnL = 0; let totalWeightYTM = 0; let totalFace = 0; let absoluteTotalMarketValue = 0; let totalRealizedPnL = 0; let annualCouponIncome = 0;
    receivedCoupons.forEach(c => totalRealizedPnL += c.amount);
    closedTrades.forEach(t => { const mult = t.side === 'sell' ? -1 : 1; totalRealizedPnL += (((t.closePrice - t.cleanPrice) * t.faceValue) / 100) * mult - (t.commission||0) - (t.closeCommission||0); });
    maturedTrades.forEach(t => { const mult = t.side === 'sell' ? -1 : 1; totalRealizedPnL += (((100 - t.cleanPrice) * t.faceValue) / 100) * mult - (t.commission||0); });
    activeTrades.forEach(trade => {
      const mult = trade.side === 'sell' ? -1 : 1;
      const marketVal = ((trade.currentMarketPrice * trade.faceValue) / 100) * mult;
      totalMarketValue += marketVal;
      totalUnrealizedPnL += ((((trade.currentMarketPrice - trade.cleanPrice) * trade.faceValue) / 100) * mult) - (trade.commission||0);
      totalFace += trade.faceValue * mult;
      absoluteTotalMarketValue += Math.abs(marketVal);
      if (trade.type !== 't-bill' && trade.couponRate) {
        annualCouponIncome += (trade.faceValue * (trade.couponRate / 100)) * mult;
      }
    });
    activeTrades.forEach(trade => {
      const mult = trade.side === 'sell' ? -1 : 1;
      const marketVal = ((trade.currentMarketPrice * trade.faceValue) / 100) * mult;
      const weight = Math.abs(marketVal) / (absoluteTotalMarketValue || 1);
      const daysToMat = calculateDaysBetween(todayObj, trade.maturityDate);
      const yearsToMat = daysToMat / 365.25;
      let ytm = 0;
      if (yearsToMat > 0) {
        if (trade.type === 't-bill') ytm = ((100 - trade.currentMarketPrice) / trade.currentMarketPrice) * (365 / daysToMat) * 100;
        else ytm = (((trade.couponRate) + (100 - trade.currentMarketPrice) / yearsToMat) / ((100 + trade.currentMarketPrice) / 2)) * 100;
      }
      totalWeightYTM += ytm * weight;
    });
    return { totalMarketValue, totalUnrealizedPnL, totalWeightYTM, totalFace, totalRealizedPnL, monthlyAvgIncome: annualCouponIncome / 12 };
  }, [activeTrades, maturedTrades, closedTrades, receivedCoupons]);

  // --- Database Actions ---
  const saveTradeToDB = async (tradeData) => {
    if (!user) return;
    const tradeRef = doc(db, 'users', user.uid, 'trades', tradeData.id);
    await setDoc(tradeRef, tradeData);
  };

  const deleteTradeFromDB = async (id) => {
    if (!user) return;
    await deleteDoc(doc(db, 'users', user.uid, 'trades', id));
  };

  const handleSaveTrade = async (e) => {
    e.preventDefault();
    const tradeData = { ...formData, faceValue: Number(formData.faceValue) || 0, cleanPrice: Number(formData.cleanPrice) || 0, couponRate: Number(formData.couponRate) || 0, commission: Number(formData.commission) || 0, couponFrequency: Number(formData.couponFrequency) || 0, status: 'active' };
    if (!editingTradeId) {
      tradeData.id = Date.now().toString();
      tradeData.currentMarketPrice = Number(formData.cleanPrice);
    } else {
      tradeData.id = editingTradeId;
      tradeData.currentMarketPrice = trades.find(t=>t.id===editingTradeId)?.currentMarketPrice || tradeData.cleanPrice;
    }
    await saveTradeToDB(tradeData);
    setIsFormOpen(false); setEditingTradeId(null);
  };

  const handleClosePosition = async (e) => {
    e.preventDefault();
    const trade = trades.find(t => t.id === closingTradeId);
    if (!trade) return;
    const updatedTrade = { ...trade, status: 'closed', closeDate: closeData.closeDate, closePrice: Number(closeData.closePrice), closeCommission: Number(closeData.closeCommission) || 0, currentMarketPrice: Number(closeData.closePrice) };
    await saveTradeToDB(updatedTrade);
    setIsCloseModalOpen(false);
  };

  const handleUpdatePrice = async (id) => {
    const trade = trades.find(t => t.id === id);
    if (trade) await saveTradeToDB({ ...trade, currentMarketPrice: Number(newPrice) });
    setEditingPriceId(null);
  };

  const handleSmartParse = async () => {
    if (!rawTradeText.trim()) return;
    setIsParsing(true);
    try {
      const parsedData = await extractTradeData(rawTradeText);
      setFormData({ ...defaultForm, ...parsedData });
      setSmartInputMode(false); setRawTradeText('');
    } catch (err) { alert("無法解析文字，請檢查格式。"); } finally { setIsParsing(false); }
  };

  const handleAnalyzePortfolio = async () => {
    if (activeTrades.length === 0) return;
    setIsAnalyzing(true); setInsightError('');
    try {
      const prompt = `Here is a summary of a user's ACTIVE US Treasury bond portfolio:
        Total Market Value: $${portfolioMetrics.totalMarketValue.toFixed(2)}, Total Unrealized PnL: $${portfolioMetrics.totalUnrealizedPnL.toFixed(2)}, Weighted Average YTM: ${portfolioMetrics.totalWeightYTM.toFixed(2)}%
        Detailed holdings: ${activeTrades.map(t => `- ${t.side.toUpperCase()} ${t.type.toUpperCase()}, Face Value: $${t.faceValue}, Matures: ${t.maturityDate}`).join('\n')}
        Provide a short analysis on interest rate risk, reinvestment risk, and strategic recommendation. Keep it under 3 paragraphs with bullet points. Respond in Traditional Chinese (HK).`;
      const response = await generateText(prompt);
      setAiInsights(response);
    } catch (err) { setInsightError('分析時發生錯誤。請確保已設定 API Key。'); } finally { setIsAnalyzing(false); }
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
        let added = 0;
        for (const trade of imported) {
          if (!trade.id || !trade.type || !trade.side) continue;
          if (existingIds.has(trade.id)) continue;
          await saveTradeToDB(trade);
          added++;
        }
        alert(`匯入完成：新增 ${added} 筆交易，略過 ${imported.length - added} 筆（重複或無效）。`);
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
          <h1 className="text-2xl font-bold text-slate-800 mb-2">US Treasury Dashboard</h1>
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
    <div className="space-y-6">
      <div className="bg-gradient-to-r from-emerald-600 to-teal-700 rounded-xl shadow-lg p-6 text-white relative overflow-hidden">
        <div className="absolute top-0 right-0 p-4 opacity-20"><Landmark size={100} /></div>
        <h3 className="text-emerald-100 font-medium mb-1">Total Realized PnL (累計已實現利潤)</h3>
        <div className="flex items-end space-x-3">
          <p className="text-4xl font-bold tracking-tight">{portfolioMetrics.totalRealizedPnL >= 0 ? '+' : ''}${portfolioMetrics.totalRealizedPnL.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p>
          <span className="text-sm bg-white/20 px-2 py-1 rounded mb-1">已包含所有平倉、到期結算及歷史收息</span>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-100 flex items-center space-x-4">
          <div className="p-3 bg-blue-50 text-blue-600 rounded-lg"><DollarSign size={24} /></div>
          <div><p className="text-xs text-slate-500 font-medium">Active Market Value</p><p className="text-xl font-bold text-slate-800">${portfolioMetrics.totalMarketValue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p></div>
        </div>
        <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-100 flex items-center space-x-4">
          <div className={`p-3 rounded-lg ${portfolioMetrics.totalUnrealizedPnL >= 0 ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`}><Activity size={24} /></div>
          <div><p className="text-xs text-slate-500 font-medium">Active Unrealized PnL</p><p className={`text-xl font-bold ${portfolioMetrics.totalUnrealizedPnL >= 0 ? 'text-green-600' : 'text-red-600'}`}>{portfolioMetrics.totalUnrealizedPnL >= 0 ? '+' : ''}${portfolioMetrics.totalUnrealizedPnL.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p></div>
        </div>
        <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-100 flex items-center space-x-4">
          <div className="p-3 bg-amber-50 text-amber-600 rounded-lg"><TrendingUp size={24} /></div>
          <div><p className="text-xs text-slate-500 font-medium">Weighted Avg YTM</p><p className="text-xl font-bold text-slate-800">{portfolioMetrics.totalWeightYTM.toFixed(2)}%</p></div>
        </div>
        <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-100 flex items-center space-x-4">
          <div className="p-3 bg-emerald-50 text-emerald-600 rounded-lg"><Wallet size={24} /></div>
          <div><p className="text-xs text-slate-500 font-medium">平均每月利息</p><p className="text-xl font-bold text-emerald-600">${portfolioMetrics.monthlyAvgIncome.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p></div>
        </div>
      </div>
      <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
        <div className="flex justify-between items-center mb-4 border-b pb-2"><h3 className="text-lg font-bold text-slate-800 flex items-center"><Wallet className="mr-2 text-emerald-500" size={20}/> 今年剩餘應收派息</h3></div>
        {upcomingCouponsList.length === 0 ? <p className="text-sm text-slate-500 py-4 text-center bg-slate-50 rounded">今年內暫無剩餘派息。</p> : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {upcomingCouponsList.map(c => (
              <div key={c.id} className="bg-emerald-50/50 border border-emerald-100 p-3 rounded-lg"><p className="text-xs font-bold text-slate-500">{c.dateStr}</p><p className="text-xs text-slate-700 my-1">{c.cusip}</p><p className={`font-bold ${c.amount >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>{c.amount >= 0 ? '+' : ''}${c.amount.toLocaleString(undefined, {minimumFractionDigits:2})}</p></div>
            ))}
          </div>
        )}
      </div>
      <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
        <div className="flex justify-between items-center mb-4 border-b pb-2"><h3 className="text-lg font-bold text-slate-800 flex items-center"><Clock className="mr-2 text-blue-500" size={20}/> 債券到期倒數</h3></div>
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
            <div className="space-y-3">
              {sorted.map(trade => {
                const days = calculateDaysBetween(todayObj, trade.maturityDate);
                const pct = (days / maxDays) * 100;
                const color = getColor(days);
                return (
                  <div key={trade.id} className="flex items-center space-x-3">
                    <div className="w-28 flex-shrink-0">
                      <p className="text-xs font-bold text-slate-700 truncate">{trade.cusip || trade.type.toUpperCase()}</p>
                      <p className="text-[10px] text-slate-400">{trade.maturityDate}</p>
                    </div>
                    <div className={`flex-1 h-7 ${color.bg} rounded-md overflow-hidden relative`}>
                      <div className={`h-full ${color.bar} transition-all`} style={{ width: `${pct}%` }}></div>
                      <span className={`absolute inset-0 flex items-center px-3 text-xs font-bold ${color.text}`}>{formatCountdown(days)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 p-6 rounded-xl shadow-sm border border-blue-100">
        <div className="flex justify-between items-start mb-4">
          <div className="flex items-center space-x-2 text-indigo-700"><Bot size={24} /><h3 className="text-lg font-bold">Gemini 投資組合分析</h3></div>
          <button onClick={handleAnalyzePortfolio} disabled={isAnalyzing || activeTrades.length === 0} className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center shadow-sm">
            {isAnalyzing ? <Loader2 size={16} className="animate-spin mr-2" /> : <Sparkles size={16} className="mr-2" />} 智能分析活躍持倉
          </button>
        </div>
        {insightError && <p className="text-sm text-red-600 flex items-center mt-2"><AlertCircle size={16} className="mr-1"/>{insightError}</p>}
        {aiInsights ? <div className="bg-white/80 p-4 rounded-lg text-sm text-slate-700 leading-relaxed whitespace-pre-wrap border border-white">{aiInsights}</div> : <p className="text-sm text-indigo-400">點擊按鈕，讓 AI 為你分析現時債券梯的久期風險及資金流動性建議。</p>}
      </div>
    </div>
  );

  const renderTrades = () => {
    let displayedTrades = [];
    if (ledgerSubTab === 'active') displayedTrades = activeTrades;
    else if (ledgerSubTab === 'closed') displayedTrades = [...maturedTrades, ...closedTrades].sort((a,b) => new Date(b.tradeDate) - new Date(a.tradeDate));

    return (
      <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-white">
          <h3 className="text-lg font-bold text-slate-800">Trade Ledger</h3>
          <button onClick={() => { setFormData(defaultForm); setIsFormOpen(true); }} className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center"><Plus size={16} className="mr-1" /> Add Trade</button>
        </div>
        <div className="flex space-x-6 px-4 pt-2 bg-slate-50 border-b border-slate-200">
          <button onClick={() => setLedgerSubTab('active')} className={`pb-3 text-sm font-bold flex items-center border-b-2 ${ledgerSubTab === 'active' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500'}`}><Activity size={16} className="mr-2"/> 活躍持倉 ({activeTrades.length})</button>
          <button onClick={() => setLedgerSubTab('closed')} className={`pb-3 text-sm font-bold flex items-center border-b-2 ${ledgerSubTab === 'closed' ? 'border-slate-800 text-slate-800' : 'border-transparent text-slate-500'}`}><Archive size={16} className="mr-2"/> 已結算 / 到期 ({maturedTrades.length + closedTrades.length})</button>
          <button onClick={() => setLedgerSubTab('coupons')} className={`pb-3 text-sm font-bold flex items-center border-b-2 ${ledgerSubTab === 'coupons' ? 'border-emerald-600 text-emerald-600' : 'border-transparent text-slate-500'}`}><History size={16} className="mr-2"/> 收息歷史 ({receivedCoupons.length})</button>
        </div>
        <div className="overflow-x-auto">
          {ledgerSubTab === 'coupons' ? (
             <table className="w-full text-left text-sm whitespace-nowrap"><thead className="bg-emerald-50 text-emerald-800 font-medium"><tr><th className="p-4">派息日期</th><th className="p-4">CUSIP / Type</th><th className="p-4 text-right">派息金額 (USD)</th></tr></thead><tbody className="divide-y divide-slate-100">{receivedCoupons.length === 0 ? <tr><td colSpan="3" className="p-8 text-center text-slate-400">尚未有派息紀錄。</td></tr> : receivedCoupons.sort((a,b) => b.date - a.date).map(c => (<tr key={c.id} className="hover:bg-slate-50"><td className="p-4 font-medium text-slate-700">{c.dateStr}</td><td className="p-4 text-slate-600">{c.cusip}</td><td className={`p-4 text-right font-bold ${c.amount >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>{c.amount >= 0 ? '+' : ''}${c.amount.toLocaleString(undefined, {minimumFractionDigits:2})}</td></tr>))}</tbody></table>
          ) : (
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-white text-slate-600 font-medium border-b border-slate-200">
                <tr><th className="p-4">CUSIP</th><th className="p-4">Action/Type</th><th className="p-4 text-right">Face Value</th><th className="p-4 text-right">Cost (Clean)</th>{ledgerSubTab === 'active' ? <><th className="p-4 text-right text-blue-600">Market Price ✏️</th><th className="p-4 text-right">Unrealized PnL</th></> : <><th className="p-4 text-right">Close Price</th><th className="p-4 text-right text-emerald-600">Realized PnL</th></>}<th className="p-4 text-center">Action</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {displayedTrades.length === 0 ? <tr><td colSpan="8" className="p-8 text-center text-slate-400">無紀錄。</td></tr> : displayedTrades.map(trade => {
                  const mult = trade.side === 'sell' ? -1 : 1; const isMaturedBond = isMatured(trade.maturityDate) && trade.status !== 'closed'; let pnl = 0;
                  if (trade.status === 'closed') pnl = (((trade.closePrice - trade.cleanPrice) * trade.faceValue) / 100) * mult - (trade.commission||0) - (trade.closeCommission||0); else if (isMaturedBond) pnl = (((100 - trade.cleanPrice) * trade.faceValue) / 100) * mult - (trade.commission||0); else pnl = ((((trade.currentMarketPrice - trade.cleanPrice) * trade.faceValue) / 100) * mult) - (trade.commission||0);
                  return (
                    <tr key={trade.id} className="hover:bg-slate-50 transition-colors">
                      <td className="p-4 font-medium">{trade.cusip || '--'}<div className="text-[10px] text-slate-400">Mat: {trade.maturityDate}</div></td>
                      <td className="p-4"><span className={`px-2 py-0.5 rounded text-[10px] font-bold text-white shadow-sm ${trade.side === 'sell' ? 'bg-red-500' : 'bg-emerald-500'} mr-1`}>{trade.side.toUpperCase()}</span><span className="px-2 py-0.5 rounded text-[10px] uppercase font-bold bg-slate-200 text-slate-700">{trade.type}</span>{isMaturedBond && <div className="text-[10px] text-amber-600 mt-1 font-bold">已到期</div>}{trade.status === 'closed' && <div className="text-[10px] text-slate-500 mt-1">已平倉 ({trade.closeDate})</div>}</td>
                      <td className="p-4 text-right">${trade.faceValue.toLocaleString()}</td><td className="p-4 text-right">{trade.cleanPrice.toFixed(3)}</td>
                      {ledgerSubTab === 'active' ? (
                        <><td className="p-4 text-right">{editingPriceId === trade.id ? (<div className="flex items-center justify-end"><input type="number" step="0.001" className="w-20 border rounded px-1 text-right" value={newPrice} onChange={e=>setNewPrice(e.target.value)}/><button onClick={()=>handleUpdatePrice(trade.id)} className="text-green-600 text-xs ml-1 font-bold">Save</button></div>) : (<span className="cursor-pointer text-blue-600 font-medium flex items-center justify-end" onClick={()=>{setEditingPriceId(trade.id); setNewPrice(trade.currentMarketPrice);}}>{trade.currentMarketPrice.toFixed(3)} <Edit2 size={12} className="ml-1 opacity-50"/></span>)}</td><td className={`p-4 text-right font-bold ${pnl>=0?'text-green-600':'text-red-600'}`}>{pnl>=0?'+':''}${pnl.toLocaleString(undefined,{minimumFractionDigits:2})}</td></>
                      ) : (
                        <><td className="p-4 text-right font-medium">{trade.status === 'closed' ? trade.closePrice.toFixed(3) : '100.000 (Par)'}</td><td className={`p-4 text-right font-bold ${pnl>=0?'text-emerald-600':'text-red-600'}`}>{pnl>=0?'+':''}${pnl.toLocaleString(undefined,{minimumFractionDigits:2})}</td></>
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
      <nav className="bg-slate-900 text-white p-4 sticky top-0 z-20 shadow-md">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
          <div className="flex items-center space-x-3"><div className="w-8 h-8 bg-blue-500 rounded flex items-center justify-center font-bold text-lg">US</div><h1 className="text-xl font-bold tracking-tight">Treasury Dashboard</h1></div>
          {user && (
            <div className="flex items-center space-x-4">
              <span className="text-sm text-slate-300 hidden md:inline">{user.email}</span>
              <button onClick={handleExport} disabled={trades.length === 0} className="text-sm bg-slate-800 hover:bg-slate-700 disabled:opacity-40 px-3 py-1.5 rounded transition-colors flex items-center" title="匯出資料"><Download size={14} className="mr-1"/> 匯出</button>
              <button onClick={handleImport} className="text-sm bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded transition-colors flex items-center" title="匯入資料"><Upload size={14} className="mr-1"/> 匯入</button>
              <button onClick={handleLogout} className="text-sm bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded transition-colors flex items-center"><LogOut size={14} className="mr-1"/> 登出</button>
            </div>
          )}
        </div>
      </nav>
      <main className="max-w-6xl mx-auto p-4 mt-4">
        <div className="flex space-x-2 mb-6 bg-slate-200 p-1 rounded-lg w-max shadow-inner"><button onClick={() => setActiveTab('dashboard')} className={`px-5 py-2 rounded-md text-sm font-medium transition-all ${activeTab === 'dashboard' ? 'bg-white shadow text-blue-600' : 'text-slate-600'}`}>Analytics</button><button onClick={() => setActiveTab('trades')} className={`px-5 py-2 rounded-md text-sm font-medium transition-all ${activeTab === 'trades' ? 'bg-white shadow text-blue-600' : 'text-slate-600'}`}>Trade Ledger</button></div>
        {activeTab === 'dashboard' ? renderDashboard() : renderTrades()}
      </main>

      {isFormOpen && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="p-5 bg-slate-50 border-b flex justify-between items-center"><h2 className="text-lg font-bold">{editingTradeId ? 'Edit Trade' : 'Record New Trade'}</h2><button onClick={() => setIsFormOpen(false)} className="text-slate-400 hover:text-slate-600 text-xl font-bold">&times;</button></div>
            {!editingTradeId && (<div className="px-5 pt-4"><div className="flex bg-slate-100 p-1 rounded-lg"><button type="button" onClick={() => setSmartInputMode(false)} className={`flex-1 py-1.5 text-sm font-medium rounded-md ${!smartInputMode ? 'bg-white shadow text-slate-800' : 'text-slate-500'}`}>手動輸入</button><button type="button" onClick={() => setSmartInputMode(true)} className={`flex-1 py-1.5 text-sm font-medium rounded-md ${smartInputMode ? 'bg-indigo-500 text-white shadow' : 'text-slate-500'}`}>✨ 智能貼上</button></div></div>)}
            <div className="p-5 overflow-y-auto max-h-[60vh]">
              {smartInputMode && !editingTradeId ? (<div className="space-y-4"><textarea value={rawTradeText} onChange={(e) => setRawTradeText(e.target.value)} placeholder="貼上交易單據..." className="w-full h-32 p-3 border rounded-lg text-sm" /><button type="button" onClick={handleSmartParse} disabled={isParsing || !rawTradeText.trim()} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center justify-center">{isParsing ? <Loader2 size={16} className="animate-spin mr-2" /> : <Bot size={16} className="mr-2" />} 讀取單據</button></div>) : (
                <form id="tradeForm" onSubmit={handleSaveTrade} className="space-y-4"><div className="grid grid-cols-2 gap-4"><div className="col-span-2"><label className="block text-xs font-medium text-slate-500 mb-1">CUSIP / 名稱</label><input required name="cusip" value={formData.cusip} onChange={(e)=>setFormData({...formData, cusip: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div><div><label className="block text-xs font-medium text-slate-500 mb-1">Bond Type</label><select required name="type" value={formData.type} onChange={(e)=>setFormData({...formData, type: e.target.value, couponRate: e.target.value==='t-bill'?0:formData.couponRate})} className="w-full p-2 border rounded-lg text-sm"><option value="t-bill">T-Bill</option><option value="t-note">T-Note</option><option value="t-bond">T-Bond</option><option value="tips">TIPS</option></select></div><div><label className="block text-xs font-medium text-slate-500 mb-1">Action</label><select required name="side" value={formData.side} onChange={(e)=>setFormData({...formData, side: e.target.value})} className="w-full p-2 border rounded-lg text-sm"><option value="buy">BUY (買入)</option><option value="sell">SELL (沽空)</option></select></div><div><label className="block text-xs font-medium text-slate-500 mb-1">Trade Date</label><input required type="date" name="tradeDate" value={formData.tradeDate} onChange={(e)=>setFormData({...formData, tradeDate: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div><div><label className="block text-xs font-medium text-slate-500 mb-1">Maturity Date</label><input required type="date" name="maturityDate" value={formData.maturityDate} onChange={(e)=>setFormData({...formData, maturityDate: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div><div><label className="block text-xs font-medium text-slate-500 mb-1">Face Value ($)</label><input required type="number" name="faceValue" value={formData.faceValue} onChange={(e)=>setFormData({...formData, faceValue: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div><div><label className="block text-xs font-medium text-slate-500 mb-1">Clean Price</label><input required type="number" step="0.001" name="cleanPrice" value={formData.cleanPrice} onChange={(e)=>setFormData({...formData, cleanPrice: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div><div><label className="block text-xs font-medium text-slate-500 mb-1">Commission ($)</label><input type="number" step="0.01" name="commission" value={formData.commission} onChange={(e)=>setFormData({...formData, commission: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div>{formData.type !== 't-bill' && (<><div className="col-span-2"><label className="block text-xs font-medium text-slate-500 mb-1">Coupon Rate (%)</label><input required type="number" step="0.125" name="couponRate" value={formData.couponRate} onChange={(e)=>setFormData({...formData, couponRate: e.target.value})} className="w-full p-2 border rounded-lg text-sm" /></div><div className="col-span-2"><label className="block text-xs font-medium text-slate-500 mb-1">派息頻率</label><select name="couponFrequency" value={formData.couponFrequency} onChange={(e)=>setFormData({...formData, couponFrequency: e.target.value})} className="w-full p-2 border rounded-lg text-sm"><option value="12">Monthly</option><option value="4">Quarterly</option><option value="2">Semi-Annually</option><option value="1">Annually</option></select></div></>)}</div></form>
              )}
            </div>
            <div className="p-5 border-t bg-slate-50 flex justify-end space-x-3"><button onClick={() => setIsFormOpen(false)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-lg">Cancel</button>{!smartInputMode && <button type="submit" form="tradeForm" className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm">Save Trade</button>}</div>
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
