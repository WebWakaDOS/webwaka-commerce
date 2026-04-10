-- P09: Vendor personal identity fields (firstName, lastName, dob, whatsapp, description,
--       logo_url, businessNameForCac) stored as a single JSON blob.
-- Applied after 013_vendor_orders.sql

ALTER TABLE cmrc_vendors ADD COLUMN onboarding_data_json TEXT;
