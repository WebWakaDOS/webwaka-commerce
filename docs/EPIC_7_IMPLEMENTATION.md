# EPIC 7: Multi Vendor Marketplace Module

## Context Review (WebWaka OS v4 Blueprint)

Before implementing, we must explicitly reference the authoritative architecture:

> **Part 10.2: Commerce & Retail Suite**
> * **Multi-Vendor Marketplace:** Complex catalog management. Per-vendor inventory isolation with marketplace-level aggregation and conflict resolution.

> **Part 9.1: The 7 Core Invariants**
> - **Mobile First:** All UIs designed for mobile screens first (min-width breakpoints). Desktop is a secondary enhancement. Lighthouse mobile score must be ≥ 90.
> - **PWA First:** All web applications must be Progressive Web Apps. `manifest.json` and service workers are mandatory. No native app builds.

> **Commerce Architecture Plan Clarification:**
> - Multi-Vendor tenant model: Marketplace tenant owns marketplace, vendor tenants are scoped with `marketplaceId` + `tenantId`.
> - Reuse ONLY the core primitives built in `src/core/` (sync engine, event bus, tenant-as-code, inventory/ledger).
> - Use the Platform Event Bus for all cross-module communication.

## Implementation Plan

We will build the Multi Vendor Marketplace module as a **COMMERCE MODULE** that leverages the Platform Core primitives.

### 1. Marketplace Core Logic
- Implement marketplace-level catalog aggregation (querying across multiple vendor inventories scoped by `marketplaceId`).
- Implement the marketplace checkout logic, which must split payments/orders per vendor.
- Ensure all monetary values are handled as integers (kobo/cents).

### 2. Event Bus Integration
- Publish `order.created` and `payment.completed` events via the Platform Event Bus.
- Subscribe to `inventory.updated` events to keep the marketplace catalog in sync.

### 3. React PWA UI (Mobile First)
- Create a mobile-first React component for the marketplace interface.
- Implement a UI that displays products grouped by vendor or aggregated, with a unified cart.

## Specialist Agents Required
- **Frontend Developer:** To build the React PWA UI.
- **Backend Architect:** To wire the marketplace logic, handle vendor scoping, and integrate with the Event Bus.

---

*This document serves as the implementation guide for Epic 7, ensuring strict adherence to the WebWaka OS v4 Blueprint.*
