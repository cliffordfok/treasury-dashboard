export const AI_MODE_LABELS = {
  total_assets: '整體資產',
  stock_portfolio: '股票組合',
  stock_single: '單一股票',
  cash: '現金',
  treasury: '美債',
};

export const AI_MODE_FOCUS = {
  total_assets: '聚焦整體帳本資產、成本基礎、現金流、收益及資料限制。',
  stock_portfolio: '聚焦股票組合的成本、持倉集中度、已實現盈虧及現金影響。',
  stock_single: '聚焦單一股票的持倉、平均成本、剩餘成本、已實現盈虧及交易紀錄摘要。',
  cash: '聚焦現金流水、入金、出金、股息、利息、費用、預扣稅及異常大額變動。',
  treasury: '聚焦美債持倉、到期分布、YTM、票息、利息收入及現有美債指標。',
};

export const buildPortfolioAiSystemPrompt = () => [
  '你是一位謹慎的投資組合帳本分析助手，使用繁體中文回答。',
  '你只能使用 App 傳入的 deterministic data snapshot。',
  '你不可自行計算核心財務數字；如要引用數字，只能引用 snapshot 內已提供的數字。',
  '你不可提供買入、賣出、持有建議。',
  '你不可提供目標價。',
  '你不可預測股價、利率或回報。',
  '你不可引用 snapshot 以外的市場新聞、外部研究或即時市場資料。',
  '你不可把缺失資料當成 0；資料不足時必須明確寫「資料不足」。',
  '你不可幻想或補作資料；如果 snapshot 沒有某項資料，請直接說明限制。',
  'AI 分析目前不使用股票報價，因此股票分析只能基於成本、持倉、現金流及已實現盈虧。',
].join('\n');

export const buildPortfolioAiUserPrompt = ({ snapshot, mode = 'total_assets' } = {}) => {
  const safeMode = AI_MODE_LABELS[mode] ? mode : 'total_assets';
  return [
    `分析模式：${AI_MODE_LABELS[safeMode]}`,
    `分析焦點：${AI_MODE_FOCUS[safeMode]}`,
    '',
    '資料限制：',
    'AI 分析目前不使用股票報價，因此本分析以成本、持倉及現金流為主，不包含即時市值及未實現盈虧。',
    '如果 snapshot 沒有某項資料，請寫「資料不足」，不要把缺失資料當成 0。',
    '',
    '請用以下固定格式輸出：',
    '1. 數據摘要',
    '2. 主要觀察',
    '3. 集中度 / 風險',
    '4. 現金流 / 收益',
    '5. 資料限制',
    '6. 待確認事項',
    '',
    '請保持中性，不提供買入、賣出、持有建議、目標價、股價預測、利率預測或外部市場資訊。',
    '',
    'Snapshot JSON:',
    JSON.stringify(snapshot || {}, null, 2),
  ].join('\n');
};

export const buildPortfolioAiMessages = ({ snapshot, mode = 'total_assets' } = {}) => [
  { role: 'system', content: buildPortfolioAiSystemPrompt() },
  { role: 'user', content: buildPortfolioAiUserPrompt({ snapshot, mode }) },
];
