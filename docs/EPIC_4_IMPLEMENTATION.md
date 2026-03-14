# EPIC 4: Shared Commerce Foundation

## Context Review (WebWaka OS v4 Blueprint)

Before implementing, we must explicitly reference the authoritative architecture:

> **Part 10.2: Commerce & Retail Suite**
> * **Inventory Synchronization:** Event-driven multi-directional syncing. Optimistic concurrency control with version numbers.

> **Part 9.2: Universal Architecture Standards**
> - **Multi-Tenancy:** `tenantId` must exist on all new database models and be included in all queries. Resolved at the Edge (Layer 2).
> - **Monetary Values:** All monetary fields must be stored as integers (kobo/cents).
> - **Data Integrity:** Use soft deletes (`deletedAt`) instead of hard deletes for critical records.

> **Commerce Architecture Plan Clarification:**
> - A subscriber must be able to selectively sync their inventory across the 3 modules as allowed by the inventory synchronization and conflict resolution mechanisms.
> - Treat anything you build that clearly belongs to shared platform primitives as part of the PLATFORM CORE, not as Commerce-specific code.

## Implementation Plan

We will build the Shared Commerce Foundation (Inventory & Ledger) as a **PLATFORM CORE** primitive, extensible to other verticals like Transport and Logistics.

### 1. Database Schemas (Postgres/D1 Mock)
- Define the `InventoryItem` schema with `tenantId`, `version`, and `deletedAt`.
- Define the `LedgerEntry` schema with integer monetary values (kobo/cents).

### 2. Inventory Synchronization Service
- Implement a service that listens to `inventory.updated` events.
- Apply the Tenant-as-Code `inventorySyncPreferences` to determine if an update should propagate to other modules (e.g., POS to Single Vendor).

### 3. Conflict Resolution Logic
- Implement the `last_write_wins` strategy as specified in the Commerce Architecture Plan.

## Specialist Agents Required
- **Data Engineer:** To design the database schemas ensuring multi-tenancy and data integrity invariants.
- **Backend Architect:** To implement the synchronization service and event handlers.

---

*This document serves as the implementation guide for Epic 4, ensuring strict adherence to the WebWaka OS v4 Blueprint.*
