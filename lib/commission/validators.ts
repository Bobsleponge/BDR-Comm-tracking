import { z } from 'zod';

/**
 * Schema for validating BDR rep data
 */
export const bdrRepSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email address'),
  status: z.enum(['active', 'inactive']).default('active'),
});

/**
 * Schema for validating commission rules
 */
export const commissionRulesSchema = z.object({
  base_rate: z.number().min(0).max(1).optional(),
  quarterly_bonus_rate: z.number().min(0).max(1).optional(),
  renewal_rate: z.number().min(0).max(1).optional(),
  payout_months_default: z.number().int().positive().optional(),
  payout_delay_days: z.number().int().positive().optional(),
  tier_1_threshold: z.number().min(0).optional(),
  tier_1_rate: z.number().min(0).max(1).optional(),
  tier_2_rate: z.number().min(0).max(1).optional(),
  quarterly_target: z.number().min(0).optional(),
  clawback_days: z.number().int().positive().optional(),
});

/**
 * Schema for validating quarterly targets
 */
export const quarterlyTargetSchema = z.object({
  bdr_id: z.string().uuid(),
  quarter: z.string().regex(/^\d{4}-Q[1-4]$/),
  target_revenue: z.number().min(0),
});

/**
 * Schema for validating quarterly performance
 */
export const quarterlyPerformanceSchema = z.object({
  bdr_id: z.string().uuid(),
  quarter: z.string().regex(/^\d{4}-Q[1-4]$/),
  revenue_collected: z.number().min(0).optional(),
  achieved_percent: z.number().min(0).optional(),
  bonus_eligible: z.boolean().optional(),
});

/**
 * Schema for validating deal data
 */
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const dealSchema = z.object({
  bdr_id: z.preprocess(
    (val) => {
      if (val === '' || val === null || val === undefined) return undefined;
      const s = String(val);
      return uuidRegex.test(s) ? s : undefined;
    },
    z.string().uuid().optional()
  ),
  client_id: z.preprocess((val) => (val === '' ? null : val), z.string().uuid().nullable().optional()),
  client_name: z.string().min(1, 'Client name is required'),
  service_type: z.string().min(1).optional(), // Optional - service types are now at service level
  proposal_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format').optional(),
  close_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format').nullable().optional(),
  first_invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format').nullable().optional(),
  deal_value: z.number().min(0, 'Deal value must be positive'),
  original_deal_value: z.number().min(0).nullable().optional(),
  status: z.enum(['proposed', 'closed-won', 'closed-lost']).optional(),
  is_renewal: z.boolean().optional(),
  original_deal_id: z.preprocess((val) => (val === '' ? null : val), z.string().uuid().nullable().optional()),
  payout_months: z.number().int().positive().optional(),
});

/**
 * Schema for validating deal update (partial)
 */
export const dealUpdateSchema = dealSchema.partial();

/**
 * Schema for validating client data
 */
export const clientSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  company: z.string().nullable().optional(),
  email: z.string().email('Invalid email address').nullable().optional(),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

/**
 * Schema for validating client update (partial)
 */
export const clientUpdateSchema = clientSchema.partial();

/**
 * Schema for validating revenue event data
 */
export const revenueEventSchema = z.object({
  deal_id: z.string().uuid(),
  service_id: z.string().uuid().nullable().optional(),
  bdr_id: z.string().uuid(),
  amount_collected: z.number().min(0, 'Amount must be positive'),
  collection_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format'),
  billing_type: z.enum(['one_off', 'monthly', 'quarterly', 'renewal']),
  payment_stage: z.enum(['invoice', 'completion', 'renewal', 'scheduled']),
  commissionable: z.boolean().optional(),
});

/**
 * Schema for validating BDR rep status update
 */
export const bdrRepStatusSchema = z.object({
  status: z.enum(['active', 'inactive']),
  leave_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format').nullable().optional(),
  allow_trailing_commission: z.boolean().optional(),
  do_not_pay_future: z.boolean().optional(),
});

/**
 * Base schema for validating deal service data (without refines)
 */
const dealServiceBaseSchema = z.object({
  id: z.string().uuid().optional(),
  service_name: z.string().min(1, 'Service name is required'),
  service_type: z.string().min(1, 'Service type is required'),
  billing_type: z.enum(['one_off', 'mrr', 'deposit', 'quarterly']),
  unit_price: z.number().min(0, 'Unit price must be positive'),
  monthly_price: z.number().min(0).nullable().optional(),
  quarterly_price: z.number().min(0).nullable().optional(),
  quantity: z.number().int().positive().default(1),
  contract_months: z.number().int().positive().default(12),
  contract_quarters: z.number().int().positive().default(4),
  commission_rate: z.number().min(0).max(1).nullable().optional(),
  completion_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format').nullable().optional(),
  is_renewal: z.boolean().optional(),
  original_service_value: z.number().min(0).nullable().optional(),
});

/**
 * Schema for validating deal service data (with validation refines)
 */
export const dealServiceSchema = dealServiceBaseSchema.refine((data) => {
  // MRR requires monthly_price
  if (data.billing_type === 'mrr' && (!data.monthly_price || data.monthly_price <= 0)) {
    return false;
  }
  return true;
}, {
  message: 'Monthly price is required for MRR billing type',
  path: ['monthly_price'],
}).refine((data) => {
  // Quarterly requires quarterly_price
  if (data.billing_type === 'quarterly' && (!data.quarterly_price || data.quarterly_price <= 0)) {
    return false;
  }
  return true;
}, {
  message: 'Quarterly price is required for quarterly billing type',
  path: ['quarterly_price'],
});

/**
 * Schema for validating deal service update (partial)
 * Uses the base schema without refines since updates are partial
 */
export const dealServiceUpdateSchema = dealServiceBaseSchema.partial();
