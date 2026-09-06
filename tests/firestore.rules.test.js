import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  deleteField,
  deleteDoc,
  doc,
  getDoc,
  setDoc,
  updateDoc,
} from 'firebase/firestore';

const PROJECT_ID = 'demo-treasury-dashboard';
const RULES = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');

const makeTrade = (overrides = {}) => ({
  id: 'trade-1',
  cusip: '91282ABC1',
  type: 't-note',
  side: 'buy',
  tradeDate: '2026-01-15',
  maturityDate: '2031-01-15',
  faceValue: 10000,
  cleanPrice: 99.125,
  couponRate: 4.25,
  commission: 1.5,
  couponFrequency: 2,
  currentMarketPrice: 100.25,
  status: 'active',
  ...overrides,
});

describe('Firestore trade ledger rules', () => {
  let testEnvironment;

  beforeAll(async () => {
    testEnvironment = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: '127.0.0.1',
        port: 8080,
        rules: RULES,
      },
    });
  });

  beforeEach(async () => {
    await testEnvironment.clearFirestore();
  });

  afterAll(async () => {
    await testEnvironment.cleanup();
  });

  const tradeRef = (context, userId = 'alice', tradeId = 'trade-1') =>
    doc(context.firestore(), 'users', userId, 'trades', tradeId);

  it('allows an owner to create, read, value, soft-delete, and restore a valid trade', async () => {
    const alice = testEnvironment.authenticatedContext('alice');
    const reference = tradeRef(alice);

    await assertSucceeds(setDoc(reference, makeTrade()));
    await assertSucceeds(getDoc(reference));
    await assertSucceeds(updateDoc(reference, {
      fredEstimatedPrice: 98.875,
      fredEstimatedAt: '2026-09-03',
      fredPricingSignature: 't-note|2031-01-15|4.25|2',
    }));
    await assertSucceeds(updateDoc(reference, {
      deletedAt: '2026-09-06T04:00:00.000Z',
    }));
    await assertSucceeds(updateDoc(reference, {
      deletedAt: deleteField(),
    }));
  });

  it('denies unauthenticated and cross-account access', async () => {
    const alice = testEnvironment.authenticatedContext('alice');
    const bob = testEnvironment.authenticatedContext('bob');
    const anonymous = testEnvironment.unauthenticatedContext();

    await assertSucceeds(setDoc(tradeRef(alice), makeTrade()));
    await assertFails(getDoc(tradeRef(bob, 'alice')));
    await assertFails(setDoc(tradeRef(bob, 'alice'), makeTrade()));
    await assertFails(getDoc(tradeRef(anonymous)));
  });

  it('rejects unknown fields, mismatched IDs, malformed dates, and unsafe values', async () => {
    const alice = testEnvironment.authenticatedContext('alice');

    await assertFails(setDoc(tradeRef(alice), makeTrade({ unexpected: 'field' })));
    await assertFails(setDoc(tradeRef(alice), makeTrade({ id: 'another-id' })));
    await assertFails(setDoc(tradeRef(alice), makeTrade({ maturityDate: '2025-12-31' })));
    await assertFails(setDoc(tradeRef(alice), makeTrade({ faceValue: -1 })));
    await assertFails(setDoc(tradeRef(alice), makeTrade({ couponFrequency: 12 })));
  });

  it('requires complete and internally consistent closed-position data', async () => {
    const alice = testEnvironment.authenticatedContext('alice');
    const reference = tradeRef(alice);

    await assertFails(setDoc(reference, makeTrade({ status: 'closed' })));
    await assertSucceeds(setDoc(reference, makeTrade({
      status: 'closed',
      closeDate: '2026-09-05',
      closePrice: 101.25,
      closeCommission: 2,
    })));
    await assertFails(updateDoc(reference, { closeDate: '2032-01-01' }));
  });

  it('denies client-side hard deletion', async () => {
    const alice = testEnvironment.authenticatedContext('alice');
    const reference = tradeRef(alice);

    await assertSucceeds(setDoc(reference, makeTrade()));
    await assertFails(deleteDoc(reference));
  });

  it.each([1, 4, 12])('allows safe updates to legacy coupon frequency %i without changing its terms', async (couponFrequency) => {
    const alice = testEnvironment.authenticatedContext('alice');
    const reference = tradeRef(alice);
    const legacyTrade = makeTrade({ couponFrequency });

    await testEnvironment.withSecurityRulesDisabled(async (context) => {
      await setDoc(tradeRef(context), legacyTrade);
    });
    await assertSucceeds(updateDoc(reference, { currentMarketPrice: 100.5 }));
    await assertSucceeds(updateDoc(reference, {
      deletedAt: '2026-09-06T04:00:00.000Z',
    }));
    await assertSucceeds(updateDoc(reference, { deletedAt: deleteField() }));
    await assertFails(updateDoc(reference, { couponRate: 5 }));
    await assertFails(updateDoc(reference, { couponFrequency: couponFrequency === 1 ? 4 : 1 }));
    await assertSucceeds(updateDoc(reference, { couponFrequency: 2 }));
  });

  it('preserves valid legacy TIPS records but prevents new TIPS creation', async () => {
    const alice = testEnvironment.authenticatedContext('alice');
    const reference = tradeRef(alice);
    const tipsTrade = makeTrade({ type: 'tips' });

    await assertFails(setDoc(reference, tipsTrade));
    await testEnvironment.withSecurityRulesDisabled(async (context) => {
      await setDoc(tradeRef(context), tipsTrade);
    });
    await assertSucceeds(updateDoc(reference, { currentMarketPrice: 100.5 }));
    await assertFails(updateDoc(reference, { type: 't-note' }));
  });
});
