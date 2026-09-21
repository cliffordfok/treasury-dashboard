import { describe, expect, it } from 'vitest';
import {
  buildTradeBackup,
  markTradeDeleted,
  normalizeTradeBackupEntry,
  restoreDeletedTrade,
} from './tradeLifecycle.js';

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

  it('round-trips recycled trades and legacy TIPS without changing their lifecycle state', () => {
    const tipsTrade = normalizeTradeBackupEntry({
      id: 'tips-1',
      cusip: '912810TIPS',
      type: 'tips',
      side: 'buy',
      tradeDate: '2024-01-15',
      maturityDate: '2034-01-15',
      faceValue: 1000,
      cleanPrice: 99,
      couponRate: 1.5,
      commission: 0,
      couponFrequency: 2,
      currentMarketPrice: 100,
      status: 'active',
      accruedInterestPer100: 0.5,
    });
    const deletedTrade = normalizeTradeBackupEntry({
      id: 'deleted-1',
      cusip: '91282ABC1',
      type: 't-note',
      side: 'buy',
      tradeDate: '2026-01-15',
      maturityDate: '2031-01-15',
      faceValue: 1000,
      cleanPrice: 99,
      couponRate: 4,
      commission: 0,
      couponFrequency: 2,
      currentMarketPrice: 100,
      status: 'active',
      deletedAt: '2026-09-06T04:00:00.000Z',
    });

    const serializedBackup = JSON.stringify(buildTradeBackup([tipsTrade], [deletedTrade]));
    const restoredTrades = JSON.parse(serializedBackup).map(normalizeTradeBackupEntry);

    expect(restoredTrades).toEqual([tipsTrade, deletedTrade]);
    expect(restoredTrades[1].deletedAt).toBe('2026-09-06T04:00:00.000Z');
  });

  it('rejects an invalid deletion marker instead of restoring it as an active trade', () => {
    expect(() => normalizeTradeBackupEntry({
      id: 'deleted-1',
      cusip: '91282ABC1',
      type: 't-note',
      side: 'buy',
      tradeDate: '2026-01-15',
      maturityDate: '2031-01-15',
      faceValue: 1000,
      cleanPrice: 99,
      couponRate: 4,
      commission: 0,
      couponFrequency: 2,
      currentMarketPrice: 100,
      status: 'active',
      deletedAt: 'not-a-timestamp',
    })).toThrow('deletedAt');
  });
});
