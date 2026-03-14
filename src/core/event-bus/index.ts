import { Hono } from 'hono';
import { ApiResponse } from '../sync/server';

// Define standard event payload schema
export interface WebWakaEvent<T = any> {
  id: string;
  tenantId: string;
  type: string; // e.g., 'inventory.updated', 'order.created'
  sourceModule: string;
  timestamp: number;
  payload: T;
}

// Event Handler Interface
export type EventHandler = (event: WebWakaEvent) => Promise<void>;

// The Event Bus Registry
export class EventBusRegistry {
  private handlers: Map<string, EventHandler[]> = new Map();

  // Subscribe to an event
  subscribe(eventType: string, handler: EventHandler) {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, []);
    }
    this.handlers.get(eventType)!.push(handler);
  }

  // Publish an event
  async publish(event: WebWakaEvent): Promise<void> {
    const eventHandlers = this.handlers.get(event.type) || [];
    
    // In a real Cloudflare Workers environment, this would push to a Queue
    // For this implementation, we process them asynchronously
    const promises = eventHandlers.map(async (handler) => {
      try {
        await handler(event);
      } catch (err) {
        // Zero console.log invariant - use platform logger
        // logger.error(`Event handler failed for ${event.type}`, err);
      }
    });

    await Promise.allSettled(promises);
  }
}

// Global Event Bus Instance
export const eventBus = new EventBusRegistry();

// Event Bus API Router (for external modules to publish events)
export const eventBusRouter = new Hono();

eventBusRouter.post('/publish', async (c) => {
  const tenantId = c.req.header('X-Tenant-ID');
  
  if (!tenantId) {
    return c.json<ApiResponse>({ success: false, errors: ['Missing X-Tenant-ID header'] }, 400);
  }

  try {
    const event = await c.req.json<WebWakaEvent>();

    // Enforce multi-tenancy invariant
    if (event.tenantId !== tenantId) {
      return c.json<ApiResponse>({ success: false, errors: ['Tenant ID mismatch'] }, 403);
    }

    // Publish the event
    await eventBus.publish(event);

    return c.json<ApiResponse>({ success: true });
  } catch (error) {
    return c.json<ApiResponse>({ 
      success: false, 
      errors: [error instanceof Error ? error.message : 'Internal Server Error'] 
    }, 500);
  }
});
