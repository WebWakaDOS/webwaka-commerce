# ENV_SETUP.md — webwaka-commerce

Environment variables required to run and deploy this repo. Never commit secrets to Git — use Cloudflare dashboard secrets or Replit Secrets for local dev.

---

## Local Development (Replit / `.env`)

Copy `.env.example` to `.env` and fill in values:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VITE_API_BASE` | No | `""` (uses Vite proxy) | Override API base URL for frontend. In dev, leave blank — Vite proxies `/api/*` to the staging worker automatically. |
| `VITE_TENANT_ID` | No | `tnt_demo` | Tenant identifier injected into the frontend bundle. |

> **Note:** In local dev, API calls from the frontend go through `vite.config.ts` proxy → `https://webwaka-commerce-api-staging.webwaka.workers.dev`. No backend runs locally.

---

## Cloudflare Workers (Staging & Production)

These are **Cloudflare Workers Secrets** — set via Wrangler CLI or Cloudflare Dashboard. Do NOT put these in `.env` files or commit them to Git.

```bash
# Set a secret for staging
wrangler secret put SECRET_NAME --env staging

# Set a secret for production
wrangler secret put SECRET_NAME --env production
```

### Required Secrets

| Secret | Environment | Description | Source |
|--------|-------------|-------------|--------|
| `JWT_SECRET` | staging + production | HMAC secret for signing/verifying JWT tokens. Must match the secret used in `webwaka-core` and `webwaka-super-admin-v2`. | Query platform admin |
| `CLOUDFLARE_API_TOKEN` | CI/CD only | CF API token with Workers + Pages + D1 + KV permissions, used by GitHub Actions to deploy. | Cloudflare Dashboard → API Tokens |
| `CLOUDFLARE_ACCOUNT_ID` | CI/CD only | `63b6fba4dcc659d5c94b4136601aa3de` | Cloudflare Dashboard |

### Cloudflare Bindings (configured in `wrangler.toml` — not secrets)

| Binding | Type | Staging ID | Production ID | Description |
|---------|------|-----------|---------------|-------------|
| `DB` | D1 Database | `f39bc175-4485-482a-ae87-b1195ead0ef3` | `1cc45df9-36e5-44d4-8a3b-e8377881c00b` | Main SQLite DB |
| `TENANT_CONFIG` | KV Namespace | `018ac3a580104b8b8868712919be71bd` | `e9a8b3178cf245a7815f4e5bf7e67299` | Tenant-as-Code config |
| `EVENTS` | KV Namespace | `ee8c49024b2d43a98c54962dba43f15b` | `4e0bd5d5233f47dbaff75f8b10b89a8d` | Cross-module event bus |
| `SESSIONS_KV` | KV Namespace | `bde8befc71da40c5a5979ee35830022a` | `f176cebbdf8445838c72d9fde0173628` | JWT session storage |

---

## GitHub Actions / CI-CD

These are **GitHub Repository Secrets** (set in repo Settings → Secrets → Actions):

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | CF API token for Wrangler deploy commands |
| `CLOUDFLARE_ACCOUNT_ID` | `63b6fba4dcc659d5c94b4136601aa3de` |
| `JWT_SECRET` | Must match the JWT secret used by `webwaka-core` |

---

## Cross-Repo: `@webwaka/core` Dependency

The Worker bundle (`src/worker.ts`) depends on `@webwaka/core` from `https://github.com/WebWakaDOS/webwaka-core`.

**To resolve locally for Worker development:**
```bash
# Clone webwaka-core as a sibling directory
git clone https://github.com/WebWakaDOS/webwaka-core ../webwaka-core
cd ../webwaka-core && npm install && npm run build
cd ../webwaka-commerce && npm install
```

Alternatively, Manus/CI can wire this via npm workspace or npm link.

---

## Database Setup

Run D1 migrations against staging:
```bash
wrangler d1 migrations apply webwaka-commerce-db-staging --env staging
```

Seed tenant config to staging KV:
```bash
node scripts/seed-tenants-staging.js
```

---

## Environment Variable Checklist

Before deploying, confirm the following are set:

- [ ] `JWT_SECRET` set as CF Worker secret (staging + production)
- [ ] `CLOUDFLARE_API_TOKEN` set in GitHub Secrets for CI/CD
- [ ] `CLOUDFLARE_ACCOUNT_ID` set in GitHub Secrets for CI/CD
- [ ] D1 migrations applied to target environment
- [ ] KV tenant config seeded (`seed-tenants-staging.js` / `seed-tenants.js`)
- [ ] `@webwaka/core` package resolved (for Worker bundle builds)
