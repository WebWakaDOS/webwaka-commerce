# WebWaka Commerce (`webwaka-commerce`) QA Certification

**Prepared by:** Manus AI
**Date:** April 2026
**Target Repository:** `webwaka-commerce`

## 1. Audit Scope

This QA certification covers the implementation of the Offline-First POS, B2B Wholesale Portal, and Tiered Pricing Engine in `webwaka-commerce`.

## 2. Acceptance Criteria

| ID | Feature | Acceptance Criteria | Status |
| :--- | :--- | :--- | :--- |
| QA-COM-1 | Offline POS | The POS successfully records transactions to Dexie.js when offline and syncs them to D1 when online. | PENDING |
| QA-COM-2 | Tiered Pricing | The `GET /products` endpoint correctly returns the discounted price for a customer in the "Wholesale" segment. | PENDING |
| QA-COM-3 | B2B Portal | The B2B portal correctly enforces Minimum Order Quantities (MOQs) before allowing checkout. | PENDING |
| QA-COM-4 | Unit Tests | All new POS modules and pricing engines have passing unit tests in `src/**/*.test.ts`. | PENDING |

## 3. Offline Resilience Testing

1. Open the POS interface in a browser.
2. Disconnect the network (simulate offline mode).
3. Add items to the cart and complete a transaction.
4. Verify the transaction is stored in the local Dexie.js database.
5. Reconnect the network.
6. Verify the transaction is synced to the Cloudflare D1 backend and removed from Dexie.js.

## 4. Security & RBAC Validation

- Verify that the B2B Wholesale Portal requires a valid customer login with the `role:wholesale` permission.
- Ensure that the Tiered Pricing Engine cannot be bypassed by manipulating the `customerSegment` parameter in the API request.

## 5. Regression Guards

- Run `npm run test` to ensure 100% pass rate.
- Run `npm run build` to ensure no TypeScript compilation errors.
- Verify that the existing single-vendor and multi-vendor storefronts still function correctly and display the default retail prices.
