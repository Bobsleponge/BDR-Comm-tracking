# Quarterly Commission (Closed Deals) – Investigation Report

**Date:** March 8, 2026  
**Quarter:** 2026-Q1

## Summary

The **Quarterly Commission (Closed Deals)** value on the dashboard is **correct**. The calculation uses the right rules and matches the actual commission entries in the system.

## Findings

### Dashboard calculation: **$3,940.92**

The dashboard uses this logic:
- **New deals:** Full commission on `commissionable_value` × rate
- **Renewals:** Commission on uplift only: `(commissionable_value - original_value) × rate`

### Cross-check 1: Commission entries

Sum of all `commission_entries` (accrued, payable, paid) for deals closed in Q1 2026:

```
$3,940.92
```

This matches the dashboard total and confirms the calculation is correct.

### Cross-check 2: `deal_services.commission_amount`

Sum of stored `deal_services.commission_amount` for Q1 closed deals:

```
$4,586.43
```

This is higher than the dashboard total by **$645.51**.

### Cause of the difference

Several renewal deals have **incorrectly stored** `commission_amount` in `deal_services`:

| Client                    | Dashboard (correct) | Stored (incorrect) | Difference |
|---------------------------|---------------------|--------------------|------------|
| Virginia B Andes          | $12.50              | $375.00            | $362.50    |
| Southern Cross (Bookkeeping) | $495.00          | $600.00            | $105.00    |
| Mad Martha               | $4.50               | $98.25             | $93.75     |
| Southern Cross (Tax)      | $3.38               | $67.75             | $64.38     |
| Victoria Suess            | $0.63               | $13.50             | $12.88     |
| American Battle Monuments| $0.25               | $7.13              | $6.88      |

For these deals, `deal_services` stores **full commission**, but they are renewal services and should use **uplift-only** commission. Example:

- **Virginia B Andes:** `commissionable_value` = $15,000, `original_service_value` = $14,500  
  - Correct uplift = $500 → commission = $12.50  
  - Stored value = $375 (15,000 × 2.5% = full commission)

### Why the stored values are wrong

Possible causes:
1. Renewal commission logic was added or updated after these services were created.
2. Services were marked renewal or had `original_service_value` updated after first save.
3. Import or migration that did not apply renewal logic.

The **service API** does apply renewal logic when saving (see `calculateRenewalCommission` in `app/api/deals/[id]/services/route.ts` and `[serviceId]/route.ts`). These services likely predate or bypass that logic.

## Conclusion

- **Dashboard:** ✅ Correct  
- **Commission entries:** ✅ Match dashboard  
- **`deal_services.commission_amount`:** ❌ Incorrect for some renewal deals (used full commission instead of uplift)

The dashboard recomputes commission from `commissionable_value`, `original_service_value`, and `is_renewal` and uses the right rules. It should be the source of truth.

## Recommendation

No change needed for the dashboard. If you want stored values to match:

1. Add a reconciliation script to recalculate and update `deal_services.commission_amount` for renewal services where it is wrong, or  
2. Treat the dashboard number as the authoritative value and keep using it for reporting.
