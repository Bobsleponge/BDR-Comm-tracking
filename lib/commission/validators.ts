import { z } from 'zod';

/**
 * Helper to convert empty strings to null for optional UUID fields
 */
const optionalUuid = z.union([
  z.string().uuid('Invalid UUID format'),
  z.literal(''),
  z.null(),
  z.undefined()
]).transform((val) => (val === '' || val === undefined ? null : val));

/**
 * Helper to convert empty strings to null for optional date fields
 */
const optionalDate = z.union([
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format'),
  z.literal(''),
  z.null(),
  z.undefined()
]).transform((val) => (val === '' || val === undefined ? null : val));

/**
 * BDR ID validator - accepts UUID or simple string IDs (for local mode)
 * In local mode, BDR IDs can be simple strings like "admin-user-id"
 * In production (Supabase), BDR IDs should be UUIDs
 */
const bdrIdValidator = z.string().min(1, 'BDR ID is required');

/**
 * Validation schema for deal creation/update
 */
export const dealSchema = z.object({
  bdr_id: bdrIdValidator,
  client_id: optionalUuid,
  client_name: z.string().min(1, 'Client name is required'),
  service_type: z.string().min(1, 'Service type is required'),
  proposal_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format'),
  close_date: optionalDate,
  first_invoice_date: optionalDate,
  deal_value: z.number().positive('Deal value must be positive'),
  status: z.enum(['proposed', 'closed-won', 'closed-lost']),
  is_renewal: z.boolean().optional().default(false),
  original_deal_id: optionalUuid,
  original_deal_value: z.number().positive('Original deal value must be positive').nullable().optional(),
  payout_months: z.number().int().min(1).max(60).optional().default(12),
});

/**
 * Validation schema for BDR rep creation/update
 */
export const bdrRepSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email address'),
  status: z.enum(['active', 'inactive']).optional().default('active'),
});

/**
 * Validation schema for commission rules update
 */
export const commissionRulesSchema = z.object({
  base_rate: z.number().min(0).max(1, 'Rate must be between 0 and 1').optional(),
  quarterly_bonus_rate: z.number().min(0).max(1, 'Rate must be between 0 and 1').optional(),
  renewal_rate: z.number().min(0).max(1, 'Rate must be between 0 and 1').optional(),
  payout_months_default: z.number().int().min(1).max(60).optional(),
  tier_1_threshold: z.number().min(0, 'Tier 1 threshold must be positive').optional().nullable(),
  tier_1_rate: z.number().min(0).max(1, 'Rate must be between 0 and 1').optional().nullable(),
  tier_2_rate: z.number().min(0).max(1, 'Rate must be between 0 and 1').optional().nullable(),
  quarterly_target: z.number().min(0, 'Quarterly target must be positive').optional().nullable(),
  clawback_days: z.number().int().min(0, 'Clawback days must be non-negative').optional().nullable(),
});

/**
 * Validation schema for quarterly target
 */
export const quarterlyTargetSchema = z.object({
  bdr_id: bdrIdValidator,
  quarter: z.string().regex(/^\d{4}-Q[1-4]$/, 'Invalid quarter format (e.g., 2024-Q1)'),
  target_revenue: z.number().positive('Target revenue must be positive'),
});

/**
 * Validation schema for quarterly performance
 */
export const quarterlyPerformanceSchema = z.object({
  bdr_id: bdrIdValidator,
  quarter: z.string().regex(/^\d{4}-Q[1-4]$/, 'Invalid quarter format (e.g., 2024-Q1)'),
  revenue_collected: z.number().min(0, 'Revenue collected must be non-negative'),
});

/**
 * Validation schema for service pricing
 */
export const servicePricingSchema = z.object({
  service_type: z.string().min(1, 'Service type is required'),
  commission_percent: z.number().min(0).max(1, 'Rate must be between 0 and 1').nullable().optional(),
});

/**
 * Validation schema for a single deal service
 */
export const dealServiceSchema = z.object({
  id: z.string().uuid().optional(),
  service_name: z.string().min(1, 'Service name is required'),
  billing_type: z.enum(['one_off', 'mrr', 'deposit', 'quarterly'], {
    errorMap: () => ({ message: 'Billing type must be one_off, mrr, deposit, or quarterly' }),
  }),
  unit_price: z.number().min(0, 'Unit price must be non-negative').optional(), // Optional for MRR/quarterly, required for one_off/deposit
  monthly_price: z.number().positive('Monthly price must be positive').nullable().optional(),
  quarterly_price: z.number().positive('Quarterly price must be positive').nullable().optional(),
  quantity: z.number().int().positive('Quantity must be a positive integer').default(1),
  contract_months: z.number().int().min(1).max(120, 'Contract months must be between 1 and 120').default(12),
  contract_quarters: z.number().int().min(1).max(40, 'Contract quarters must be between 1 and 40').default(4),
  commission_rate: z.number().min(0).max(1, 'Commission rate must be between 0 and 1').nullable().optional(),
  commissionable_value: z.number().min(0).optional(), // Calculated, optional in input
  commission_amount: z.number().min(0).optional(), // Calculated, optional in input
  completion_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format').nullable().optional(),
}).refine(
  (data) => {
    // For one_off and deposit, unit_price is required and must be positive
    if (data.billing_type === 'one_off' || data.billing_type === 'deposit') {
      return data.unit_price !== undefined && data.unit_price !== null && data.unit_price > 0;
    }
    return true;
  },
  {
    message: 'Unit price is required and must be positive for one-off and deposit services',
    path: ['unit_price'],
  }
).refine(
  (data) => {
    // For MRR, monthly_price is required
    if (data.billing_type === 'mrr') {
      return data.monthly_price !== null && data.monthly_price !== undefined;
    }
    return true;
  },
  {
    message: 'Monthly price is required for MRR billing type',
    path: ['monthly_price'],
  }
).refine(
  (data) => {
    // For quarterly, quarterly_price is required
    if (data.billing_type === 'quarterly') {
      return data.quarterly_price !== null && data.quarterly_price !== undefined;
    }
    return true;
  },
  {
    message: 'Quarterly price is required for quarterly billing type',
    path: ['quarterly_price'],
  }
).refine(
  (data) => {
    // For deposit, completion_date is recommended but not strictly required
    // (we'll allow it to be set later)
    return true;
  }
);

/**
 * Validation schema for deal creation/update with services
 * Services array is optional for backward compatibility
 */
export const dealWithServicesSchema = dealSchema.extend({
  services: z.array(dealServiceSchema).optional(),
}).refine(
  (data) => {
    // If services are provided, at least one service is required
    if (data.services !== undefined && data.services.length === 0) {
      return false;
    }
    return true;
  },
  {
    message: 'If services are provided, at least one service is required',
    path: ['services'],
  }
);



