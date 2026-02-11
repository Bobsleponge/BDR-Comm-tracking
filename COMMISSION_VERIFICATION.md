# Commission Verification & Investigation

## Deposit Services – 50/50 Split Logic

**Deposit services use a 50/50 split** – both halves are scheduled when the deal is created:

- **First 50%**: Collected on `close_date` → commission accrues on `first_invoice_date`
- **Second 50%**: Collected on `completion_date` (date selected in UI when creating the deal) → commission accrues on `completion_date`

**Both commission entries are created immediately** when the deal is processed – the second 50% is not delayed. Each entry is loaded into the month of its accrual date so the full commission schedule is visible from the start.

---

## Verification System

### Overview

A verification system checks that:
- **Expected commission** (from `deal_services.commission_amount`) matches  
- **Accrued commission** (commission entries for collected revenue) plus  
- **Pending commission** (future revenue events not yet processed)
- **Correct number of commission entries** per service (see table below)

### API

**GET** `/api/commission/verify`

Optional params:
- `bdr_id` – filter by BDR
- `deal_id` – filter by deal

### UI

Commission page → **Verification** tab.

For each deal/service it shows:
- Expected vs accrued vs pending
- Entry count (actual vs expected per billing type)
- Revenue events and whether they have commission entries
- Status: `ok`, `pending`, `mismatch`, `missing_entries`, `wrong_count`

### Expected Entry Counts by Billing Type

| Billing type | Expected entries |
|--------------|------------------|
| Deposit (with completion_date) | 2 (first 50% + second 50%) |
| Deposit (no completion_date) | 1 |
| One-off | 1 |
| MRR (monthly) | `contract_months` (default 12) |
| Quarterly | `contract_quarters` (default 4) |
| **Renewal** | **1** |

**Renewal exception:** Renewals are a one-time commission on the uplift amount (renewal value minus original value), due 7 days after close date. Exactly 1 commission entry is expected.

### Status Meanings

- **ok**: Expected = accrued, correct entry count, no pending
- **pending**: Accrued + pending = expected; correct count; future collection dates not yet processed
- **mismatch**: Expected ≠ accrued + pending (e.g. wrong rates, bad data)
- **missing_entries**: Past-due revenue (`collection_date ≤ today`) with no commission entry → **Run Reprocess**
- **wrong_count**: Actual commission entries ≠ expected for billing type → **Run Reprocess**

---

## Fixes Implemented

1. **Duplicate prevention**
   - `processRevenueEvent` skips if a commission entry already exists for that revenue event
   - `reprocess-all` clears existing revenue events and commission entries for each deal before recreating

2. **Verification tab**
   - Commission page Verification tab compares expected vs actual per deal/service

---

## When to Run Reprocess

Run **Reprocess Deals** when:
- New deals are closed
- Service dates (e.g. `completion_date`) change
- Time has passed and future revenue events should now be collected
- Verification shows `missing_entries` or `wrong_count`

Use the **Verification** tab to confirm expected commission matches accrued and pending amounts.
