import { addMonths, startOfMonth, format } from 'date-fns';
import type { Database } from '@/types/database';

type CommissionEntry = Database['public']['Tables']['commission_entries']['Insert'];
type Deal = Database['public']['Tables']['deals']['Row'];
type CommissionRules = Database['public']['Tables']['commission_rules']['Row'];

/**
 * Calculate base commission for a deal
 * @param dealValue - The total value of the deal
 * @param baseRate - The base commission rate (e.g., 0.025 for 2.5%)
 * @returns The total commission amount
 */
export function calculateBaseCommission(
  dealValue: number,
  baseRate: number
): number {
  return dealValue * baseRate;
}

/**
 * @deprecated This function is deprecated and will be removed in a future version.
 * 
 * **Migration Guide:**
 * - Old: Commission was calculated upfront based on deal value and spread over months
 * - New: Commission is calculated when revenue is actually collected (revenue events system)
 * 
 * **Replacement:**
 * Use `createRevenueEventsForDeal()` from `@/lib/commission/revenue-events` instead.
 * This creates revenue events based on actual billing cycles, and commission entries
 * are created when revenue is collected.
 * 
 * **Why deprecated:**
 * The old system calculated commission based on contract value, which doesn't match
 * actual revenue collection. The new system ensures commission is only earned when
 * revenue is actually received.
 * 
 * Generate monthly payout schedule for a deal
 * @param dealId - The deal ID
 * @param bdrId - The BDR rep ID
 * @param totalCommission - Total commission to be paid
 * @param payoutMonths - Number of months to spread the commission
 * @param startDate - First invoice date (start of payouts)
 * @returns Array of commission entries
 */
export function generatePayoutSchedule(
  dealId: string,
  bdrId: string,
  totalCommission: number,
  payoutMonths: number,
  startDate: Date
): CommissionEntry[] {
  console.warn('generatePayoutSchedule is deprecated. Use revenue events system instead.');
  const monthlyAmount = totalCommission / payoutMonths;
  const entries: CommissionEntry[] = [];
  const startMonth = startOfMonth(startDate);

  for (let i = 0; i < payoutMonths; i++) {
    const monthDate = addMonths(startMonth, i);
    entries.push({
      deal_id: dealId,
      bdr_id: bdrId,
      month: format(monthDate, 'yyyy-MM-dd'),
      amount: Number(monthlyAmount.toFixed(2)),
      status: 'pending',
    });
  }

  return entries;
}

/**
 * Calculate quarterly bonus commission
 * Revenue is now derived from revenue_events.amount_collected in the quarter.
 * @param revenueCollected - Total revenue collected in the quarter (from revenue_events)
 * @param quarterlyTarget - Target revenue for the quarter
 * @param bonusRate - Bonus commission rate (e.g., 0.025 for 2.5%)
 * @returns Object with eligibility status and bonus amount
 */
export function calculateQuarterlyBonus(
  revenueCollected: number,
  quarterlyTarget: number,
  bonusRate: number
): { eligible: boolean; bonusAmount: number } {
  const achievedPercent = quarterlyTarget > 0 
    ? (revenueCollected / quarterlyTarget) * 100 
    : 0;
  
  const eligible = achievedPercent >= 100;
  const bonusAmount = eligible ? revenueCollected * bonusRate : 0;

  return {
    eligible,
    bonusAmount: Number(bonusAmount.toFixed(2)),
  };
}

/**
 * Get quarter string from date (e.g., "2024-Q1")
 * @param date - Date to get quarter for
 * @returns Quarter string in format "YYYY-QN"
 */
export function getQuarterFromDate(date: Date): string {
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // 1-12
  const quarter = Math.ceil(month / 3);
  return `${year}-Q${quarter}`;
}

/**
 * Parse quarter string to get start and end dates
 * @param quarter - Quarter string (e.g., "2024-Q1")
 * @returns Object with start and end dates
 */
export function parseQuarter(quarter: string): { start: Date; end: Date } {
  const [year, q] = quarter.split('-Q');
  const quarterNum = parseInt(q, 10);
  const startMonth = (quarterNum - 1) * 3;
  const start = new Date(parseInt(year, 10), startMonth, 1);
  const end = new Date(parseInt(year, 10), startMonth + 3, 0, 23, 59, 59, 999);
  return { start, end };
}

/**
 * Calculate commission for a deal with service-specific rates
 * @param dealValue - Deal value
 * @param baseRate - Default base rate
 * @param serviceRate - Service-specific rate (optional)
 * @returns Commission amount
 */
export function calculateDealCommission(
  dealValue: number,
  baseRate: number,
  serviceRate?: number | null
): number {
  const rate = serviceRate ?? baseRate;
  return calculateBaseCommission(dealValue, rate);
}

/**
 * @deprecated This function is deprecated. Commission is now calculated on actual revenue collection events.
 * Calculate commissionable value for a service based on billing type
 * This is kept for display/estimation purposes only - actual commission is calculated from revenue events.
 * @param billingType - The billing type: 'one_off', 'mrr', 'deposit', or 'quarterly'
 * @param unitPrice - Unit price for the service
 * @param monthlyPrice - Monthly price (required for MRR)
 * @param quarterlyPrice - Quarterly price (required for quarterly)
 * @param quantity - Quantity of units
 * @param contractMonths - Contract months (default 12 for MRR)
 * @param contractQuarters - Contract quarters (default 4 for quarterly)
 * @returns Commissionable value (for display only)
 */
export function calculateServiceCommissionableValue(
  billingType: 'one_off' | 'mrr' | 'deposit' | 'quarterly',
  unitPrice: number,
  monthlyPrice: number | null,
  quarterlyPrice: number | null,
  quantity: number = 1,
  contractMonths: number = 12,
  contractQuarters: number = 4
): number {
  if (billingType === 'one_off') {
    return unitPrice * quantity;
  }
  
  if (billingType === 'mrr') {
    if (monthlyPrice === null || monthlyPrice === undefined) {
      throw new Error('Monthly price is required for MRR billing type');
    }
    return monthlyPrice * contractMonths * quantity;
  }
  
  if (billingType === 'quarterly') {
    if (quarterlyPrice === null || quarterlyPrice === undefined) {
      throw new Error('Quarterly price is required for quarterly billing type');
    }
    return quarterlyPrice * contractQuarters * quantity;
  }
  
  if (billingType === 'deposit') {
    // Same calculation as one_off, but timing differs
    return unitPrice * quantity;
  }
  
  throw new Error(`Unknown billing type: ${billingType}`);
}

/**
 * Calculate commission for a single service
 * @param billingType - The billing type: 'one_off', 'mrr', 'deposit', or 'quarterly'
 * @param unitPrice - Unit price for the service
 * @param monthlyPrice - Monthly price (required for MRR)
 * @param quarterlyPrice - Quarterly price (required for quarterly)
 * @param quantity - Quantity of units
 * @param contractMonths - Contract months (default 12 for MRR)
 * @param contractQuarters - Contract quarters (default 4 for quarterly)
 * @param commissionRate - Commission rate (optional, will use baseRate if not provided)
 * @param baseRate - Base commission rate (used if commissionRate is not provided)
 * @returns Object with commissionable_value and commission_amount
 */
export function calculateServiceCommission(
  billingType: 'one_off' | 'mrr' | 'deposit' | 'quarterly',
  unitPrice: number,
  monthlyPrice: number | null,
  quarterlyPrice: number | null,
  quantity: number = 1,
  contractMonths: number = 12,
  contractQuarters: number = 4,
  commissionRate: number | null | undefined,
  baseRate: number
): { commissionable_value: number; commission_amount: number } {
  const commissionableValue = calculateServiceCommissionableValue(
    billingType,
    unitPrice,
    monthlyPrice,
    quarterlyPrice,
    quantity,
    contractMonths,
    contractQuarters
  );
  
  const rate = commissionRate ?? baseRate;
  const commissionAmount = commissionableValue * rate;
  
  return {
    commissionable_value: Number(commissionableValue.toFixed(2)),
    commission_amount: Number(commissionAmount.toFixed(2)),
  };
}

/**
 * Calculate total commission for a deal from multiple services
 * @param services - Array of service objects with commission amounts
 * @returns Total commission amount
 */
export function calculateDealTotalCommission(
  services: Array<{ commission_amount: number }>
): number {
  return services.reduce((total, service) => total + service.commission_amount, 0);
}

/**
 * Calculate tiered commission based on cumulative revenue collected
 * Uses tiered structure: first threshold at tier_1_rate, above threshold at tier_2_rate
 * @param revenueAmount - Revenue amount for this transaction
 * @param cumulativeRevenueBefore - Cumulative revenue collected before this transaction
 * @param tier1Threshold - Threshold for tier 1 (e.g., 250000)
 * @param tier1Rate - Commission rate for tier 1 (e.g., 0.025 for 2.5%)
 * @param tier2Rate - Commission rate for tier 2 (e.g., 0.05 for 5%)
 * @returns Commission amount for this transaction
 */
export function calculateTieredCommission(
  revenueAmount: number,
  cumulativeRevenueBefore: number,
  tier1Threshold: number,
  tier1Rate: number,
  tier2Rate: number
): number {
  const cumulativeRevenueAfter = cumulativeRevenueBefore + revenueAmount;
  
  // If all revenue is below threshold
  if (cumulativeRevenueAfter <= tier1Threshold) {
    return revenueAmount * tier1Rate;
  }
  
  // If all revenue is above threshold
  if (cumulativeRevenueBefore >= tier1Threshold) {
    return revenueAmount * tier2Rate;
  }
  
  // Revenue crosses the threshold - split calculation
  const revenueInTier1 = tier1Threshold - cumulativeRevenueBefore;
  const revenueInTier2 = revenueAmount - revenueInTier1;
  
  const commissionTier1 = revenueInTier1 * tier1Rate;
  const commissionTier2 = revenueInTier2 * tier2Rate;
  
  return commissionTier1 + commissionTier2;
}

/**
 * Calculate renewal commission on uplift amount
 * Commission is 2.5% of the increase (renewal value - original value)
 * @param renewalValue - Total value of the renewal deal
 * @param originalValue - Total value of the original deal
 * @param renewalRate - Commission rate for renewals (default 0.025 for 2.5%)
 * @returns Commission amount based on uplift
 */
export function calculateRenewalCommission(
  renewalValue: number,
  originalValue: number,
  renewalRate: number = 0.025
): number {
  const uplift = renewalValue - originalValue;
  
  // If renewal is less than or equal to original, no commission
  if (uplift <= 0) {
    return 0;
  }
  
  // Commission is calculated on the uplift amount only
  return uplift * renewalRate;
}



