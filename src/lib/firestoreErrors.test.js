import { describe, expect, it } from 'vitest';
import { describeFirestoreError } from './firestoreErrors.js';

describe('Firestore error messages', () => {
  it('does not blame the network when security rules reject a write', () => {
    const message = describeFirestoreError({ code: 'permission-denied' });
    expect(message).toContain('安全規則');
    expect(message).not.toContain('網絡');
  });

  it('points connectivity failures at the network', () => {
    expect(describeFirestoreError({ code: 'unavailable' })).toContain('網絡');
  });

  it('falls back to a generic message for unknown errors', () => {
    expect(describeFirestoreError(new Error('boom'))).toBe('未能完成操作，請稍後重試。');
    expect(describeFirestoreError(undefined)).toBe('未能完成操作，請稍後重試。');
  });
});
