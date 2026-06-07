export const AI_MODE_LABELS = {
  total_assets: '整體資產',
  stock_portfolio: '股票組合',
  stock_single: '單一股票',
  cash: '現金',
  reconciliation: '對帳',
  treasury: '美債',
};

export const AI_MODE_FOCUS = {
  total_assets: '聚焦整體帳本資產、成本基礎、現金流、收益及對帳狀態。',
  stock_portfolio: '聚焦股票組合的成本、持倉集中度、已實現盈虧及交易現金流。',
  stock_single: '聚焦指定股票的持倉、平均成本、剩餘成本、已實現盈虧及交易紀錄摘要。',
  cash: '聚焦現金流水、入金、出金、股息、利息、費用及預扣稅。',
  reconciliation: '聚焦券商快照與系統帳本之間的現金、股數及成本差異。',
  treasury: '聚焦美債持倉、到期分布、YTM、票息及現金流。',
};

export const buildPortfolioAiSystemPrompt = () => [
  '你是一位審慎的投資組合帳本分析助理，使用繁體中文回答。',
  '你只可以分析使用者 App 已計算好的 deterministic data snapshot。',
  '不要重新計算核心財務數字；如需要描述數字，只能引用 snapshot 內已提供的數據。',
  '不要提供買入、賣出、持有、加倉、減倉、換馬或任何交易建議。',
  '不要提供目標價，不要預測股價、利率、匯率或未來回報。',
  '不要引用 snapshot 以外的市場資料、新聞、估值倍數或宏觀資料。',
  '不要把缺失資料當成 0；資料缺失時必須明確寫「資料不足」。',
  '不要自行發明數據；如 snapshot 未提供，請列入資料限制或待確認事項。',
  '股票報價功能目前已停用，因此股票分析只可以使用成本、持倉、已實現盈虧及現金流。',
].join('\n');

export const buildPortfolioAiUserPrompt = ({ snapshot, mode = 'total_assets' } = {}) => {
  const safeMode = AI_MODE_LABELS[mode] ? mode : 'total_assets';
  return [
    `分析模式：${AI_MODE_LABELS[safeMode]}`,
    `分析重點：${AI_MODE_FOCUS[safeMode]}`,
    '',
    '資料限制：',
    '目前股票報價功能已停用，因此本分析以成本、持倉及現金流為主，不包含即時市值及未實現盈虧。',
    '如果 snapshot 沒有某項資料，請寫「資料不足」，不要把缺失資料當成 0。',
    '',
    '請嚴格按照以下格式輸出：',
    '1. 數據摘要',
    '2. 主要觀察',
    '3. 集中度 / 風險',
    '4. 現金流 / 收益',
    '5. 對帳問題',
    '6. 資料限制',
    '7. 待確認事項',
    '',
    '禁止內容：買賣建議、目標價、股價預測、利率預測、外部市場資料或交易指令。',
    '',
    'Snapshot JSON:',
    JSON.stringify(snapshot || {}, null, 2),
  ].join('\n');
};

export const buildPortfolioAiMessages = ({ snapshot, mode = 'total_assets' } = {}) => [
  { role: 'system', content: buildPortfolioAiSystemPrompt() },
  { role: 'user', content: buildPortfolioAiUserPrompt({ snapshot, mode }) },
];
