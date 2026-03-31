-- P05 Task 5: Add pickupAddress column to vendors table
-- JSON: { name, phone, street, city, state, lga }
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS pickupAddress TEXT;
