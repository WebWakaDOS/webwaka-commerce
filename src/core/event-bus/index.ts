/**
 * WebWaka Platform Event Bus
 *
 * TWO publishing models — choose based on execution context:
 *
 * 1. Server-side (Cloudflare Worker / Hono API handlers):
 *    Use `publishEvent(c.env.COMMERCE_EVENTS, event)`.
 *    Events are enqueued in the Cloudflare Queue and consumed
 *    by the `queue` export in worker.ts — durable, cross-isolate.
 *
 * 2. Client-side / unit tests (browser, Vitest, core.ts modules):
 *    Use `eventBus.publish(event)` via the in-memory `EventBusRegistry`.
 *    Handlers survive only within the same JS context; not suitable for
 *    production cross-request communication.
 *
 * Invariants enforced:
 * - [MTT] tenant_id on every event
 * - [EVT] no direct inter-DB access — all cross-module comms via this bus
 * - [CFD] CF Queues is the production transport
 */

import { Hono } from 'hono';
import type { ApiResponse } from '../sync/server';

// ─── Event Schema ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface WebWakaEvent<T = any> {
  id: string;
  tenantId: string;
  type: string;
  sourceModule: string;
  timestamp: number;
  payload: T;
}

// ─── CF Queue interface (compatible with Cloudflare's Queue<T>) ───────────────
// Typed as a minimal interface so the module has no hard dep on
// @cloudflare/workers-types in test/browser contexts.
export interface EventQueue {
  send(message: WebWakaEvent): Promise<void>;
}

// ─── CF Queues Publisher (production / Worker context) ────────────────────────

/**
 * Publish an event to the Cloudflare Queue.
 * If `queue` is null/undefined (local dev, unit tests), the event falls back
 * to the in-memory `eventBus` so tests and `wrangler dev` still work.
 *
 * Usage (Hono handler):
 *   await publishEvent(c.env.COMMERCE_EVENTS, { id, tenantId, type, ... });
 */
export async function publishEvent(
  queue: EventQueue | null | undefined,
  event: WebWakaEvent,
): Promise<void> {
  if (queue) {
    await queue.send(event);
  } else {
    // Dev-mode fallback: route through in-memory bus so local handlers fire
    await eventBus.publish(event);
  }
}

// ─── CF Queues Consumer Dispatcher ───────────────────────────────────────────
// Handlers are invoked from worker.ts `queue` export.
// Each handler must be idempotent — CF Queues delivers at-least-once.

export type EventHandler = (event: WebWakaEvent) => Promise<void>;

const consumerHandlers = new Map<string, EventHandler[]>();

/**
 * Register a server-side consumer for an event type.
 * Call this at module initialisation in handlers/index.ts.
 */
export function registerHandler(eventType: string, handler: EventHandler): void {
  if (!consumerHandlers.has(eventType)) {
    consumerHandlers.set(eventType, []);
  }
  consumerHandlers.get(eventType)!.push(handler);
}

/**
 * Dispatch a consumed event from the CF Queue batch.
 * Called by worker.ts `queue` export.
 */
export async function dispatchEvent(event: WebWakaEvent): Promise<void> {
  const handlers = consumerHandlers.get(event.type) ?? [];
  await Promise.allSettled(handlers.map((h) => h(event)));
}

// ─── In-Memory Event Bus (local dev / browser / unit tests) ──────────────────

export class EventBusRegistry {
  private handlers: Map<string, EventHandler[]> = new Map();

  subscribe(eventType: string, handler: EventHandler): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, []);
    }
    this.handlers.get(eventType)!.push(handler);
  }

  async publish(event: WebWakaEvent): Promise<void> {
    const handlers = this.handlers.get(event.type) ?? [];
    await Promise.allSettled(handlers.map((h) => h(event)));
  }
}

/**
 * In-memory singleton.
 * Suitable for: unit tests, wrangler dev fallback, browser-side usage.
 * NOT suitable for: cross-request communication in production CF Workers.
 */
export const eventBus = new EventBusRegistry();

// ─── HTTP Router (internal publish endpoint — tenant-isolated) ────────────────

export const eventBusRouter = new Hono();

eventBusRouter.post('/publish', async (c) => {
  const tenantId = c.req.header('X-Tenant-ID');

  if (!tenantId) {
    return c.json<ApiResponse>({ success: false, errors: ['Missing X-Tenant-ID header'] }, 400);
  }

  try {
    const event = await c.req.json<WebWakaEvent>();

    if (event.tenantId !== tenantId) {
      return c.json<ApiResponse>({ success: false, errors: ['Tenant ID mismatch'] }, 403);
    }

    await eventBus.publish(event);
    return c.json<ApiResponse>({ success: true });
  } catch (error) {
    return c.json<ApiResponse>(
      {
        success: false,
        errors: [error instanceof Error ? error.message : 'Internal Server Error'],
      },
      500,
    );
  }
});
