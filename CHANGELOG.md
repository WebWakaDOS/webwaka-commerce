
## [Security Patch] - 2026-03-29

### Security (fix/auth-standardization)
- **CORS hardened**: Replaced wildcard/echo-all CORS with environment-aware allowlist (production/staging/development)
- **Signed JWT auth**: Auth middleware now validates HS256-signed JWTs via JWT_SECRET (Web Crypto API) instead of KV session lookup
- **tenantId isolation**: tenantId now sourced exclusively from JWT payload — never from x-tenant-id request headers
- **requireRole/requirePermission**: Role and permission guards now available and callable in route handlers
- **RATE_LIMIT_KV binding**: Added RATE_LIMIT_KV KV namespace binding to wrangler.toml for future rate limiting
- **ENVIRONMENT binding**: Added ENVIRONMENT var to wrangler.toml for env-aware CORS enforcement
