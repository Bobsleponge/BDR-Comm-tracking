# API Documentation

This document describes all API endpoints available in the BDR Commission Tracking System.

## Authentication

All API endpoints require authentication. The system uses Supabase Auth with email/password.

## Base URL

- Development: `http://localhost:3000/api`
- Production: `https://your-domain.vercel.app/api`

## Endpoints

### Deals

#### GET /api/deals
Get list of deals.

**Query Parameters:**
- `bdr_id` (optional): Filter by BDR ID (admin only)
- `status` (optional): Filter by status (proposed, closed-won, closed-lost)

**Response:**
```json
[
  {
    "id": "uuid",
    "bdr_id": "uuid",
    "client_name": "string",
    "service_type": "string",
    "proposal_date": "YYYY-MM-DD",
    "close_date": "YYYY-MM-DD | null",
    "first_invoice_date": "YYYY-MM-DD | null",
    "deal_value": 10000.00,
    "status": "proposed | closed-won | closed-lost",
    "is_renewal": false,
    "payout_months": 12,
    "created_at": "timestamp"
  }
]
```

#### POST /api/deals
Create a new deal.

**Request Body:**
```json
{
  "bdr_id": "uuid",
  "client_name": "string",
  "service_type": "string",
  "proposal_date": "YYYY-MM-DD",
  "close_date": "YYYY-MM-DD | null",
  "first_invoice_date": "YYYY-MM-DD | null",
  "deal_value": 10000.00,
  "status": "proposed | closed-won | closed-lost",
  "is_renewal": false,
  "payout_months": 12
}
```

**Response:** Created deal object

#### PATCH /api/deals/[id]
Update a deal.

**Request Body:** Partial deal object

**Response:** Updated deal object

#### DELETE /api/deals/[id]
Delete a deal (admin only).

**Response:**
```json
{
  "success": true
}
```

#### POST /api/deals/[id]/cancel
Cancel a deal and future commission entries.

**Request Body:**
```json
{
  "cancellation_date": "YYYY-MM-DD"
}
```

**Response:** Updated deal object

### BDR Reps

#### GET /api/bdr-reps
Get list of BDR reps (all for admin, own profile for BDR).

**Response:**
```json
[
  {
    "id": "uuid",
    "name": "string",
    "email": "string",
    "status": "active | inactive",
    "created_at": "timestamp"
  }
]
```

#### POST /api/bdr-reps
Create a new BDR rep (admin only).

**Request Body:**
```json
{
  "name": "string",
  "email": "string",
  "status": "active | inactive"
}
```

**Response:** Created BDR rep object

#### PATCH /api/bdr-reps/[id]
Update a BDR rep (admin only).

**Request Body:** Partial BDR rep object

**Response:** Updated BDR rep object

#### PATCH /api/bdr-reps/[id]/status
Update BDR rep status and handle rep leave (admin only).

**Request Body:**
```json
{
  "status": "active | inactive",
  "do_not_pay_future": true
}
```

**Response:** Updated BDR rep object

### Commission

#### GET /api/commission/entries
Get commission entries.

**Query Parameters:**
- `bdr_id` (optional): Filter by BDR ID (admin only)
- `status` (optional): Filter by status (pending, paid, cancelled)
- `month` (optional): Filter by month (YYYY-MM-DD)

**Response:**
```json
[
  {
    "id": "uuid",
    "deal_id": "uuid",
    "bdr_id": "uuid",
    "month": "YYYY-MM-DD",
    "amount": 250.00,
    "status": "pending | paid | cancelled",
    "deals": {
      "client_name": "string",
      "service_type": "string"
    }
  }
]
```

#### PATCH /api/commission/entries/[id]/mark-paid
Mark commission entry as paid (admin only).

**Response:** Updated commission entry object

#### GET /api/commission/summary
Get commission summary totals.

**Query Parameters:**
- `bdr_id` (optional): Filter by BDR ID (admin only)

**Response:**
```json
{
  "earned": 5000.00,
  "pending": 3000.00,
  "cancelled": 500.00,
  "total": 8000.00
}
```

#### GET /api/commission/forecast
Get commission forecast for next N months.

**Query Parameters:**
- `bdr_id` (optional): Filter by BDR ID (admin only)
- `months` (optional): Number of months to forecast (default: 12)

**Response:**
```json
[
  {
    "month": "YYYY-MM-DD",
    "amount": 250.00
  }
]
```

### Quarterly Performance

#### GET /api/quarterly-performance
Get quarterly performance data.

**Query Parameters:**
- `bdr_id` (optional): Filter by BDR ID
- `quarter` (optional): Filter by quarter (YYYY-QN)

**Response:**
```json
[
  {
    "id": "uuid",
    "bdr_id": "uuid",
    "quarter": "2024-Q1",
    "revenue_collected": 50000.00,
    "achieved_percent": 125.00,
    "bonus_eligible": true,
    "bdr_reps": {
      "name": "string",
      "email": "string"
    },
    "quarterly_targets": {
      "target_revenue": 40000.00
    }
  }
]
```

#### POST /api/quarterly-performance
Enter or update quarterly revenue (admin only).

**Request Body:**
```json
{
  "bdr_id": "uuid",
  "quarter": "2024-Q1",
  "revenue_collected": 50000.00
}
```

**Response:** Updated quarterly performance object with calculated bonus

#### GET /api/quarterly-performance/[bdrId]/[quarter]
Get specific quarterly performance.

**Response:** Quarterly performance object

### Quarterly Targets

#### GET /api/quarterly-targets
Get quarterly targets.

**Query Parameters:**
- `bdr_id` (optional): Filter by BDR ID
- `quarter` (optional): Filter by quarter (YYYY-QN)

**Response:**
```json
[
  {
    "id": "uuid",
    "bdr_id": "uuid",
    "quarter": "2024-Q1",
    "target_revenue": 40000.00,
    "bdr_reps": {
      "name": "string",
      "email": "string"
    }
  }
]
```

#### POST /api/quarterly-targets
Set quarterly target (admin only).

**Request Body:**
```json
{
  "bdr_id": "uuid",
  "quarter": "2024-Q1",
  "target_revenue": 40000.00
}
```

**Response:** Created/updated quarterly target object

### Commission Rules

#### GET /api/rules
Get current commission rules.

**Response:**
```json
{
  "id": "uuid",
  "base_rate": 0.025,
  "quarterly_bonus_rate": 0.025,
  "renewal_rate": 0.01,
  "payout_months_default": 12,
  "updated_at": "timestamp"
}
```

#### PATCH /api/rules
Update commission rules (admin only).

**Request Body:**
```json
{
  "base_rate": 0.025,
  "quarterly_bonus_rate": 0.025,
  "renewal_rate": 0.01,
  "payout_months_default": 12
}
```

**Response:** Updated commission rules object

### Dashboard

#### GET /api/dashboard/stats
Get dashboard statistics.

**Query Parameters:**
- `bdr_id` (optional): Filter by BDR ID (admin only)

**Response:**
```json
{
  "closedDeals": 10,
  "commissionEarned": 5000.00,
  "commissionPending": 3000.00,
  "quarterlyProgress": {
    "revenueCollected": 50000.00,
    "achievedPercent": 125.00,
    "bonusEligible": true,
    "target": 40000.00
  },
  "nextMonthPayout": 500.00
}
```

#### GET /api/dashboard/top-reps
Get top performing reps (admin only).

**Query Parameters:**
- `limit` (optional): Number of reps to return (default: 10)

**Response:**
```json
[
  {
    "id": "uuid",
    "name": "string",
    "email": "string",
    "status": "active",
    "commissionEarned": 5000.00,
    "commissionPending": 3000.00,
    "totalCommission": 8000.00
  }
]
```

## Error Responses

All endpoints may return error responses in the following format:

```json
{
  "error": "Error message"
}
```

**Status Codes:**
- `200`: Success
- `201`: Created
- `400`: Bad Request (validation error)
- `401`: Unauthorized (not authenticated)
- `403`: Forbidden (insufficient permissions)
- `404`: Not Found
- `500`: Internal Server Error

## Authentication

Authentication is handled via Supabase Auth. Include the session cookie in requests (automatically handled by browser).

## Role-Based Access

- **Admin**: Can access all endpoints
- **BDR Rep**: Can only access their own data (filtered automatically)







