import { describe, expect, it } from 'vitest';
import { buildTradeBackup, markTradeDeleted, restoreDeletedTrade } from './tradeLifecycle.js';

describe('recoverable trade deletion', () => {
  it('marks a trade as deleted without discarding its ledger data', () => {
    const trade = { id: 'trade-1', cusip: '91282ABC1', faceValue: 1000 };
    expect(markTradeDeleted(trade, '2026-09-06T04:00:00Z')).toEqual({
      ...trade,
      deletedAt: '2026-09-06T04:00:00.000Z',
    });
  });

  it('restores the same trade by removing only the deletion marker', () => {
    const deletedTrade = {
      id: 'trade-1',
      cusip: '91282ABC1',
      faceValue: 1000,
      deletedAt: '2026-09-06T04:00:00.000Z',
    };
    expect(restoreDeletedTrade(deletedTrade)).toEqual({
      id: 'trade-1',
      cusip: '91282ABC1',
      faceValue: 1000,
    });
  });

  it('includes active and recycled trades in a backup', () => {
    const activeTrade = { id: 'active-1' };
    const deletedTrade = { id: 'deleted-1', deletedAt: '2026-09-06T04:00:00.000Z' };
    expect(buildTradeBackup([activeTrade], [deletedTrade])).toEqual([activeTrade, deletedTrade]);
    expect(buildTradeBackup([], [deletedTrade])).toEqual([deletedTrade]);
  });
});
