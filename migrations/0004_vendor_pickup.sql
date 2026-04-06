-- P05 Task 5: Add pickupAddress column to cmrc_vendors table
-- JSON: { name, phone, street, city, state, lga }
ALTER TABLE cmrc_vendors ADD COLUMN IF NOT EXISTS pickupAddress TEXT;
