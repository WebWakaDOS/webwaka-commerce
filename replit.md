# WebWaka Commerce Suite

## Project Overview
AI-native, mobile-first, offline-first SaaS operating system and commerce platform for emerging markets (Nigeria/Africa). Includes POS, Single-Vendor Storefront, and Multi-Vendor Marketplace modules.

## Tech Stack
- **Frontend:** React 19 + TypeScript, Vite 6
- **State/Offline:** Dexie.js (IndexedDB) for offline-first mutation queue
- **PWA:** Service Worker + Web App Manifest
- **Backend (Edge):** Cloudflare Workers + Hono framework (deployed separately)
- **Database (Edge):** Cloudflare D1 (SQLite) + Cloudflare KV
- **Package Manager:** npm

## Project Structure
```
src/
  app.tsx         # Main React application component
  main.tsx        # Entry point; mounts React, registers service worker
  worker.ts       # Cloudflare Worker entry (Hono app - deployed to CF)
  core/           # Shared platform primitives
    i18n/         # Internationalization (en, yo, ig, ha)
    offline/      # Dexie/IndexedDB offline sync engine
    sync/         # Inventory sync services
    tenant/       # Multi-tenancy resolution
  middleware/     # Hono middlewares (auth)
  modules/        # Business SaaS modules
    pos/          # Point of Sale
    single-vendor/# B2C Storefront
    multi-vendor/ # Marketplace
    admin/        # Platform administration
  i18n/           # Language files
public/           # Static assets, SW, PWA manifest
migrations/       # Cloudflare D1 SQL migration files
scripts/          # Utility/seeding scripts
docs/             # Architecture documentation
```

## Development
- `npm run dev:ui` — Start Vite dev server on port 5000
- `npm run build:ui` — Build frontend for production
- `npm run test` — Run Vitest unit tests
- `npm run e2e` — Run Playwright e2e tests

## Key Design Invariants
1. **Build Once Use Infinitely** — Modular, reusable across SaaS verticals
2. **Mobile First** — All UIs target mobile as primary
3. **Offline First** — POS works offline; syncs via mutation queue
4. **Nigeria/Africa First** — NGN/Kobo currency, WAT timezone, NDPR compliance
5. **Tenant-as-Code** — Multi-tenancy resolved at edge via KV config

## Environment Variables
See `.env.example` for reference:
- `VITE_API_BASE` — API base URL (proxied to Cloudflare Workers in dev)
- `VITE_TENANT_ID` — Tenant identifier (default: `tnt_demo`)

## Deployment
- **Frontend:** Static site deployment (Vite build → `dist/`)
- **Backend:** Cloudflare Workers (`wrangler deploy`)
- In dev, `/api` proxies to `https://webwaka-commerce-api-staging.webwaka.workers.dev`

## Progress Tracker
| Phase | Description | Status | PR |
|-------|-------------|--------|----|
| COM-1 POS | Point of Sale (POS module) | ✅ Complete | #8 |
| COM-2 SV Phase 1 | Single-Vendor foundation, checkout, Paystack | ✅ Complete | #10 |
| COM-2 SV Phase 2 | Promo codes, VAT, delivery address, NDPR | ✅ Complete | #11 |
| COM-2 SV Phase 3 | Variants, FTS5 search, virtual scroll, category pills | ✅ Complete | #12 |
| COM-2 SV Phase 4 | Customer OTP auth, wishlists, order history, abandoned-cart cron | ✅ Complete | #13 |

**Test count:** 370 passing (Vitest)

## Notes
- The `@webwaka/core` package is a local file dependency (`../webwaka-core`) used only in worker/backend files, not the frontend React app
- Vite configured with `host: '0.0.0.0'` and `allowedHosts: true` for Replit proxy compatibility
- SV Phase 4 adds: `migrations/005_sv_auth.sql` (customer_otps, wishlists, abandoned_carts), JWT helper (`signJwt`/`verifyJwt`), Termii SMS OTP, Dexie v5 wishlists, hourly abandoned-cart cron, `AccountPage` component

## RBAC & Offline-First Refactor (session March 30 2026)

### Backend API hardening
- **`single-vendor/api.ts`**: `requireRole(["SUPER_ADMIN","TENANT_ADMIN"])` added to `GET /orders`, `GET /customers`, `GET /analytics`; removed old x-admin-key manual check. Fixed `authenticateCustomer` helper — restored inline header read overwritten by bulk `getTenantId` replacement.
- **`multi-vendor/api.ts`**: Removed `isAdminRequest` function; replaced both usages (`POST /vendors`, `PATCH /vendors/:id`) with `requireRole(["SUPER_ADMIN","TENANT_ADMIN"])` route-level middleware.

### Dexie offline-first storage (v6 schema)
- **`core/offline/db.ts`**: Added `MvProduct` interface, `mvProducts` table (indexes: `id, tenantId, vendorId, cachedAt`), helpers: `getMvProducts`, `cacheMvProducts`, `decrementMvProductQuantity`.

### Multi-Vendor marketplace UI rewrite
- **`multi-vendor/ui.tsx`**: Replaced mock `useState` inventory with Dexie offline-first — loads `mvProducts` from IndexedDB immediately (offline-safe), background-fetches API and writes to cache, queues checkout via `queueMutation`, optimistically decrements Dexie quantities on success.
