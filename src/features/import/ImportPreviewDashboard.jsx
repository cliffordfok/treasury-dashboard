import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, FileText, Loader2, RefreshCw, Search, Trash2, Upload, XCircle } from 'lucide-react';
import { subscribeCashMovements } from '../cash/cashFirestore.js';
import { subscribeReconciliationSnapshots } from '../reconciliation/reconciliationFirestore.js';
import { subscribeStockTrades } from '../stocks/stockFirestore.js';
import { buildConfirmImportPlan } from './importConfirmCalculations.js';
import { commitFirstradeImport } from './importFirestore.js';
import { PREVIEW_STATUS, buildImportPreviewFromCsvText } from './importPreviewCalculations.js';

const statusLabel = {
  OK: 'OK',
  WARNING: 'Warning',
  ERROR: 'Error',
  DUPLICATE: 'Duplicate',
  IGNORED: 'Ignored',
};

const duplicateLabel = {
  NEW: 'NEW',
  DUPLICATE_EXISTING: 'DUPLICATE_EXISTING',
  DUPLICATE_IN_FILE: 'DUPLICATE_IN_FILE',
};

const targetLabel = {
  'Stock Trade': 'Stock Trade',
  'Cash Movement': 'Cash Movement',
  'Reconciliation Holding': 'Reconciliation Holding',
  Unknown: 'Unknown',
};

const statusClass = (status) => {
  if (status === PREVIEW_STATUS.OK) return 'bg-emerald-50 text-emerald-700 border-emerald-100';
  if (status === PREVIEW_STATUS.WARNING) return 'bg-amber-50 text-amber-700 border-amber-100';
  if (status === PREVIEW_STATUS.DUPLICATE) return 'bg-orange-50 text-orange-700 border-orange-100';
  if (status === PREVIEW_STATUS.IGNORED) return 'bg-slate-100 text-slate-500 border-slate-200';
  return 'bg-red-50 text-red-700 border-red-100';
};

const SummaryCard = ({ label, value, tone = 'slate' }) => {
  const toneClasses = {
    slate: 'text-slate-800',
    emerald: 'text-emerald-600',
    amber: 'text-amber-600',
    red: 'text-red-600',
    orange: 'text-orange-600',
  };
  return (
    <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
      <p className="text-[11px] text-slate-500 font-medium">{label}</p>
      <p className={`text-xl font-bold ${toneClasses[tone] || toneClasses.slate}`}>{value}</p>
    </div>
  );
};

const JsonBlock = ({ title, value }) => (
  <div>
    <p className="text-xs font-bold text-slate-600 mb-1">{title}</p>
    <pre className="bg-slate-900 text-slate-100 rounded-lg p-3 text-xs overflow-auto max-h-64">{JSON.stringify(value, null, 2)}</pre>
  </div>
);

export default function ImportPreviewDashboard({ db, user }) {
  const [stockTrades, setStockTrades] = useState([]);
  const [cashMovements, setCashMovements] = useState([]);
  const [reconciliationSnapshots, setReconciliationSnapshots] = useState([]);
  const [fileName, setFileName] = useState('');
  const [csvText, setCsvText] = useState('');
  const [parseError, setParseError] = useState('');
  const [filter, setFilter] = useState('all');
  const [selectedRow, setSelectedRow] = useState(null);
  const [isReading, setIsReading] = useState(false);
  const [dataError, setDataError] = useState('');
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [importError, setImportError] = useState('');

  useEffect(() => {
    if (!db || !user?.uid) return undefined;
    return subscribeStockTrades(db, user.uid, setStockTrades, (err) => setDataError(err.message || '未能載入現有美股交易作重複檢查。'));
  }, [db, user?.uid]);

  useEffect(() => {
    if (!db || !user?.uid) return undefined;
    return subscribeCashMovements(db, user.uid, setCashMovements, (err) => setDataError(err.message || '未能載入現有現金流水作重複檢查。'));
  }, [db, user?.uid]);

  useEffect(() => {
    if (!db || !user?.uid) return undefined;
    return subscribeReconciliationSnapshots(db, user.uid, setReconciliationSnapshots, (err) => setDataError(err.message || '未能載入現有對帳快照作重複檢查。'));
  }, [db, user?.uid]);

  const preview = useMemo(() => {
    if (!csvText) return null;
    try {
      return buildImportPreviewFromCsvText(csvText, {
        existingStockTrades: stockTrades,
        existingCashMovements: cashMovements,
        existingReconciliationSnapshots: reconciliationSnapshots,
      });
    } catch (error) {
      return { error: error.message || 'CSV 解析失敗。' };
    }
  }, [cashMovements, csvText, reconciliationSnapshots, stockTrades]);

  const confirmPlan = useMemo(() => {
    if (!preview?.rows) return null;
    return buildConfirmImportPlan({
      previewRows: preview.rows,
      userId: user?.uid || '',
      existingStockTrades: stockTrades,
      existingCashMovements: cashMovements,
    });
  }, [cashMovements, preview?.rows, stockTrades, user?.uid]);

  const rows = preview?.rows || [];
  const filteredRows = useMemo(() => {
    if (filter === 'errors') return rows.filter((row) => row.status === PREVIEW_STATUS.ERROR);
    if (filter === 'duplicates') return rows.filter((row) => row.status === PREVIEW_STATUS.DUPLICATE);
    if (filter === 'ignored') return rows.filter((row) => row.status === PREVIEW_STATUS.IGNORED);
    if (filter === 'importable') return rows.filter((row) => row.importable);
    return rows;
  }, [filter, rows]);

  const handleFile = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setParseError('');
    setSelectedRow(null);
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setParseError('請選擇 .csv 檔案。');
      return;
    }

    const reader = new FileReader();
    setIsReading(true);
    reader.onload = () => {
      setFileName(file.name);
      setCsvText(String(reader.result || ''));
      setIsReading(false);
    };
    reader.onerror = () => {
      setParseError('讀取 CSV 檔案失敗。');
      setIsReading(false);
    };
    reader.readAsText(file);
  };

  const clearFile = () => {
    setFileName('');
    setCsvText('');
    setParseError('');
    setFilter('all');
    setSelectedRow(null);
    setIsConfirmOpen(false);
    setConfirmChecked(false);
    setImportResult(null);
    setImportError('');
  };

  const reparse = () => {
    setCsvText((text) => `${text}`);
    setSelectedRow(null);
    setImportResult(null);
    setImportError('');
  };

  const handleConfirmImport = async () => {
    if (!confirmPlan?.summary?.importableRows || !confirmChecked) return;
    setIsImporting(true);
    setImportError('');
    try {
      const result = await commitFirstradeImport({
        db,
        userId: user.uid,
        previewRows: rows,
        existingStockTrades: stockTrades,
        existingCashMovements: cashMovements,
      });
      setImportResult(result);
      setIsConfirmOpen(false);
      setConfirmChecked(false);
    } catch (error) {
      setImportError(error.message || String(error));
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="bg-slate-900 text-white rounded-2xl shadow-lg p-5 sm:p-6 relative overflow-hidden">
        <div className="absolute -top-6 -right-6 opacity-10 pointer-events-none"><Upload size={160} /></div>
        <p className="text-slate-300 text-xs sm:text-sm font-medium mb-1.5">Import / 匯入預覽</p>
        <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">Firstrade CSV Preview</h2>
        <p className="text-slate-300 text-sm mt-2 max-w-2xl">上載 CSV 後只做解析、mapping、validation 及重複檢查預覽；Phase 3B 不會寫入 Firestore。</p>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-4 sm:p-5">
        <div className="flex flex-col md:flex-row md:items-center gap-3 justify-between">
          <div>
            <h3 className="text-base font-bold text-slate-800 flex items-center gap-2"><FileText size={18} className="text-blue-600" />選擇 Firstrade CSV</h3>
            <p className="text-xs text-slate-500 mt-1">支援 header row、quoted fields、comma inside quotes、empty cells、CRLF / LF。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 cursor-pointer">
              <Upload size={16} /> 選擇 CSV
              <input type="file" accept=".csv,text/csv" onChange={handleFile} className="hidden" />
            </label>
            <button type="button" onClick={reparse} disabled={!csvText} className="bg-slate-100 hover:bg-slate-200 disabled:opacity-40 px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2">
              <RefreshCw size={16} /> 重新解析
            </button>
            <button type="button" onClick={clearFile} disabled={!csvText && !parseError} className="bg-slate-100 hover:bg-slate-200 disabled:opacity-40 px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2">
              <Trash2 size={16} /> 清除檔案
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
          <div className="bg-slate-50 border rounded-lg p-3">
            <p className="text-xs text-slate-500">檔案名稱</p>
            <p className="font-bold text-slate-800 truncate">{fileName || '--'}</p>
          </div>
          <div className="bg-slate-50 border rounded-lg p-3">
            <p className="text-xs text-slate-500">CSV 類型</p>
            <p className="font-bold text-slate-800">{preview?.summary?.csvType || preview?.csvType || '--'}</p>
          </div>
          <div className="bg-slate-50 border rounded-lg p-3">
            <p className="text-xs text-slate-500">Row Count</p>
            <p className="font-bold text-slate-800">{preview?.summary?.totalRows ?? 0}</p>
          </div>
        </div>

        {isReading && <p className="mt-3 text-sm text-blue-600 flex items-center gap-2"><Loader2 size={16} className="animate-spin" />讀取檔案中...</p>}
        {(parseError || preview?.error || dataError) && (
          <p className="mt-3 text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg p-3 flex items-center gap-2">
            <AlertCircle size={16} />{parseError || preview?.error || dataError}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-8 gap-3 sm:gap-4">
        <SummaryCard label="總 rows" value={preview?.summary?.totalRows ?? 0} />
        <SummaryCard label="已 mapping" value={preview?.summary?.mappedRows ?? 0} />
        <SummaryCard label="OK" value={preview?.summary?.okRows ?? 0} tone="emerald" />
        <SummaryCard label="Warning" value={preview?.summary?.warningRows ?? 0} tone="amber" />
        <SummaryCard label="Error" value={preview?.summary?.errorRows ?? 0} tone="red" />
        <SummaryCard label="Ignored" value={preview?.summary?.ignoredRows ?? 0} />
        <SummaryCard label="Duplicate" value={preview?.summary?.duplicateRows ?? 0} tone="orange" />
        <SummaryCard label="可匯入候選" value={preview?.summary?.importableRows ?? 0} />
      </div>

      {importError && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg p-3 flex items-center gap-2">
          <AlertCircle size={16} />{importError}
        </p>
      )}
      {importResult && (
        <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg p-3">
          <p className="font-bold">Import completed</p>
          <p>Stock trades: {importResult.result.importedStockTrades} · Cash movements: {importResult.result.importedCashMovements} · Skipped: {importResult.result.skippedRows} · Failed: {importResult.result.failedRows}</p>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-4 sm:p-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-slate-800">Confirm Import Dry-run</h3>
            <p className="text-xs text-slate-500 mt-1">Only OK + NEW stock trade / cash movement rows are eligible. Positions, ignored, duplicate, warning, and error rows are skipped.</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="bg-slate-50 border rounded-lg p-2"><span className="block text-slate-500">Stock Trades</span><b>{confirmPlan?.summary?.stockTradeRows ?? 0}</b></div>
            <div className="bg-slate-50 border rounded-lg p-2"><span className="block text-slate-500">Cash Movements</span><b>{confirmPlan?.summary?.cashMovementRows ?? 0}</b></div>
            <div className="bg-slate-50 border rounded-lg p-2"><span className="block text-slate-500">Skipped</span><b>{confirmPlan?.skippedRows?.length ?? 0}</b></div>
            <div className="bg-slate-50 border rounded-lg p-2"><span className="block text-slate-500">Cash Impact</span><b>{(confirmPlan?.summary?.totalCashImpact ?? 0).toFixed(2)}</b></div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={() => setIsConfirmOpen(true)} disabled={!confirmPlan?.summary?.importableRows || isImporting} className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2">
            {isImporting ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />} Confirm Import
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <h3 className="text-base font-bold text-slate-800 flex items-center gap-2"><Search size={18} className="text-slate-600" />Preview Rows</h3>
          <div className="flex flex-wrap gap-2">
            {[
              ['all', '全部'],
              ['errors', '只看錯誤'],
              ['duplicates', '只看重複'],
              ['importable', '只看可匯入候選'],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${filter === key ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
              <tr>
                <th className="p-3 text-left">Row #</th>
                <th className="p-3 text-left">CSV Type</th>
                <th className="p-3 text-left">Activity Type</th>
                <th className="p-3 text-left">Target Draft</th>
                <th className="p-3 text-left">Symbol</th>
                <th className="p-3 text-left">Date</th>
                <th className="p-3 text-right">Amount / Quantity</th>
                <th className="p-3 text-left">Status</th>
                <th className="p-3 text-left">Duplicate</th>
                <th className="p-3 text-left">Errors / Warnings</th>
                <th className="p-3 text-center">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {!csvText ? (
                <tr><td colSpan="11" className="p-6 text-center text-slate-400">請先選擇 Firstrade CSV 檔案。</td></tr>
              ) : filteredRows.length === 0 ? (
                <tr><td colSpan="11" className="p-6 text-center text-slate-400">沒有符合篩選條件的 rows。</td></tr>
              ) : filteredRows.map((row) => (
                <tr key={`${row.rowNumber}-${row.fingerprint || row.activityType}`} className="hover:bg-slate-50">
                  <td className="p-3 font-semibold">{row.rowNumber}</td>
                  <td className="p-3">{row.csvType}</td>
                  <td className="p-3">{row.activityType}</td>
                  <td className="p-3">{targetLabel[row.targetDraft] || row.targetDraft}</td>
                  <td className="p-3 font-bold">{row.symbol || '--'}</td>
                  <td className="p-3">{row.date || '--'}</td>
                  <td className="p-3 text-right">{row.amountOrQuantity ?? '--'}</td>
                  <td className="p-3"><span className={`px-2 py-0.5 rounded border text-[10px] font-bold ${statusClass(row.status)}`}>{statusLabel[row.status] || row.status}</span></td>
                  <td className="p-3 text-xs">{duplicateLabel[row.duplicateStatus] || row.duplicateStatus}</td>
                  <td className="p-3 max-w-[260px]">
                    <div className="text-xs text-red-600 truncate">{row.errors.join(' | ')}</div>
                    <div className="text-xs text-amber-600 truncate">{row.warnings.join(' | ')}</div>
                  </td>
                  <td className="p-3 text-center">
                    <button type="button" onClick={() => setSelectedRow(row)} className="text-blue-600 hover:bg-blue-50 rounded px-2 py-1 text-xs font-semibold">Details</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex items-start gap-3 text-sm text-slate-600">
        <CheckCircle2 size={18} className="text-emerald-600 flex-shrink-0 mt-0.5" />
        <p>Phase 3C 只會在你確認後寫入 stockTrades / cashMovements。Positions、duplicate、ignored、warning、error rows 仍然只作 preview，不會匯入。</p>
      </div>

      <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-4 text-sm text-emerald-700">
        Phase 3C confirmed import writes stock trade and cash movement rows only. Positions, duplicate, ignored, warning, and error rows stay preview-only and are skipped.
      </div>

      {isConfirmOpen && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-800">Confirm Firstrade Import</h3>
              <button type="button" onClick={() => setIsConfirmOpen(false)} className="text-slate-400 hover:text-slate-600"><XCircle size={20} /></button>
            </div>
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                <div className="bg-slate-50 border rounded-lg p-3"><p className="text-xs text-slate-500">Stock Trades</p><p className="font-bold">{confirmPlan?.summary?.stockTradeRows ?? 0}</p></div>
                <div className="bg-slate-50 border rounded-lg p-3"><p className="text-xs text-slate-500">Cash Movements</p><p className="font-bold">{confirmPlan?.summary?.cashMovementRows ?? 0}</p></div>
                <div className="bg-slate-50 border rounded-lg p-3"><p className="text-xs text-slate-500">Total Cash Impact</p><p className="font-bold">{(confirmPlan?.summary?.totalCashImpact ?? 0).toFixed(2)}</p></div>
                <div className="bg-slate-50 border rounded-lg p-3"><p className="text-xs text-slate-500">Duplicates Skipped</p><p className="font-bold">{confirmPlan?.summary?.skippedDuplicateRows ?? 0}</p></div>
                <div className="bg-slate-50 border rounded-lg p-3"><p className="text-xs text-slate-500">Ignored Skipped</p><p className="font-bold">{confirmPlan?.summary?.skippedIgnoredRows ?? 0}</p></div>
                <div className="bg-slate-50 border rounded-lg p-3"><p className="text-xs text-slate-500">Positions Skipped</p><p className="font-bold">{confirmPlan?.summary?.skippedPositionRows ?? 0}</p></div>
              </div>
              <label className="flex items-start gap-3 text-sm text-slate-700 bg-amber-50 border border-amber-100 rounded-lg p-3">
                <input type="checkbox" checked={confirmChecked} onChange={(event) => setConfirmChecked(event.target.checked)} className="mt-1" />
                <span>I reviewed the preview. Only OK + NEW stock trade / cash movement rows will be written. Error, warning, duplicate, ignored, and position rows will not be imported.</span>
              </label>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setIsConfirmOpen(false)} className="px-4 py-2 rounded-lg text-sm font-semibold bg-slate-100 hover:bg-slate-200">Cancel</button>
                <button type="button" onClick={handleConfirmImport} disabled={!confirmChecked || !confirmPlan?.summary?.importableRows || isImporting} className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 flex items-center gap-2">
                  {isImporting ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />} Confirm Import
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {selectedRow && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[85vh] overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-800">Row {selectedRow.rowNumber} Details</h3>
              <button type="button" onClick={() => setSelectedRow(null)} className="text-slate-400 hover:text-slate-600"><XCircle size={20} /></button>
            </div>
            <div className="p-4 overflow-y-auto max-h-[75vh] space-y-4">
              <div className="bg-slate-50 border rounded-lg p-3 text-sm">
                <p><span className="font-semibold">Fingerprint:</span> {selectedRow.fingerprint || '--'}</p>
                <p><span className="font-semibold">Duplicate:</span> {selectedRow.duplicateStatus}</p>
              </div>
              <JsonBlock title="Raw Row JSON" value={selectedRow.rawRow} />
              <JsonBlock title="Mapped Row JSON" value={selectedRow.mappedRow} />
              <JsonBlock title="Draft JSON" value={selectedRow.draft} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
