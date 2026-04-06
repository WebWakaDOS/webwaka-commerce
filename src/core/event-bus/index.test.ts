/**
 * Event Bus Tests
 *
 * Covers:
 * 1. In-memory EventBusRegistry — used in browser/test contexts
 * 2. publishEvent() — CF Queues-backed producer (mocked queue)
 * 3. registerHandler() + dispatchEvent() — consumer dispatcher
 * 4. eventBusRouter — HTTP API with tenant isolation
 * 5. publishEvent() dev-mode fallback (null queue → in-memory)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  eventBus,
  eventBusRouter,
  EventBusRegistry,
  publishEvent,
  registerHandler,
  dispatchEvent,
  type WebWakaEvent,
  type EventQueue,
} from './index';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<WebWakaEvent> = {}): WebWakaEvent {
  return {
    id: `evt_test_${Date.now()}`,
    tenantId: 'tnt_123',
    type: 'test.event',
    sourceModule: 'test',
    timestamp: Date.now(),
    payload: {},
    ...overrides,
  };
}

function makeMockQueue(): { queue: EventQueue; sentMessages: WebWakaEvent[] } {
  const sentMessages: WebWakaEvent[] = [];
  const queue: EventQueue = {
    send: vi.fn(async (msg: WebWakaEvent) => {
      sentMessages.push(msg);
    }),
  };
  return { queue, sentMessages };
}

// ─── 1. In-Memory EventBusRegistry ───────────────────────────────────────────

describe('EventBusRegistry (in-memory)', () => {
  it('should allow subscribing and publishing events', async () => {
    const bus = new EventBusRegistry();
    const mockHandler = vi.fn();
    bus.subscribe('inventory.updated', mockHandler);

    const event = makeEvent({ type: 'inventory.updated' });
    await bus.publish(event);

    expect(mockHandler).toHaveBeenCalledTimes(1);
    expect(mockHandler).toHaveBeenCalledWith(event);
  });

  it('should call multiple handlers for the same event type', async () => {
    const bus = new EventBusRegistry();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.subscribe('order.created', h1);
    bus.subscribe('order.created', h2);

    await bus.publish(makeEvent({ type: 'order.created' }));

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('should not call handlers for a different event type', async () => {
    const bus = new EventBusRegistry();
    const mockHandler = vi.fn();
    bus.subscribe('payment.completed', mockHandler);

    await bus.publish(makeEvent({ type: 'order.created' }));
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it('should not throw if a handler throws — allSettled semantics', async () => {
    const bus = new EventBusRegistry();
    bus.subscribe('bad.event', async () => { throw new Error('handler error'); });

    await expect(bus.publish(makeEvent({ type: 'bad.event' }))).resolves.not.toThrow();
  });

  it('global eventBus singleton should work for local-context cmrc_subscriptions', async () => {
    const mockHandler = vi.fn();
    eventBus.subscribe('inventory.updated', mockHandler);

    const event = makeEvent({ type: 'inventory.updated' });
    await eventBus.publish(event);

    expect(mockHandler).toHaveBeenCalledWith(event);
  });
});

// ─── 2. publishEvent() — CF Queues producer ───────────────────────────────────

describe('publishEvent() — CF Queues producer', () => {
  it('should call queue.send() with the event', async () => {
    const { queue, sentMessages } = makeMockQueue();
    const event = makeEvent({ type: 'order.created', tenantId: 'tnt_abc' });

    await publishEvent(queue, event);

    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(sentMessages[0]).toEqual(event);
  });

  it('should preserve tenantId on the sent message', async () => {
    const { queue, sentMessages } = makeMockQueue();
    const event = makeEvent({ tenantId: 'tnt_xyz', type: 'payment.completed' });

    await publishEvent(queue, event);

    expect(sentMessages[0]?.tenantId).toBe('tnt_xyz');
  });

  it('should fall back to in-memory eventBus when queue is null (dev mode)', async () => {
    const devBus = new EventBusRegistry();
    const mockHandler = vi.fn();
    devBus.subscribe('shift.closed', mockHandler);

    // Temporarily replace global eventBus.publish for this test
    const originalPublish = eventBus.publish.bind(eventBus);
    eventBus.subscribe('shift.closed', mockHandler);

    const event = makeEvent({ type: 'shift.closed' });
    await publishEvent(null, event);

    // Handler should have been called via the in-memory bus fallback
    expect(mockHandler).toHaveBeenCalledWith(event);

    // Restore (subscribe is additive — harmless leftover)
    void originalPublish;
  });

  it('should fall back to in-memory eventBus when queue is undefined (dev mode)', async () => {
    const mockHandler = vi.fn();
    eventBus.subscribe('vendor.kyc.submitted', mockHandler);

    const event = makeEvent({ type: 'vendor.kyc.submitted' });
    await publishEvent(undefined, event);

    expect(mockHandler).toHaveBeenCalledWith(event);
  });
});

// ─── 3. registerHandler() + dispatchEvent() — consumer dispatcher ─────────────

describe('registerHandler() + dispatchEvent()', () => {
  beforeEach(() => {
    // Reset consumer handlers between tests by reimporting is not possible
    // in Vitest without module reload; we use unique event types per test instead.
  });

  it('should dispatch to a registered handler', async () => {
    const mockHandler = vi.fn();
    const uniqueType = `consumer.test.${Date.now()}`;
    registerHandler(uniqueType, mockHandler);

    const event = makeEvent({ type: uniqueType });
    await dispatchEvent(event);

    expect(mockHandler).toHaveBeenCalledTimes(1);
    expect(mockHandler).toHaveBeenCalledWith(event);
  });

  it('should not throw if no handler is registered for the event type', async () => {
    const event = makeEvent({ type: 'unregistered.event.type.xyz' });
    await expect(dispatchEvent(event)).resolves.not.toThrow();
  });

  it('should call all registered handlers for the same event type', async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    const uniqueType = `consumer.multi.${Date.now()}`;
    registerHandler(uniqueType, h1);
    registerHandler(uniqueType, h2);

    await dispatchEvent(makeEvent({ type: uniqueType }));

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('should not throw if a consumer handler throws — allSettled semantics', async () => {
    const uniqueType = `consumer.error.${Date.now()}`;
    registerHandler(uniqueType, async () => { throw new Error('consumer error'); });

    await expect(
      dispatchEvent(makeEvent({ type: uniqueType })),
    ).resolves.not.toThrow();
  });
});

// ─── 4. eventBusRouter — HTTP API with tenant isolation ───────────────────────

describe('eventBusRouter HTTP API', () => {
  it('should reject requests without X-Tenant-ID header', async () => {
    const req = new Request('http://localhost/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await eventBusRouter.fetch(req);
    expect(res.status).toBe(400);
  });

  it('should reject events where tenantId does not match X-Tenant-ID header', async () => {
    const req = new Request('http://localhost/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': 'tnt_123',
      },
      body: JSON.stringify(makeEvent({ tenantId: 'tnt_456' })),
    });

    const res = await eventBusRouter.fetch(req);
    expect(res.status).toBe(403);
    const body = await res.json() as { success: boolean; errors: string[] };
    expect(body.errors[0]).toContain('Tenant ID mismatch');
  });

  it('should publish valid events and return 200', async () => {
    const mockHandler = vi.fn();
    const uniqueType = `http.test.${Date.now()}`;
    eventBus.subscribe(uniqueType, mockHandler);

    const event = makeEvent({ tenantId: 'tnt_123', type: uniqueType });
    const req = new Request('http://localhost/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': 'tnt_123',
      },
      body: JSON.stringify(event),
    });

    const res = await eventBusRouter.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);

    // Allow async publish to settle
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockHandler).toHaveBeenCalledTimes(1);
  });

  it('should return 500 on malformed JSON body', async () => {
    const req = new Request('http://localhost/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': 'tnt_123',
      },
      body: 'not-json{{',
    });

    const res = await eventBusRouter.fetch(req);
    expect(res.status).toBe(500);
  });
});
