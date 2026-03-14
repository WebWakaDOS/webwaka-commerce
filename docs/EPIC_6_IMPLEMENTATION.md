# EPIC 6: Single Vendor Storefront Module

## Context Review (WebWaka OS v4 Blueprint)

Before implementing, we must explicitly reference the authoritative architecture:

> **Part 10.2: Commerce & Retail Suite**
> * **Single Vendor Storefront:** B2C e-commerce portal. Real-time inventory updates.

> **Part 9.1: The 7 Core Invariants**
> - **Mobile First:** All UIs designed for mobile screens first (min-width breakpoints). Desktop is a secondary enhancement. Lighthouse mobile score must be ≥ 90.
> - **PWA First:** All web applications must be Progressive Web Apps. `manifest.json` and service workers are mandatory. No native app builds.
> - **Nigeria First:** Paystack/Flutterwave are primary payment gateways. NGN is the default currency. WAT timezone used. NDPR compliance enforced.

> **Commerce Architecture Plan Clarification:**
> - Reuse ONLY the core primitives built in `src/core/` (sync engine, event bus, tenant-as-code, inventory/ledger).
> - Use the Platform Event Bus for all cross-module communication (`order.created`, `inventory.updated`, `payment.completed`).
> - Respect Tenant-as-Code and `inventorySyncPreferences` exactly as implemented in EPIC 3 and EPIC 4.

## Implementation Plan

We will build the Single Vendor Storefront module as a **COMMERCE MODULE** that leverages the Platform Core primitives.

### 1. Storefront Core Logic
- Implement the B2C cart and checkout logic.
- Integrate Paystack/Flutterwave mock for checkout (Nigeria First invariant).
- Ensure all monetary values are handled as integers (kobo/cents).

### 2. Event Bus Integration
- Publish `order.created` and `payment.completed` events via the Platform Event Bus.
- Subscribe to `inventory.updated` events to keep the storefront inventory in sync (respecting `inventorySyncPreferences` from Epic 4).

### 3. React PWA UI (Mobile First)
- Create a mobile-first React component for the B2C storefront interface.
- Implement a responsive product grid and a checkout flow.

## Specialist Agents Required
- **Frontend Developer:** To build the React PWA UI.
- **Backend Architect:** To wire the storefront logic to the Event Bus and Payment Gateway mock.

---

*This document serves as the implementation guide for Epic 6, ensuring strict adherence to the WebWaka OS v4 Blueprint.*
