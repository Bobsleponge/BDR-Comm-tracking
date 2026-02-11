-- Function to calculate quarterly performance
CREATE OR REPLACE FUNCTION calculate_quarterly_performance(
  p_bdr_id UUID,
  p_quarter TEXT
)
RETURNS void AS $$
DECLARE
  v_target DECIMAL(12,2);
  v_revenue DECIMAL(12,2);
  v_achieved_percent DECIMAL(5,2);
  v_bonus_eligible BOOLEAN;
BEGIN
  -- Get target for this quarter
  SELECT target_revenue INTO v_target
  FROM quarterly_targets
  WHERE bdr_id = p_bdr_id AND quarter = p_quarter;

  -- Get revenue collected (from quarterly_performance table)
  SELECT revenue_collected INTO v_revenue
  FROM quarterly_performance
  WHERE bdr_id = p_bdr_id AND quarter = p_quarter;

  -- Calculate achieved percent
  IF v_target > 0 THEN
    v_achieved_percent := (v_revenue / v_target) * 100;
  ELSE
    v_achieved_percent := 0;
  END IF;

  -- Determine bonus eligibility
  v_bonus_eligible := v_achieved_percent >= 100;

  -- Update quarterly_performance
  UPDATE quarterly_performance
  SET 
    achieved_percent = v_achieved_percent,
    bonus_eligible = v_bonus_eligible,
    updated_at = NOW()
  WHERE bdr_id = p_bdr_id AND quarter = p_quarter;

  -- If no record exists, create one
  IF NOT FOUND THEN
    INSERT INTO quarterly_performance (
      bdr_id,
      quarter,
      revenue_collected,
      achieved_percent,
      bonus_eligible
    ) VALUES (
      p_bdr_id,
      p_quarter,
      COALESCE(v_revenue, 0),
      v_achieved_percent,
      v_bonus_eligible
    );
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to generate commission entries for a deal
CREATE OR REPLACE FUNCTION generate_commission_entries(
  p_deal_id UUID
)
RETURNS void AS $$
DECLARE
  v_deal RECORD;
  v_commission_rules RECORD;
  v_service_pricing RECORD;
  v_base_rate DECIMAL(5,4);
  v_total_commission DECIMAL(12,2);
  v_monthly_amount DECIMAL(12,2);
  v_start_date DATE;
  v_month_date DATE;
  v_months_count INTEGER;
BEGIN
  -- Get deal information
  SELECT * INTO v_deal
  FROM deals
  WHERE id = p_deal_id;

  -- Only generate for closed-won deals
  IF v_deal.status != 'closed-won' OR v_deal.first_invoice_date IS NULL THEN
    RETURN;
  END IF;

  -- Get commission rules
  SELECT * INTO v_commission_rules
  FROM commission_rules
  ORDER BY updated_at DESC
  LIMIT 1;

  -- Get service-specific rate if exists
  SELECT * INTO v_service_pricing
  FROM service_pricing
  WHERE service_type = v_deal.service_type;

  -- Determine base rate
  IF v_service_pricing.commission_percent IS NOT NULL THEN
    v_base_rate := v_service_pricing.commission_percent;
  ELSE
    v_base_rate := v_commission_rules.base_rate;
  END IF;

  -- Calculate total commission
  v_total_commission := v_deal.deal_value * v_base_rate;

  -- Calculate monthly amount
  v_monthly_amount := v_total_commission / v_deal.payout_months;

  -- Start date is first invoice date
  v_start_date := v_deal.first_invoice_date;
  v_month_date := DATE_TRUNC('month', v_start_date)::DATE;
  v_months_count := 0;

  -- Generate entries for each month
  WHILE v_months_count < v_deal.payout_months LOOP
    -- Insert commission entry (using ON CONFLICT to avoid duplicates)
    INSERT INTO commission_entries (
      deal_id,
      bdr_id,
      month,
      amount,
      status
    ) VALUES (
      p_deal_id,
      v_deal.bdr_id,
      v_month_date,
      v_monthly_amount,
      'pending'
    )
    ON CONFLICT (deal_id, month) DO NOTHING;

    -- Move to next month
    v_month_date := v_month_date + INTERVAL '1 month';
    v_months_count := v_months_count + 1;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Trigger to generate commission entries when deal is closed-won
CREATE OR REPLACE FUNCTION trigger_generate_commission_entries()
RETURNS TRIGGER AS $$
BEGIN
  -- Only generate if status changed to closed-won
  IF NEW.status = 'closed-won' AND (OLD.status IS NULL OR OLD.status != 'closed-won') THEN
    PERFORM generate_commission_entries(NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER deal_closed_won_trigger
  AFTER INSERT OR UPDATE ON deals
  FOR EACH ROW
  WHEN (NEW.status = 'closed-won')
  EXECUTE FUNCTION trigger_generate_commission_entries();

-- Function to cancel future commission entries
CREATE OR REPLACE FUNCTION cancel_future_commission_entries(
  p_deal_id UUID,
  p_cancellation_date DATE
)
RETURNS void AS $$
BEGIN
  UPDATE commission_entries
  SET 
    status = 'cancelled',
    updated_at = NOW()
  WHERE deal_id = p_deal_id
    AND month >= DATE_TRUNC('month', p_cancellation_date)::DATE
    AND status = 'pending';
END;
$$ LANGUAGE plpgsql;







