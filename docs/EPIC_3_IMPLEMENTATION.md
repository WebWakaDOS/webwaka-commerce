# EPIC 3: Tenant-as-Code & Module Registry

## Context Review (WebWaka OS v4 Blueprint)

Before implementing, we must explicitly reference the authoritative architecture:

> **Part 7: TENANT-AS-CODE ARCHITECTURE**
> Each tenant is defined via configuration rather than infrastructure duplication, allowing infinite SaaS generation.
> 
> **Example Tenant Configuration:**
> * `tenant_id`
> * `domain`
> * `enabled modules`
> * `branding`
> * `permissions`
> * `feature flags`
> 
> **Runtime Process:**
> Request arrives → Edge worker resolves tenant → Tenant config loaded from KV → Modules activated → Application composed dynamically

> **Part 5: SAAS COMPOSITION ENGINE**
> Dynamically assembles each tenant's application. Instead of one static product, the platform builds a custom SaaS instance per tenant.
> * **Architecture Flow:** Tenant Config → Module Registry → Composition Engine → Tenant Application.

> **Commerce Architecture Plan Clarification:**
> - Multi-Vendor tenant model: Marketplace tenant owns marketplace, vendor tenants are scoped with `marketplaceId` + `tenantId`.
> - Inventory sync schema:
> ```json
> {
>   "sync_pos_to_single_vendor": true,
>   "sync_pos_to_multi_vendor": true,
>   "sync_single_vendor_to_multi_vendor": false,
>   "conflict_resolution": "last_write_wins"
> }
> ```

## Implementation Plan

We will build the Tenant-as-Code & Module Registry as a **PLATFORM CORE** primitive.

### 1. Tenant Configuration Schema
- Define the TypeScript interfaces for the Tenant-as-Code configuration.
- Include the specific inventory sync schema requested for the Commerce project.
- Implement the hierarchical tenant model (`marketplaceId` + `tenantId`).

### 2. Edge Worker Router (Tenant Resolver)
- Create a Hono middleware to resolve the tenant based on the request domain or headers.
- Mock the Cloudflare KV lookup for tenant configurations.

### 3. Module Registry
- Implement a registry to define available modules (POS, Single Vendor, Multi Vendor).
- Create the Composition Engine logic to validate if a tenant has access to requested modules.

## Specialist Agents Required
- **Backend Architect:** To design the Edge Worker Router and Tenant Resolver middleware.
- **Security Engineer:** To ensure multi-tenant isolation and RBAC within the tenant config.

---

*This document serves as the implementation guide for Epic 3, ensuring strict adherence to the WebWaka OS v4 Blueprint.*
