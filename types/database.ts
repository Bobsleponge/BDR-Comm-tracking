/**
 * Database type definitions
 * These types match the database schema
 */

export interface Database {
  public: {
    Tables: {
      bdr_reps: {
        Row: {
          id: string;
          name: string;
          email: string;
          status: 'active' | 'inactive';
          allow_trailing_commission: boolean;
          leave_date: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          email: string;
          status?: 'active' | 'inactive';
          allow_trailing_commission?: boolean;
          leave_date?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          email?: string;
          status?: 'active' | 'inactive';
          allow_trailing_commission?: boolean;
          leave_date?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      deals: {
        Row: {
          id: string;
          bdr_id: string;
          client_id: string | null;
          client_name: string;
          service_type: string;
          proposal_date: string;
          close_date: string | null;
          first_invoice_date: string | null;
          deal_value: number;
          original_deal_value: number | null;
          status: 'proposed' | 'closed-won' | 'closed-lost';
          is_renewal: boolean;
          original_deal_id: string | null;
          cancellation_date: string | null;
          payout_months: number;
          do_not_pay_future: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          bdr_id: string;
          client_id?: string | null;
          client_name: string;
          service_type: string;
          proposal_date: string;
          close_date?: string | null;
          first_invoice_date?: string | null;
          deal_value: number;
          original_deal_value?: number | null;
          status?: 'proposed' | 'closed-won' | 'closed-lost';
          is_renewal?: boolean;
          original_deal_id?: string | null;
          cancellation_date?: string | null;
          payout_months?: number;
          do_not_pay_future?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<{
          bdr_id: string;
          client_id: string | null;
          client_name: string;
          service_type: string;
          proposal_date: string;
          close_date: string | null;
          first_invoice_date: string | null;
          deal_value: number;
          original_deal_value: number | null;
          status: 'proposed' | 'closed-won' | 'closed-lost';
          is_renewal: boolean;
          original_deal_id: string | null;
          cancellation_date: string | null;
          payout_months: number;
          do_not_pay_future: boolean;
          created_at: string;
          updated_at: string;
        }>;
      };
      commission_entries: {
        Row: {
          id: string;
          deal_id: string;
          bdr_id: string;
          revenue_event_id: string | null;
          month: string;
          accrual_date: string | null;
          payable_date: string | null;
          amount: number;
          status: 'accrued' | 'pending' | 'payable' | 'paid' | 'cancelled';
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          deal_id: string;
          bdr_id: string;
          revenue_event_id?: string | null;
          month: string;
          accrual_date?: string | null;
          payable_date?: string | null;
          amount: number;
          status?: 'accrued' | 'pending' | 'payable' | 'paid' | 'cancelled';
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<{
          deal_id: string;
          bdr_id: string;
          revenue_event_id: string | null;
          month: string;
          accrual_date: string | null;
          payable_date: string | null;
          amount: number;
          status: 'accrued' | 'pending' | 'payable' | 'paid' | 'cancelled';
          created_at: string;
          updated_at: string;
        }>;
      };
      deal_services: {
        Row: {
          id: string;
          deal_id: string;
          service_name: string;
          service_type: string;
          billing_type: 'one_off' | 'mrr' | 'deposit' | 'quarterly';
          unit_price: number;
          monthly_price: number | null;
          quarterly_price: number | null;
          quantity: number;
          contract_months: number;
          contract_quarters: number;
          commission_rate: number | null;
          commissionable_value: number;
          commission_amount: number;
          completion_date: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          deal_id: string;
          service_name: string;
          service_type: string;
          billing_type: 'one_off' | 'mrr' | 'deposit' | 'quarterly';
          unit_price: number;
          monthly_price?: number | null;
          quarterly_price?: number | null;
          quantity?: number;
          contract_months?: number;
          contract_quarters?: number;
          commission_rate?: number | null;
          commissionable_value: number;
          commission_amount: number;
          completion_date?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<{
          deal_id: string;
          service_name: string;
          service_type: string;
          billing_type: 'one_off' | 'mrr' | 'deposit' | 'quarterly';
          unit_price: number;
          monthly_price: number | null;
          quarterly_price: number | null;
          quantity: number;
          contract_months: number;
          contract_quarters: number;
          commission_rate: number | null;
          commissionable_value: number;
          commission_amount: number;
          completion_date: string | null;
          created_at: string;
          updated_at: string;
        }>;
      };
      commission_rules: {
        Row: {
          id: string;
          base_rate: number;
          quarterly_bonus_rate: number;
          renewal_rate: number;
          payout_months_default: number;
          payout_delay_days: number;
          tier_1_threshold: number | null;
          tier_1_rate: number | null;
          tier_2_rate: number | null;
          quarterly_target: number | null;
          clawback_days: number | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          id?: string;
          base_rate?: number;
          quarterly_bonus_rate?: number;
          renewal_rate?: number;
          payout_months_default?: number;
          payout_delay_days?: number;
          tier_1_threshold?: number | null;
          tier_1_rate?: number | null;
          tier_2_rate?: number | null;
          quarterly_target?: number | null;
          clawback_days?: number | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: Partial<{
          base_rate: number;
          quarterly_bonus_rate: number;
          renewal_rate: number;
          payout_months_default: number;
          payout_delay_days: number;
          tier_1_threshold: number | null;
          tier_1_rate: number | null;
          tier_2_rate: number | null;
          quarterly_target: number | null;
          clawback_days: number | null;
          updated_at: string;
          updated_by: string | null;
        }>;
      };
      clients: {
        Row: {
          id: string;
          name: string;
          company: string | null;
          email: string | null;
          phone: string | null;
          address: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          company?: string | null;
          email?: string | null;
          phone?: string | null;
          address?: string | null;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<{
          name: string;
          company: string | null;
          email: string | null;
          phone: string | null;
          address: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        }>;
      };
      quarterly_targets: {
        Row: {
          id: string;
          bdr_id: string;
          quarter: string;
          target_revenue: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          bdr_id: string;
          quarter: string;
          target_revenue: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<{
          bdr_id: string;
          quarter: string;
          target_revenue: number;
          created_at: string;
          updated_at: string;
        }>;
      };
      quarterly_performance: {
        Row: {
          id: string;
          bdr_id: string;
          quarter: string;
          revenue_collected: number;
          achieved_percent: number;
          bonus_eligible: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          bdr_id: string;
          quarter: string;
          revenue_collected?: number;
          achieved_percent?: number;
          bonus_eligible?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<{
          bdr_id: string;
          quarter: string;
          revenue_collected: number;
          achieved_percent: number;
          bonus_eligible: boolean;
          created_at: string;
          updated_at: string;
        }>;
      };
      revenue_events: {
        Row: {
          id: string;
          deal_id: string;
          service_id: string | null;
          bdr_id: string;
          amount_collected: number;
          collection_date: string;
          billing_type: 'one_off' | 'monthly' | 'quarterly' | 'renewal';
          payment_stage: 'invoice' | 'completion' | 'renewal' | 'scheduled';
          commissionable: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          deal_id: string;
          service_id?: string | null;
          bdr_id: string;
          amount_collected: number;
          collection_date: string;
          billing_type: 'one_off' | 'monthly' | 'quarterly' | 'renewal';
          payment_stage: 'invoice' | 'completion' | 'renewal' | 'scheduled';
          commissionable?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<{
          deal_id: string;
          service_id: string | null;
          bdr_id: string;
          amount_collected: number;
          collection_date: string;
          billing_type: 'one_off' | 'monthly' | 'quarterly' | 'renewal';
          payment_stage: 'invoice' | 'completion' | 'renewal' | 'scheduled';
          commissionable: boolean;
          created_at: string;
          updated_at: string;
        }>;
      };
    };
  };
}
