export const markTradeDeleted = (trade, deletedAt = new Date()) => {
  if (!trade?.id) throw new Error('交易缺少識別碼');
  const timestamp = deletedAt instanceof Date ? deletedAt : new Date(deletedAt);
  if (Number.isNaN(timestamp.getTime())) throw new Error('刪除時間無效');
  return { ...trade, deletedAt: timestamp.toISOString() };
};

export const restoreDeletedTrade = (trade) => {
  if (!trade?.id) throw new Error('交易缺少識別碼');
  const restoredTrade = { ...trade };
  delete restoredTrade.deletedAt;
  return restoredTrade;
};
