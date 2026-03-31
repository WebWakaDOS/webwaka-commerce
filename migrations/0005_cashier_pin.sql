-- P06 Task 1: Cashier PIN for POS staff
-- Creates staff table (if not exists) with PIN security columns.
-- ALTER TABLE statements handle existing deployments that already have a staff table.

CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'CASHIER',
  manager_phone TEXT,
  cashierPinHash TEXT,
  cashierPinSalt TEXT,
  pinLockedUntil TEXT,
  pinFailedAttempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_staff_tenant ON staff(tenant_id, id);

-- For existing deployments: add PIN columns if the table already exists without them
ALTER TABLE staff ADD COLUMN IF NOT EXISTS manager_phone TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS cashierPinHash TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS cashierPinSalt TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS pinLockedUntil TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS pinFailedAttempts INTEGER NOT NULL DEFAULT 0;
