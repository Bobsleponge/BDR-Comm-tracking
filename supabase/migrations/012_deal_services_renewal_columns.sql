-- Add is_renewal and original_service_value columns to deal_services for per-service renewal tracking
-- This allows marking specific services in a deal as renewals and entering the previous deal amount

ALTER TABLE deal_services 
ADD COLUMN IF NOT EXISTS is_renewal BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE deal_services 
ADD COLUMN IF NOT EXISTS original_service_value DECIMAL(12,2);

COMMENT ON COLUMN deal_services.is_renewal IS 'Whether this specific service is a renewal (vs new business)';
COMMENT ON COLUMN deal_services.original_service_value IS 'Previous deal amount for this service - commission is calculated on uplift (current - original)';
