/**
 * WebWaka — Multi-Warehouse Routing
 * Implementation Plan §3 Item 14 — Multi-Warehouse Management
 *
 * Route cmrc_orders to the nearest warehouse using haversine distance calculation.
 * Each warehouse has:
 *   - GPS coordinates (lat/lng)
 *   - Its own stock levels (separate from global inventory)
 *   - Operational hours
 *   - Delivery zones
 *
 * Routing logic:
 *   1. Filter warehouses that have sufficient stock for all line items
 *   2. Among eligible warehouses, pick the nearest to customer's delivery address
 *   3. Reserve stock at selected warehouse (pending until order confirmed)
 *
 * Invariants: Multi-tenancy, Nigeria-First, Build Once Use Infinitely
 */

import { Hono } from 'hono';
import { getTenantId, requireRole } from '@webwaka/core';
import type { Env } from '../../worker';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Warehouse {
  id: string;
  tenantId: string;
  name: string;
  code: string;                    // e.g. "LGS-01", "ABJ-01"
  address: string;
  lga: string;
  state: string;
  lat: number;
  lng: number;
  contactPhone?: string;
  isActive: boolean;
  operatingHoursJson?: string;     // JSON: { "mon-fri": "08:00-20:00", "sat": "09:00-18:00" }
  createdAt: number;
}

export interface WarehouseStockLevel {
  warehouseId: string;
  productId: string;
  tenantId: string;
  quantityOnHand: number;
  quantityReserved: number;
  quantityAvailable: number;      // on_hand - reserved
  reorderPoint: number;
  updatedAt: number;
}

export interface WarehouseRoutingResult {
  warehouseId: string;
  warehouseName: string;
  warehouseCode: string;
  distanceKm: number;
  allItemsAvailable: boolean;
  stockShortfalls: Array<{ productId: string; needed: number; available: number }>;
}

// ─── Haversine distance ───────────────────────────────────────────────────────

const EARTH_RADIUS_KM = 6371;

/**
 * Compute great-circle distance between two lat/lng points in kilometres.
 */
export function haversineKm(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

// ─── Routing logic ────────────────────────────────────────────────────────────

/**
 * Rank warehouses by distance to customer and stock availability.
 * Returns all warehouses sorted: first eligible (all items in stock) by distance,
 * then ineligible (partial stock) by distance.
 */
export async function routeToWarehouse(
  db: D1Database,
  tenantId: string,
  customerLat: number,
  customerLng: number,
  lineItems: Array<{ productId: string; quantity: number }>,
): Promise<WarehouseRoutingResult[]> {
  interface WarehouseRow {
    id: string; name: string; code: string; lat: number; lng: number; is_active: number;
  }

  let warehouses: WarehouseRow[] = [];
  try {
    const { results } = await db.prepare(
      'SELECT id, name, code, lat, lng FROM warehouses WHERE tenant_id = ? AND is_active = 1'
    ).bind(tenantId).all<WarehouseRow>();
    warehouses = results;
  } catch {
    return [];
  }

  const results: WarehouseRoutingResult[] = [];

  for (const wh of warehouses) {
    const distanceKm = haversineKm(customerLat, customerLng, wh.lat, wh.lng);
    const shortfalls: WarehouseRoutingResult['stockShortfalls'] = [];

    for (const item of lineItems) {
      let available = 0;
      try {
        const row = await db.prepare(
          `SELECT quantity_on_hand - quantity_reserved as available
           FROM warehouse_stock WHERE warehouse_id = ? AND product_id = ? AND tenant_id = ?`
        ).bind(wh.id, item.productId, tenantId).first<{ available: number }>();
        available = row?.available ?? 0;
      } catch { /* no-op */ }

      if (available < item.quantity) {
        shortfalls.push({ productId: item.productId, needed: item.quantity, available });
      }
    }

    results.push({
      warehouseId: wh.id,
      warehouseName: wh.name,
      warehouseCode: wh.code,
      distanceKm: Math.round(distanceKm * 10) / 10,
      allItemsAvailable: shortfalls.length === 0,
      stockShortfalls: shortfalls,
    });
  }

  // Sort: eligible first (by distance), then ineligible (by distance)
  results.sort((a, b) => {
    if (a.allItemsAvailable !== b.allItemsAvailable) {
      return a.allItemsAvailable ? -1 : 1;
    }
    return a.distanceKm - b.distanceKm;
  });

  return results;
}

/**
 * Reserve stock at a warehouse for an order.
 * Call this after selecting the routing warehouse, before payment confirmation.
 */
export async function reserveWarehouseStock(
  db: D1Database,
  tenantId: string,
  warehouseId: string,
  lineItems: Array<{ productId: string; quantity: number }>,
): Promise<boolean> {
  const now = Date.now();
  try {
    for (const item of lineItems) {
      await db.prepare(
        `UPDATE warehouse_stock
         SET quantity_reserved = quantity_reserved + ?, updated_at = ?
         WHERE warehouse_id = ? AND product_id = ? AND tenant_id = ?
           AND (quantity_on_hand - quantity_reserved) >= ?`
      ).bind(item.quantity, now, warehouseId, item.productId, tenantId, item.quantity).run();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Deduct stock after order is confirmed (from reserved → fulfilled).
 */
export async function fulfillWarehouseStock(
  db: D1Database,
  tenantId: string,
  warehouseId: string,
  lineItems: Array<{ productId: string; quantity: number }>,
): Promise<boolean> {
  const now = Date.now();
  try {
    for (const item of lineItems) {
      await db.prepare(
        `UPDATE warehouse_stock
         SET quantity_on_hand = quantity_on_hand - ?,
             quantity_reserved = quantity_reserved - ?,
             updated_at = ?
         WHERE warehouse_id = ? AND product_id = ? AND tenant_id = ?`
      ).bind(item.quantity, item.quantity, now, warehouseId, item.productId, tenantId).run();
    }
    return true;
  } catch {
    return false;
  }
}

// ─── Hono router ──────────────────────────────────────────────────────────────

export const warehouseRouter = new Hono<{ Bindings: Env }>();

warehouseRouter.use('*', async (c, next) => {
  if (!getTenantId(c)) return c.json({ success: false, error: 'Missing x-tenant-id' }, 400);
  await next();
});

/** GET /api/commerce/warehouses */
warehouseRouter.get('/', async (c) => {
  const tenantId = getTenantId(c)!;
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, name, code, address, lga, state, lat, lng, contact_phone, is_active, created_at
       FROM warehouses WHERE tenant_id = ? ORDER BY name ASC`
    ).bind(tenantId).all();
    return c.json({ success: true, data: results });
  } catch { return c.json({ success: true, data: [] }); }
});

/** POST /api/commerce/warehouses — create a warehouse */
warehouseRouter.post(
  '/',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']),
  async (c) => {
    const tenantId = getTenantId(c)!;
    const body = await c.req.json<{
      name: string; code: string; address: string; lga: string; state: string;
      lat: number; lng: number; contact_phone?: string;
    }>();

    if (!body.name || !body.code || body.lat === undefined || body.lng === undefined) {
      return c.json({ success: false, error: 'name, code, lat, lng required' }, 400);
    }

    const id = `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    try {
      await c.env.DB.prepare(
        `INSERT INTO warehouses
           (id, tenant_id, name, code, address, lga, state, lat, lng, contact_phone, is_active, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`
      ).bind(
        id, tenantId, body.name, body.code, body.address ?? '', body.lga ?? '', body.state ?? '',
        body.lat, body.lng, body.contact_phone ?? null, now,
      ).run();
      return c.json({ success: true, data: { id, code: body.code } }, 201);
    } catch (err) {
      console.error('[Warehouse] create error:', err);
      return c.json({ success: false, error: 'Failed to create warehouse' }, 500);
    }
  }
);

/** POST /api/commerce/warehouses/route — find nearest warehouse with stock */
warehouseRouter.post('/route', async (c) => {
  const tenantId = getTenantId(c)!;
  const body = await c.req.json<{
    customer_lat: number; customer_lng: number;
    line_items: Array<{ product_id: string; quantity: number }>;
  }>();

  if (body.customer_lat === undefined || body.customer_lng === undefined) {
    return c.json({ success: false, error: 'customer_lat and customer_lng required' }, 400);
  }
  if (!body.line_items?.length) {
    return c.json({ success: false, error: 'line_items required' }, 400);
  }

  const ranked = await routeToWarehouse(
    c.env.DB, tenantId,
    body.customer_lat, body.customer_lng,
    body.line_items.map((i) => ({ productId: i.product_id, quantity: i.quantity })),
  );

  return c.json({
    success: true,
    data: {
      recommended: ranked[0] ?? null,
      all_warehouses: ranked,
    },
  });
});

/** GET /api/commerce/warehouses/:id/stock — stock levels at a warehouse */
warehouseRouter.get('/:id/stock', async (c) => {
  const tenantId = getTenantId(c)!;
  const warehouseId = c.req.param('id');
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT ws.product_id, p.name as product_name, p.sku,
              ws.quantity_on_hand, ws.quantity_reserved,
              (ws.quantity_on_hand - ws.quantity_reserved) as quantity_available,
              ws.reorder_point, ws.updated_at
       FROM warehouse_stock ws
       JOIN cmrc_products p ON p.id = ws.product_id
       WHERE ws.warehouse_id = ? AND ws.tenant_id = ?
       ORDER BY quantity_available ASC`
    ).bind(warehouseId, tenantId).all();
    return c.json({ success: true, data: results });
  } catch { return c.json({ success: true, data: [] }); }
});

/** PUT /api/commerce/warehouses/:id/stock/:productId — upsert stock level */
warehouseRouter.put(
  '/:id/stock/:productId',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']),
  async (c) => {
    const tenantId = getTenantId(c)!;
    const warehouseId = c.req.param('id');
    const productId = c.req.param('productId');
    const body = await c.req.json<{ quantity_on_hand: number; reorder_point?: number }>();
    const now = Date.now();
    try {
      await c.env.DB.prepare(
        `INSERT INTO warehouse_stock
           (warehouse_id, product_id, tenant_id, quantity_on_hand, quantity_reserved, reorder_point, updated_at)
         VALUES (?,?,?,?,0,?,?)
         ON CONFLICT (warehouse_id, product_id) DO UPDATE SET
           quantity_on_hand = excluded.quantity_on_hand,
           reorder_point = excluded.reorder_point,
           updated_at = excluded.updated_at`
      ).bind(warehouseId, productId, tenantId, body.quantity_on_hand, body.reorder_point ?? 5, now).run();
      return c.json({ success: true, data: { warehouse_id: warehouseId, product_id: productId } });
    } catch (err) {
      console.error('[Warehouse] stock update error:', err);
      return c.json({ success: false, error: 'Stock update failed' }, 500);
    }
  }
);
