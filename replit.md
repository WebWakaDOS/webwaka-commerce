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

## Notes
- The `@webwaka/core` package is a local file dependency (`../webwaka-core`) used only in worker/backend files, not the frontend React app
- Vite configured with `host: '0.0.0.0'` and `allowedHosts: true` for Replit proxy compatibility
