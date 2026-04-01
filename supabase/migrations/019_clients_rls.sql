-- Allow authenticated users to manage clients (deal form creates clients via API using user JWT)
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "clients_select_authenticated" ON clients;
DROP POLICY IF EXISTS "clients_insert_authenticated" ON clients;
DROP POLICY IF EXISTS "clients_update_authenticated" ON clients;

CREATE POLICY "clients_select_authenticated"
  ON clients FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "clients_insert_authenticated"
  ON clients FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "clients_update_authenticated"
  ON clients FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);
