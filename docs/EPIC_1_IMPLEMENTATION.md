# EPIC 1: Universal Offline Sync Engine Implementation

## Context Review (WebWaka OS v4 Blueprint)

Before implementing, we must explicitly reference the authoritative architecture:

> **Part 6: UNIVERSAL OFFLINE SYNC ENGINE**
> Offline operation is central to the platform. Modules must NOT implement their own sync logic; all modules must use the platform sync engine.
> 
> **Architecture:**
> IndexedDB → Mutation Queue → Sync API → Server reconciliation → Postgres database
> 
> **Required Features:**
> * Conflict resolution
> * Version control
> * Retry logic
> * Background sync

> **Part 9.1: The 7 Core Invariants**
> - **Offline First:** Critical operations must work without internet. Dexie/IndexedDB + background sync required. Service worker must cache critical API responses.
> - **Build Once Use Infinitely:** No code duplication across suites. Shared packages must be reused without modification.

## Implementation Plan

We will build the Universal Offline Sync Engine as a **PLATFORM CORE** primitive.

### 1. Client-Side Sync Engine (Dexie + Mutation Queue)
- Create a Dexie database wrapper for the PWA Experience Layer.
- Implement a Mutation Queue to store local changes when offline.
- Implement a background sync manager to process the queue when online.

### 2. Server-Side Sync API (Cloudflare Workers)
- Create a Hono-based API endpoint to receive mutation queues.
- Implement tenant resolution and RBAC for the sync endpoint.

### 3. Server Reconciliation & Conflict Resolution
- Implement optimistic concurrency control using version numbers.
- Define conflict resolution strategies (e.g., `last_write_wins` as specified in the Commerce Architecture Plan).

## Specialist Agents Required
- **Backend Architect:** To design the Cloudflare Workers Sync API and reconciliation logic.
- **Frontend Developer:** To implement the Dexie wrapper and Mutation Queue.
- **Data Engineer:** To design the version control schema for Postgres.

---

*This document serves as the implementation guide for Epic 1, ensuring strict adherence to the WebWaka OS v4 Blueprint.*
