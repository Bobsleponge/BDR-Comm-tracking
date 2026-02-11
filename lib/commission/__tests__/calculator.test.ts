import { describe, it, expect } from 'vitest';
import {
  calculateBaseCommission,
  calculateQuarterlyBonus,
  calculateTieredCommission,
  calculateRenewalCommission,
  getQuarterFromDate,
  parseQuarter,
  calculateDealCommission,
} from '../calculator';

describe('Commission Calculator', () => {
  describe('calculateBaseCommission', () => {
    it('should calculate 2.5% commission correctly', () => {
      const result = calculateBaseCommission(10000, 0.025);
      expect(result).toBe(250);
    });

    it('should handle zero deal value', () => {
      const result = calculateBaseCommission(0, 0.025);
      expect(result).toBe(0);
    });

    it('should handle different commission rates', () => {
      const result = calculateBaseCommission(10000, 0.05);
      expect(result).toBe(500);
    });
  });

  describe('calculateQuarterlyBonus', () => {
    it('should calculate bonus when target is met', () => {
      const result = calculateQuarterlyBonus(50000, 40000, 0.025);
      expect(result.eligible).toBe(true);
      expect(result.bonusAmount).toBe(1250); // 50000 * 0.025
    });

    it('should not calculate bonus when target is not met', () => {
      const result = calculateQuarterlyBonus(30000, 40000, 0.025);
      expect(result.eligible).toBe(false);
      expect(result.bonusAmount).toBe(0);
    });

    it('should calculate bonus at exactly 100% target', () => {
      const result = calculateQuarterlyBonus(40000, 40000, 0.025);
      expect(result.eligible).toBe(true);
      expect(result.bonusAmount).toBe(1000);
    });

    it('should handle zero target', () => {
      const result = calculateQuarterlyBonus(10000, 0, 0.025);
      expect(result.eligible).toBe(false);
      expect(result.bonusAmount).toBe(0);
    });
  });

  describe('calculateTieredCommission', () => {
    it('should calculate commission below threshold', () => {
      const result = calculateTieredCommission(10000, 0, 250000, 0.025, 0.05);
      expect(result).toBe(250); // 10000 * 0.025
    });

    it('should calculate commission above threshold', () => {
      const result = calculateTieredCommission(10000, 250000, 250000, 0.025, 0.05);
      expect(result).toBe(500); // 10000 * 0.05
    });

    it('should split commission when crossing threshold', () => {
      // Revenue crosses from 240000 to 250000
      const result = calculateTieredCommission(20000, 240000, 250000, 0.025, 0.05);
      // 10000 at tier 1 (250000 - 240000) = 250
      // 10000 at tier 2 (20000 - 10000) = 500
      // Total = 750
      expect(result).toBe(750);
    });
  });

  describe('calculateRenewalCommission', () => {
    it('should calculate commission on uplift', () => {
      const result = calculateRenewalCommission(50000, 40000, 0.025);
      expect(result).toBe(250); // (50000 - 40000) * 0.025
    });

    it('should return zero when renewal is less than original', () => {
      const result = calculateRenewalCommission(30000, 40000, 0.025);
      expect(result).toBe(0);
    });

    it('should return zero when renewal equals original', () => {
      const result = calculateRenewalCommission(40000, 40000, 0.025);
      expect(result).toBe(0);
    });

    it('should use custom renewal rate', () => {
      const result = calculateRenewalCommission(50000, 40000, 0.01);
      expect(result).toBe(100); // (50000 - 40000) * 0.01
    });
  });

  describe('getQuarterFromDate', () => {
    it('should return correct quarter for Q1', () => {
      const date = new Date(2024, 0, 15); // January 15, 2024
      const result = getQuarterFromDate(date);
      expect(result).toBe('2024-Q1');
    });

    it('should return correct quarter for Q2', () => {
      const date = new Date(2024, 3, 15); // April 15, 2024
      const result = getQuarterFromDate(date);
      expect(result).toBe('2024-Q2');
    });

    it('should return correct quarter for Q4', () => {
      const date = new Date(2024, 11, 15); // December 15, 2024
      const result = getQuarterFromDate(date);
      expect(result).toBe('2024-Q4');
    });
  });

  describe('parseQuarter', () => {
    it('should parse Q1 correctly', () => {
      const result = parseQuarter('2024-Q1');
      expect(result.start.getFullYear()).toBe(2024);
      expect(result.start.getMonth()).toBe(0); // January
      expect(result.end.getMonth()).toBe(2); // March
    });

    it('should parse Q4 correctly', () => {
      const result = parseQuarter('2024-Q4');
      expect(result.start.getFullYear()).toBe(2024);
      expect(result.start.getMonth()).toBe(9); // October
      expect(result.end.getMonth()).toBe(11); // December
    });
  });

  describe('calculateDealCommission', () => {
    it('should use base rate when no service rate provided', () => {
      const result = calculateDealCommission(10000, 0.025, null);
      expect(result).toBe(250);
    });

    it('should use service rate when provided', () => {
      const result = calculateDealCommission(10000, 0.025, 0.03);
      expect(result).toBe(300);
    });

    it('should handle zero deal value', () => {
      const result = calculateDealCommission(0, 0.025, null);
      expect(result).toBe(0);
    });
  });
});

