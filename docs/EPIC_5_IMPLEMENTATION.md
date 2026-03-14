# EPIC 5: Point of Sale (POS) Module

## Context Review (WebWaka OS v4 Blueprint)

Before implementing, we must explicitly reference the authoritative architecture:

> **Part 10.2: Commerce & Retail Suite**
> * **Point of Sale (POS):** Offline-first application. Sophisticated sync engine upon reconnection.

> **Part 9.1: The 7 Core Invariants**
> - **Mobile First:** All UIs designed for mobile screens first (min-width breakpoints). Desktop is a secondary enhancement. Lighthouse mobile score must be ≥ 90.
> - **PWA First:** All web applications must be Progressive Web Apps. `manifest.json` and service workers are mandatory. No native app builds.
> - **Offline First:** Critical operations must work without internet. Dexie/IndexedDB + background sync required. Service worker must cache critical API responses.
> - **Nigeria First:** Paystack/Flutterwave are primary payment gateways. NGN is the default currency. WAT timezone used. NDPR compliance enforced.

> **Commerce Architecture Plan Clarification:**
> - Reuse ONLY the core primitives built in `src/core/` (sync engine, event bus, tenant-as-code, inventory/ledger).
> - Use the Universal Offline Sync Engine for POS offline cart, orders, inventory changes.
> - Use the Platform Event Bus for all cross-module communication (`order.created`, `inventory.updated`, `payment.completed`).

## Implementation Plan

We will build the POS module as a **COMMERCE MODULE** that leverages the Platform Core primitives.

### 1. POS Core Logic (Offline-First)
- Implement the POS cart and checkout logic.
- Integrate the `SyncManager` (from Epic 1) to queue `order.created` and `inventory.updated` mutations when offline.
- Ensure all monetary values are handled as integers (kobo/cents).

### 2. Event Bus Integration
- Publish `order.created` and `payment.completed` events via the Platform Event Bus (from Epic 2).
- Subscribe to `inventory.updated` events to keep the local Dexie database in sync.

### 3. React PWA UI (Mobile First)
- Create a mobile-first React component for the POS interface.
- Implement a responsive grid for products and a slide-up cart for mobile screens.

## Specialist Agents Required
- **Frontend Developer:** To build the React PWA UI and integrate the Dexie sync manager.
- **Backend Architect:** To wire the POS logic to the Event Bus and Sync Engine.

---

*This document serves as the implementation guide for Epic 5, ensuring strict adherence to the WebWaka OS v4 Blueprint.*
