-- Enable Row Level Security on all tables
ALTER TABLE bdr_reps ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE quarterly_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE quarterly_performance ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_pricing ENABLE ROW LEVEL SECURITY;

-- Helper function to check if user is admin
-- Note: This assumes you'll have a way to identify admins (e.g., via user metadata or a separate table)
-- For now, we'll create a simple function that can be extended
CREATE OR REPLACE FUNCTION is_admin(user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  -- This is a placeholder - you'll need to implement actual admin check
  -- For example, check user metadata or a separate admins table
  RETURN EXISTS (
    SELECT 1 FROM auth.users 
    WHERE id = user_id 
    AND raw_user_meta_data->>'role' = 'admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Helper function to get BDR ID from user email
CREATE OR REPLACE FUNCTION get_bdr_id_from_user(user_id UUID)
RETURNS UUID AS $$
BEGIN
  RETURN (
    SELECT id FROM bdr_reps 
    WHERE email = (SELECT email FROM auth.users WHERE id = user_id)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- bdr_reps policies
CREATE POLICY "Admins can view all reps"
  ON bdr_reps FOR SELECT
  USING (is_admin(auth.uid()));

CREATE POLICY "Admins can insert reps"
  ON bdr_reps FOR INSERT
  WITH CHECK (is_admin(auth.uid()));

CREATE POLICY "Admins can update reps"
  ON bdr_reps FOR UPDATE
  USING (is_admin(auth.uid()));

CREATE POLICY "Users can view their own rep record"
  ON bdr_reps FOR SELECT
  USING (email = (SELECT email FROM auth.users WHERE id = auth.uid()));

-- deals policies
CREATE POLICY "Admins can view all deals"
  ON deals FOR SELECT
  USING (is_admin(auth.uid()));

CREATE POLICY "BDRs can view their own deals"
  ON deals FOR SELECT
  USING (bdr_id = get_bdr_id_from_user(auth.uid()));

CREATE POLICY "Admins can insert deals"
  ON deals FOR INSERT
  WITH CHECK (is_admin(auth.uid()));

CREATE POLICY "BDRs can insert their own deals"
  ON deals FOR INSERT
  WITH CHECK (bdr_id = get_bdr_id_from_user(auth.uid()));

CREATE POLICY "Admins can update all deals"
  ON deals FOR UPDATE
  USING (is_admin(auth.uid()));

CREATE POLICY "BDRs can update their own deals"
  ON deals FOR UPDATE
  USING (bdr_id = get_bdr_id_from_user(auth.uid()));

CREATE POLICY "Admins can delete deals"
  ON deals FOR DELETE
  USING (is_admin(auth.uid()));

-- commission_entries policies
CREATE POLICY "Admins can view all commission entries"
  ON commission_entries FOR SELECT
  USING (is_admin(auth.uid()));

CREATE POLICY "BDRs can view their own commission entries"
  ON commission_entries FOR SELECT
  USING (bdr_id = get_bdr_id_from_user(auth.uid()));

CREATE POLICY "Admins can insert commission entries"
  ON commission_entries FOR INSERT
  WITH CHECK (is_admin(auth.uid()));

CREATE POLICY "Admins can update commission entries"
  ON commission_entries FOR UPDATE
  USING (is_admin(auth.uid()));

-- commission_rules policies
CREATE POLICY "Authenticated users can view commission rules"
  ON commission_rules FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can update commission rules"
  ON commission_rules FOR UPDATE
  USING (is_admin(auth.uid()));

CREATE POLICY "Admins can insert commission rules"
  ON commission_rules FOR INSERT
  WITH CHECK (is_admin(auth.uid()));

-- quarterly_targets policies
CREATE POLICY "Admins can view all quarterly targets"
  ON quarterly_targets FOR SELECT
  USING (is_admin(auth.uid()));

CREATE POLICY "BDRs can view their own quarterly targets"
  ON quarterly_targets FOR SELECT
  USING (bdr_id = get_bdr_id_from_user(auth.uid()));

CREATE POLICY "Admins can manage quarterly targets"
  ON quarterly_targets FOR ALL
  USING (is_admin(auth.uid()));

-- quarterly_performance policies
CREATE POLICY "Admins can view all quarterly performance"
  ON quarterly_performance FOR SELECT
  USING (is_admin(auth.uid()));

CREATE POLICY "BDRs can view their own quarterly performance"
  ON quarterly_performance FOR SELECT
  USING (bdr_id = get_bdr_id_from_user(auth.uid()));

CREATE POLICY "Admins can manage quarterly performance"
  ON quarterly_performance FOR ALL
  USING (is_admin(auth.uid()));

-- service_pricing policies
CREATE POLICY "Authenticated users can view service pricing"
  ON service_pricing FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admins can manage service pricing"
  ON service_pricing FOR ALL
  USING (is_admin(auth.uid()));







