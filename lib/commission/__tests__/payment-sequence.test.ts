import { describe, it, expect } from 'vitest';
import {
  buildPaymentSequenceIndexForService,
  formatPaymentSequenceLabel,
  getExpectedPaymentCount,
} from '@/lib/commission/payment-sequence';

describe('getExpectedPaymentCount', () => {
  it('returns 2 for deposit with completion date', () => {
    expect(getExpectedPaymentCount({ billing_type: 'deposit', completion_date: '2025-06-01' })).toBe(2);
  });

  it('returns 1 for deposit without completion', () => {
    expect(getExpectedPaymentCount({ billing_type: 'deposit' })).toBe(1);
  });

  it('returns contract months for MRR', () => {
    expect(getExpectedPaymentCount({ billing_type: 'mrr', contract_months: 12 })).toBe(12);
  });

  it('returns 1 for renewal regardless of billing type', () => {
    expect(
      getExpectedPaymentCount({ billing_type: 'mrr', contract_months: 12, is_renewal: true })
    ).toBe(1);
  });
});

describe('buildPaymentSequenceIndexForService', () => {
  it('labels monthly payments in collection order', () => {
    const events = [
      { id: 'a', collection_date: '2025-01-01', payment_stage: 'invoice' },
      { id: 'b', collection_date: '2025-02-01', payment_stage: 'scheduled' },
      { id: 'c', collection_date: '2025-03-01', payment_stage: 'scheduled' },
    ];
    const index = buildPaymentSequenceIndexForService(
      { billing_type: 'mrr', contract_months: 12 },
      events
    );
    expect(index.get('a')?.label).toBe('1 of 12');
    expect(index.get('b')?.label).toBe('2 of 12');
    expect(index.get('c')?.label).toBe('3 of 12');
  });

  it('orders deposit completion after invoice', () => {
    const events = [
      { id: 'second', collection_date: '2025-06-01', payment_stage: 'completion' },
      { id: 'first', collection_date: '2025-01-01', payment_stage: 'invoice' },
    ];
    const index = buildPaymentSequenceIndexForService(
      { billing_type: 'deposit', completion_date: '2025-06-01' },
      events
    );
    expect(index.get('first')?.label).toBe('1 of 2');
    expect(index.get('second')?.label).toBe('2 of 2');
  });
});

describe('formatPaymentSequenceLabel', () => {
  it('formats multi-payment labels', () => {
    expect(formatPaymentSequenceLabel(3, 12)).toBe('3 of 12');
  });
});
