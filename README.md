# WebWaka Commerce Platform

WebWaka Commerce is a mobile-first, PWA-based commerce platform built on the WebWaka OS v4 architecture. It provides three integrated commerce modules: Point of Sale (POS), Single Vendor Storefront, and Multi Vendor Marketplace.

## Architecture

The platform is built on **Platform Core Primitives** that are reused across all modules:

- **Universal Offline Sync Engine** – Dexie/IndexedDB + Mutation Queue for offline-first operations
- **Platform Event Bus** – Cross-module communication via event pub/sub
- **Tenant-as-Code** – Dynamic tenant configuration with inventory sync preferences
- **Shared Commerce Foundation** – Multi-tenant inventory and ledger schemas

## Modules

### POS (Point of Sale)
Offline-first retail checkout system with real-time inventory sync.

### Single Vendor Storefront
B2C e-commerce portal with Paystack/Flutterwave payment integration.

### Multi Vendor Marketplace
Complex marketplace with vendor aggregation, per-vendor inventory isolation, and payment splitting.

## Tech Stack

- **Frontend:** React + TypeScript + TailwindCSS (Mobile First)
- **Backend:** Cloudflare Workers + Hono
- **Database:** Cloudflare D1 + KV
- **PWA:** manifest.json + Service Workers
- **Testing:** Vitest

## Getting Started

```bash
npm install
npm run test
npm run build
```

## Deployment

See `.github/workflows/` for CI/CD configuration.

- **Staging:** Deploys from `develop` branch to Cloudflare Pages/Workers
- **Production:** Deploys from `main` branch to Cloudflare Pages/Workers

## Documentation

- `docs/WebWakaDigitalOperatingSystem.md` – Architecture blueprint
- `docs/COMMERCE_ARCHITECTURE_PLAN.md` – Commerce module design
- `docs/EPIC_*_IMPLEMENTATION.md` – Epic-specific implementation details
