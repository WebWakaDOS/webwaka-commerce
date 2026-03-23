# REPO ANALYSIS: webwaka-commerce

**Repo:** https://github.com/WebWakaDOS/webwaka-commerce  
**Version:** 4.0.0  
**Analysis Date:** 2026-03-23  
**Status:** Active — Commerce Suite (POS + Storefront + Marketplace)

---

## 1. Purpose & Scope

This repository implements the **WebWaka Commerce Suite** — the e-commerce core module of the WebWaka Digital Operating System. It provides three interlocked commerce verticals:

| Module | Epic | Description |
|--------|------|-------------|
| **POS** | COM-1 | Offline-first Point of Sale for physical retail |
| **Single-Vendor Storefront** | COM-2 | B2C online store with local payment integrations |
| **Multi-Vendor Marketplace** | COM-3 | Aggregated marketplace with vendor isolation & commission engine |

Target markets: Nigeria and Africa broadly, with Yorùbá/Igbo/Hausa/English i18n, NGN (kobo) currency, NDPR compliance, and WAT timezone defaults.

---

## 2. Tech Stack

### Frontend
| Layer | Technology | Notes |
|-------|-----------|-------|
| Framework | React 19 (TypeScript) | SPA, no SSR |
| Build | Vite 6 | Code-split: react, dexie chunks |
| Offline Storage | Dexie.js (IndexedDB) | Mutation queue, cart cache, product cache |
| PWA | Service Worker + Web App Manifest | Offline-capable, installable |
| i18n | Custom (en/yo/ig/ha) | `src/core/i18n/index.ts` |
| Styling | Inline React styles | Mobile-first, no Tailwind in use currently |
| State | React hooks (useState/useEffect) | No Redux/Zustand |

### Backend (Edge)
| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Cloudflare Workers | Edge-first, no cold starts |
| Framework | Hono 4.x | Lightweight, Workers-native |
| Auth | JWT via `@webwaka/core` | Session tokens stored in CF KV |
| DB | Cloudflare D1 (SQLite) | Relational, offline sync capable |
| KV Store | Cloudflare KV | Tenant configs, sessions, event bus state |
| Storage | Cloudflare R2 | Asset/image storage (planned) |
| Deploy | Wrangler CLI | `wrangler.toml` configures staging + production |

### Package Manager
- **npm** (confirmed via `package-lock.json`)

### Testing
- **Unit/Integration:** Vitest (`vitest.config.ts`)
- **E2E:** Playwright (`playwright.config.ts`)

---

## 3. Repository Structure

```
webwaka-commerce/
├── src/
│   ├── main.tsx                # PWA entry: mounts React, registers SW
│   ├── app.tsx                 # Root React component (all 3 modules + nav)
│   ├── worker.ts               # Cloudflare Worker entry (Hono app)
│   │
│   ├── core/                   # Shared platform primitives
│   │   ├── db/                 # D1 schema type definitions
│   │   ├── event-bus/          # Cross-module pub/sub (EventBusRegistry)
│   │   │   ├── index.ts        # EventBusRegistry class
│   │   │   ├── client.ts       # Event publish client
│   │   │   └── server.ts       # Event bus server-side handler
│   │   ├── i18n/               # Internationalization (en/yo/ig/ha)
│   │   │   └── index.ts        # getTranslations(), formatKoboToNaira()
│   │   ├── offline/            # Dexie/IndexedDB offline engine
│   │   │   └── db.ts           # CommerceOfflineDB, mutation queue helpers
│   │   ├── sync/               # Inventory sync services
│   │   │   ├── inventory-service.ts
│   │   │   ├── client.ts
│   │   │   └── server.ts
│   │   └── tenant/             # Tenant-as-Code resolution
│   │       └── index.ts        # tenantResolver middleware, requireModule()
│   │
│   ├── middleware/
│   │   └── auth.ts             # JWT auth — delegates to @webwaka/core
│   │
│   └── modules/                # Business SaaS modules
│       ├── pos/                # COM-1: Point of Sale
│       │   ├── api.ts          # Hono routes: products CRUD, orders, sync
│       │   ├── core.ts         # Business logic (cart, checkout, payments)
│       │   ├── ui.tsx          # React POS UI component
│       │   ├── api.test.ts     # Vitest API tests
│       │   └── core.test.ts    # Vitest business logic tests
│       ├── single-vendor/      # COM-2: B2C Storefront
│       │   ├── api.ts          # Hono routes: catalog, cart sessions, orders
│       │   ├── core.ts         # Storefront business logic
│       │   ├── ui.tsx          # React Storefront UI
│       │   └── *.test.ts
│       ├── multi-vendor/       # COM-3: Marketplace
│       │   ├── api.ts          # Hono routes: vendors, products, orders, ledger
│       │   ├── core.ts         # Marketplace logic, commission engine
│       │   ├── ui.tsx          # React Marketplace UI
│       │   └── *.test.ts
│       ├── retail/             # Shared retail logic (reused across modules)
│       └── admin/              # Platform admin UI component
│           └── ui.tsx
│
├── migrations/
│   └── 001_commerce_schema.sql # D1 schema: products, vendors, orders, customers, ledger, sync_mutations
│
├── public/
│   ├── sw.js                   # Service Worker (offline caching strategy)
│   ├── manifest.json           # PWA Web App Manifest
│   └── icons/                  # App icons (96px, 192px, 512px)
│
├── scripts/
│   ├── seed-tenants.js         # Seed KV with demo tenant configs
│   └── seed-tenants-staging.js # Staging seed script
│
├── docs/
│   ├── WebWakaDigitalOperatingSystem.md   # Master architecture doc
│   ├── COMMERCE_ARCHITECTURE_PLAN.md      # Commerce-specific arch plan
│   ├── EPIC_1-7_IMPLEMENTATION.md         # Per-epic implementation notes
│   └── QA_VERIFICATION_REPORT*.md        # QA results
│
├── playwright/                 # E2E test helpers/fixtures
├── index.html                  # SPA shell (lang="en-NG", PWA meta)
├── vite.config.ts              # Vite: port 5000, host 0.0.0.0, /api proxy to CF staging
├── wrangler.toml               # CF Workers config: staging + production environments
├── tsconfig.json               # TypeScript config
├── vitest.config.ts            # Vitest config
└── playwright.config.ts        # Playwright config
```

---

## 4. Database Schema (D1 — `001_commerce_schema.sql`)

| Table | Purpose | Key Fields |
|-------|---------|-----------|
| `products` | Inventory catalogue | `tenant_id`, `vendor_id`, `sku`, `price` (kobo), `quantity`, `is_active` |
| `vendors` | Marketplace vendor registry | `marketplace_tenant_id`, `commission_rate` (basis points), `status` |
| `orders` | All sales across channels | `channel` (pos/storefront/marketplace), `payment_method`, `total_amount` (kobo) |
| `cart_sessions` | Online storefront carts | `session_token`, `items_json`, `expires_at` |
| `customers` | Customer CRM with NDPR | `ndpr_consent`, `loyalty_points`, `total_spend` (kobo) |
| `ledger_entries` | Financial audit trail | `account_type`, `amount` (kobo), `type` (CREDIT/DEBIT) |
| `sync_mutations` | Offline-first sync log | `entity_type`, `action`, `status` (pending/applied/conflict) |

All monetary values stored as **integers in kobo** (1 NGN = 100 kobo).

---

## 5. API Routes (Cloudflare Worker)

### Hono App — `src/worker.ts`

**Public Routes (no auth):**
- `GET /health` — Health check
- `GET /api/pos/products` — Product listing (POS)
- `GET /api/single-vendor/products` — Product listing (storefront)
- `GET /api/multi-vendor/products` — Product listing (marketplace)
- `GET /api/multi-vendor/vendors` — Vendor listing

**Authenticated Routes (JWT Bearer required):**

| Module | Method | Path | Description |
|--------|--------|------|-------------|
| POS | POST | `/api/pos/products` | Create product |
| POS | PATCH | `/api/pos/products/:id` | Update stock/details |
| POS | POST | `/api/pos/orders` | Create POS sale |
| POS | POST | `/api/pos/sync` | Sync offline mutations |
| Storefront | POST | `/api/single-vendor/cart` | Create/update cart session |
| Storefront | POST | `/api/single-vendor/orders` | Place online order |
| Marketplace | POST | `/api/multi-vendor/vendors` | Register vendor |
| Marketplace | POST | `/api/multi-vendor/orders` | Marketplace order |

---

## 6. Cross-Repo Dependencies

### Hard Dependency: `@webwaka/core`
- **Used in:** `src/middleware/auth.ts`, `src/modules/pos/api.ts`, `src/modules/single-vendor/api.ts`, `src/modules/multi-vendor/api.ts`
- **Provides:** `jwtAuthMiddleware`, `requireRole`, `getTenantId`
- **Source:** `https://github.com/WebWakaDOS/webwaka-core`
- **Local path:** `../webwaka-core` (sibling directory in package.json)
- **Status in Replit:** Not installed (local file dep outside workspace); Worker files cannot be run locally — they deploy to Cloudflare Workers. Frontend React code does NOT import from `@webwaka/core`.

### Ecosystem Relationships
| Repo | Relationship to Commerce |
|------|--------------------------|
| `webwaka-core` | Provides shared JWT auth, tenant utilities, role checks |
| `webwaka-super-admin-v2` | Central admin for managing tenants, users, platform config |
| `webwaka-central-mgmt` | Cross-repo management plane; orchestrates feature flags |
| `webwaka-transport` | Separate module; can share product/order primitives via events |
| `webwaka-logistics` | Delivery fulfilment hooks; order status updates via event bus |
| `webwaka-professional` | Professional services vertical; shared auth session from core |
| `webwaka-civic` | Government services vertical; separate domain, shared infra |

Cross-repo communication is via the **Cloudflare KV event bus** (`EVENTS` KV namespace) using the `WebWakaEvent` schema defined in `src/core/event-bus/index.ts`.

---

## 7. Multi-Tenancy Architecture

Tenants are resolved at the edge via `src/core/tenant/index.ts`:
- **By domain** (`X-Tenant-ID` header or hostname lookup)
- Tenant config stored in Cloudflare KV (`TENANT_CONFIG` namespace)
- Each tenant has: `enabledModules`, `permissions`, `featureFlags`, `inventorySyncPreferences`
- Default demo tenant: `tnt_demo`

---

## 8. Offline-First Architecture

**Client-side (IndexedDB via Dexie):**
- `CommerceOfflineDB` per tenant instance: `mutations`, `cartItems`, `offlineOrders`, `products` tables
- Mutations queued with `queueMutation()` when offline; replayed on reconnection via SW `SYNC_MUTATIONS` message
- Service Worker (`public/sw.js`) triggers sync via `navigator.serviceWorker` message channel

**Server-side (D1):**
- `sync_mutations` table logs all applied changes for conflict resolution
- `POST /api/pos/sync` endpoint processes pending offline mutations

---

## 9. Invariant Compliance Checklist

| Invariant | Implementation |
|-----------|---------------|
| Build Once Use Infinitely | `dbCache` Map reuses DB instances; module APIs are generic tenant-parameterized |
| Mobile First | All UI components use inline mobile-first styles; viewport meta `width=device-width` |
| PWA First | Service Worker registered, `manifest.json` with icons, offline fallback |
| Offline First | Dexie mutation queue; offline cart/order storage; SW sync trigger |
| Nigeria/Africa First | 4-language i18n (en/yo/ig/ha); NGN kobo pricing; NDPR consent field on customers; Paystack/Flutterwave payment methods |
| Vendor Neutral AI | No AI provider hard-coded; AI integrations are abstracted (planned via core) |

---

## 10. Known Issues & Technical Debt

1. **`@webwaka/core` not installed locally** — Worker code cannot run in Replit dev. Backend is deployed to Cloudflare Workers staging (`webwaka-commerce-api-staging.webwaka.workers.dev`); Vite proxies `/api/*` there.
2. **Dexie compound index warning** — Query on `{tenantId, status}` on `mutations` table needs a compound index (`[tenantId+status]`) to avoid performance warning.
3. **Tenant config in mock store** — `src/core/tenant/index.ts` uses a local mock KV store; production resolves from Cloudflare KV.
4. **No TypeScript strict null checks on some DB results** — Some D1 query results are cast with `!` assertions.
5. **Admin module** — `src/modules/admin/ui.tsx` exists but routes not yet mounted in worker.

---

## 11. Deployment Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Cloudflare Network                     │
│                                                         │
│  ┌──────────────────────┐   ┌────────────────────────┐  │
│  │   Cloudflare Pages   │   │  Cloudflare Workers     │  │
│  │   (SPA Frontend)     │   │  (Hono API)             │  │
│  │   React + Vite build │◄──│  /api/pos               │  │
│  │   dist/ → CDN        │   │  /api/single-vendor     │  │
│  └──────────────────────┘   │  /api/multi-vendor      │  │
│                             └────────────┬───────────┘  │
│                                          │               │
│  ┌───────────────┐  ┌──────────┐  ┌─────▼──────────┐   │
│  │  KV (Tenants/ │  │  D1      │  │  KV (Sessions/ │   │
│  │  Feature Flags│  │  (SQLite)│  │  Event Bus)    │   │
│  └───────────────┘  └──────────┘  └────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

**Staging:**
- API: `https://webwaka-commerce-api-staging.webwaka.workers.dev`
- D1: `webwaka-commerce-db-staging` (id: `f39bc175-4485-482a-ae87-b1195ead0ef3`)

**Production:**
- API: `https://webwaka-commerce-api-prod.webwaka.workers.dev`
- D1: `webwaka-commerce-db-prod` (id: `1cc45df9-36e5-44d4-8a3b-e8377881c00b`)

---

## 12. Key Findings Summary

1. **Offline-first React PWA + Cloudflare Workers edge API** — fully decoupled frontend/backend; frontend builds to static files (Cloudflare Pages), API runs at edge (Cloudflare Workers).
2. **Hard dependency on `@webwaka/core`** for JWT auth and tenant utilities — this repo cannot build the Worker bundle without the sibling `webwaka-core` repo being available.
3. **Three commerce modules (POS/Storefront/Marketplace) share one D1 schema and one Worker** — multi-tenancy + module gating handles isolation; event bus in KV enables cross-module communication.
