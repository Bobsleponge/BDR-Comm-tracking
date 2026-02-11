-- Add service_type column to deal_services table
-- This allows each service to have its own type, rather than having a single type at the deal level
ALTER TABLE deal_services 
ADD COLUMN IF NOT EXISTS service_type TEXT NOT NULL DEFAULT '';

-- Update existing records to use a default value if needed
-- This migration assumes existing services might not have a service_type
-- You may want to backfill this from the deal.service_type if needed
UPDATE deal_services 
SET service_type = 'Service' 
WHERE service_type = '' OR service_type IS NULL;

-- Add comment explaining the column
COMMENT ON COLUMN deal_services.service_type IS 'Type of service (e.g., 990, 1120, etc.) - each service can have its own type';

