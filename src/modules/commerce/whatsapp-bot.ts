/**
 * WebWaka — WhatsApp Commerce Bot
 * Implementation Plan §3 Item 20 — WhatsApp Commerce Bot
 *
 * Allow customers to browse and order directly via WhatsApp using Termii's
 * WhatsApp Business API. Implements a stateful conversation flow:
 *
 *   1. Customer sends "Hi" or "Menu" → bot replies with product catalog
 *   2. Customer sends product number → bot shows item details + "Add to cart?"
 *   3. Customer confirms → item added to session cart
 *   4. Customer sends "Checkout" → bot sends payment link (Paystack)
 *   5. Customer sends "Track <order_id>" → bot replies with order status
 *   6. Customer sends "Help" → bot replies with available commands
 *
 * Session state stored in Cloudflare KV (SESSIONS_KV) with a 30-minute TTL.
 *
 * Invariants: Nigeria-First (Termii + Paystack), NDPR, Multi-tenancy
 */

import { Hono } from 'hono';
import { getTenantId } from '@webwaka/core';
import type { Env } from '../../worker';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WaBotSession {
  phone: string;
  tenantId: string;
  state: 'IDLE' | 'BROWSING' | 'ITEM_DETAIL' | 'CHECKOUT';
  cart: Array<{ productId: string; productName: string; quantity: number; priceKobo: number }>;
  lastProductListPage: number;
  lastSelectedProductId?: string;
  updatedAt: number;
}

export interface WaMessage {
  phone: string;       // recipient's phone (international format e.g. 2348012345678)
  message: string;
  channel?: 'whatsapp' | 'dnd';
}

export interface IncomingWaMessage {
  phone: string;       // sender's phone
  text: string;        // message body
  tenantId?: string;   // resolved from webhook routing
}

// ─── Session management ───────────────────────────────────────────────────────

const SESSION_TTL_SECONDS = 30 * 60; // 30 minutes

async function getSession(
  kv: KVNamespace | undefined,
  phone: string,
  tenantId: string,
): Promise<WaBotSession> {
  if (!kv) return newSession(phone, tenantId);
  const key = `wabot:${tenantId}:${phone}`;
  try {
    const raw = await kv.get(key);
    if (raw) return JSON.parse(raw) as WaBotSession;
  } catch { /* KV unavailable */ }
  return newSession(phone, tenantId);
}

async function saveSession(
  kv: KVNamespace | undefined,
  session: WaBotSession,
): Promise<void> {
  if (!kv) return;
  const key = `wabot:${session.tenantId}:${session.phone}`;
  try {
    await kv.put(key, JSON.stringify(session), { expirationTtl: SESSION_TTL_SECONDS });
  } catch { /* non-fatal */ }
}

function newSession(phone: string, tenantId: string): WaBotSession {
  return {
    phone, tenantId,
    state: 'IDLE',
    cart: [],
    lastProductListPage: 0,
    updatedAt: Date.now(),
  };
}

// ─── Response builders ────────────────────────────────────────────────────────

function formatKoboToNaira(kobo: number): string {
  return `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
}

function buildMenuMessage(
  products: Array<{ id: string; name: string; price: number; quantity: number }>,
  page: number,
  perPage = 5,
): string {
  const start = page * perPage;
  const slice = products.slice(start, start + perPage);
  if (!slice.length) return '🛒 No more products. Reply *CART* to view your cart.';

  const lines = slice.map(
    (p, i) => `*${start + i + 1}.* ${p.name} — ${formatKoboToNaira(p.price)}${p.quantity <= 0 ? ' _(Out of stock)_' : ''}`,
  );

  const hasMore = products.length > start + perPage;
  const nav = hasMore ? '\nReply *MORE* for next page.' : '';

  return `🛍️ *WebWaka Store — Product Menu*\n\n${lines.join('\n')}\n\n${nav}\nReply a number to see details, *CART* to view cart, or *HELP* for commands.`;
}

function buildItemDetailMessage(
  product: { name: string; description?: string | null; price: number; quantity: number },
): string {
  const stock = product.quantity > 0 ? `✅ In stock (${product.quantity} available)` : '❌ Out of stock';
  const desc = product.description ? `\n_${product.description}_` : '';
  return `📦 *${product.name}*${desc}\n💰 ${formatKoboToNaira(product.price)}\n${stock}\n\nReply *ADD* to add to cart, *MENU* to go back, or *CART* to view cart.`;
}

function buildCartMessage(
  cart: WaBotSession['cart'],
): string {
  if (!cart.length) return '🛒 Your cart is empty. Reply *MENU* to browse products.';
  const lines = cart.map((i) => `• ${i.productName} × ${i.quantity} = ${formatKoboToNaira(i.priceKobo * i.quantity)}`);
  const total = cart.reduce((s, i) => s + i.priceKobo * i.quantity, 0);
  return `🛒 *Your Cart*\n\n${lines.join('\n')}\n\n*Total: ${formatKoboToNaira(total)}*\n\nReply *CHECKOUT* to pay, *CLEAR* to empty cart, or *MENU* to continue shopping.`;
}

const HELP_MESSAGE = `🤖 *WebWaka Bot Commands*\n
*MENU* — Browse products
*<number>* — View product details (e.g. "3")
*ADD* — Add current item to cart
*CART* — View your cart
*MORE* — Next page of products
*CHECKOUT* — Proceed to payment
*TRACK <order_id>* — Track an order
*CLEAR* — Empty your cart
*HELP* — Show this message`;

// ─── Message processing ───────────────────────────────────────────────────────

/**
 * Process an incoming WhatsApp message and return the reply text.
 * All side effects (KV session updates, DB reads) are performed here.
 */
export async function processWhatsAppMessage(
  db: D1Database,
  kv: KVNamespace | undefined,
  msg: IncomingWaMessage,
): Promise<string> {
  const tenantId = msg.tenantId ?? '';
  const phone = msg.phone.replace(/\D/g, ''); // digits only
  const text = msg.text.trim().toUpperCase();

  let session = await getSession(kv, phone, tenantId);

  let reply = '';

  // ── HELP ──────────────────────────────────────────────────────────────────
  if (text === 'HELP' || text === 'HI' || text === 'HELLO') {
    session.state = 'IDLE';
    reply = HELP_MESSAGE;
  }

  // ── MENU ─────────────────────────────────────────────────────────────────
  else if (text === 'MENU' || text === 'START') {
    session.state = 'BROWSING';
    session.lastProductListPage = 0;
    interface ProductRow { id: string; name: string; price: number; quantity: number }
    let products: ProductRow[] = [];
    try {
      const { results } = await db.prepare(
        `SELECT id, name, price, quantity FROM products
         WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL
         ORDER BY name ASC LIMIT 50`
      ).bind(tenantId).all<ProductRow>();
      products = results;
    } catch { /* DB unavailable */ }
    reply = buildMenuMessage(products, 0);
  }

  // ── MORE (next page) ──────────────────────────────────────────────────────
  else if (text === 'MORE' && session.state === 'BROWSING') {
    session.lastProductListPage++;
    interface ProductRow { id: string; name: string; price: number; quantity: number }
    let products: ProductRow[] = [];
    try {
      const { results } = await db.prepare(
        'SELECT id, name, price, quantity FROM products WHERE tenant_id = ? AND is_active = 1 ORDER BY name ASC LIMIT 50'
      ).bind(tenantId).all<ProductRow>();
      products = results;
    } catch { /* no-op */ }
    reply = buildMenuMessage(products, session.lastProductListPage);
  }

  // ── Number selection ──────────────────────────────────────────────────────
  else if (/^\d+$/.test(text) && session.state === 'BROWSING') {
    const idx = parseInt(text, 10) - 1;
    interface ProductRow { id: string; name: string; description: string | null; price: number; quantity: number }
    let products: ProductRow[] = [];
    try {
      const { results } = await db.prepare(
        'SELECT id, name, description, price, quantity FROM products WHERE tenant_id = ? AND is_active = 1 ORDER BY name ASC LIMIT 50'
      ).bind(tenantId).all<ProductRow>();
      products = results;
    } catch { /* no-op */ }

    const product = products[idx];
    if (!product) {
      reply = `❌ Invalid selection. Please reply with a number between 1 and ${products.length}.`;
    } else {
      session.state = 'ITEM_DETAIL';
      session.lastSelectedProductId = product.id;
      reply = buildItemDetailMessage(product);
    }
  }

  // ── ADD to cart ───────────────────────────────────────────────────────────
  else if (text === 'ADD' && session.state === 'ITEM_DETAIL' && session.lastSelectedProductId) {
    interface ProductRow { id: string; name: string; price: number; quantity: number }
    const product = await db.prepare(
      'SELECT id, name, price, quantity FROM products WHERE id = ? AND tenant_id = ?'
    ).bind(session.lastSelectedProductId, tenantId).first<ProductRow>().catch(() => null);

    if (!product || product.quantity <= 0) {
      reply = '❌ Sorry, this item is out of stock.';
    } else {
      const existing = session.cart.find((i) => i.productId === product.id);
      if (existing) {
        existing.quantity++;
      } else {
        session.cart.push({ productId: product.id, productName: product.name, quantity: 1, priceKobo: product.price });
      }
      session.state = 'BROWSING';
      reply = `✅ *${product.name}* added to cart!\n\n${buildCartMessage(session.cart)}`;
    }
  }

  // ── CART ─────────────────────────────────────────────────────────────────
  else if (text === 'CART') {
    reply = buildCartMessage(session.cart);
  }

  // ── CLEAR cart ────────────────────────────────────────────────────────────
  else if (text === 'CLEAR') {
    session.cart = [];
    session.state = 'IDLE';
    reply = '🗑️ Your cart has been cleared. Reply *MENU* to start shopping.';
  }

  // ── CHECKOUT ─────────────────────────────────────────────────────────────
  else if (text === 'CHECKOUT') {
    if (!session.cart.length) {
      reply = '🛒 Your cart is empty. Reply *MENU* to shop first.';
    } else {
      const total = session.cart.reduce((s, i) => s + i.priceKobo * i.quantity, 0);
      const checkoutLink = `https://store.webwaka.com/checkout?phone=${phone}&t=${tenantId}`;
      session.state = 'CHECKOUT';
      reply = `💳 *Checkout*\n\nTotal: ${formatKoboToNaira(total)}\n\nClick to complete payment:\n${checkoutLink}\n\nYour cart will be held for 30 minutes.`;
    }
  }

  // ── TRACK order ───────────────────────────────────────────────────────────
  else if (text.startsWith('TRACK ')) {
    const orderId = text.replace('TRACK ', '').trim();
    interface OrderRow { id: string; order_status: string; total_amount: number; created_at: number }
    const order = await db.prepare(
      'SELECT id, order_status, total_amount, created_at FROM orders WHERE id = ? AND tenant_id = ?'
    ).bind(orderId, tenantId).first<OrderRow>().catch(() => null);

    if (!order) {
      reply = `❌ Order *${orderId}* not found. Please check the order ID and try again.`;
    } else {
      const date = new Date(order.created_at).toLocaleDateString('en-NG');
      reply = `📦 *Order Status*\n\nOrder: ${order.id}\nStatus: ${order.order_status}\nAmount: ${formatKoboToNaira(order.total_amount)}\nDate: ${date}\n\nReply *HELP* for more commands.`;
    }
  }

  // ── Unknown command ───────────────────────────────────────────────────────
  else {
    reply = `I didn't understand that. Reply *HELP* to see available commands.`;
  }

  session.updatedAt = Date.now();
  await saveSession(kv, session);
  return reply;
}

// ─── Outbound SMS/WhatsApp helper ─────────────────────────────────────────────

export async function sendWhatsAppMessage(
  termiiApiKey: string,
  to: string,
  message: string,
): Promise<boolean> {
  try {
    const res = await fetch('https://api.ng.termii.com/api/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to,
        from: 'WebWaka',
        sms: message,
        type: 'unicode',
        channel: 'whatsapp',
        api_key: termiiApiKey,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Hono router ──────────────────────────────────────────────────────────────

export const whatsappBotRouter = new Hono<{ Bindings: Env }>();

/**
 * POST /api/commerce/whatsapp/webhook
 * Termii webhook: receives incoming WhatsApp messages and replies.
 * This endpoint should be registered as the Termii callback URL.
 */
whatsappBotRouter.post('/webhook', async (c) => {
  const tenantId = getTenantId(c) ?? c.req.query('tenant_id') ?? '';
  if (!tenantId) return c.json({ success: false, error: 'tenant_id required' }, 400);

  let body: { to?: string; from?: string; sms?: string; text?: string };
  try {
    body = await c.req.json<typeof body>();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON' }, 400);
  }

  const phone = body.from ?? body.to ?? '';
  const text = body.sms ?? body.text ?? '';
  if (!phone || !text) return c.json({ success: true }); // ignore malformed

  const reply = await processWhatsAppMessage(c.env.DB, c.env.SESSIONS_KV, { phone, text, tenantId });

  // Send reply via Termii
  if (c.env.TERMII_API_KEY) {
    await sendWhatsAppMessage(c.env.TERMII_API_KEY, phone, reply);
  }

  return c.json({ success: true, reply });
});

/** POST /api/commerce/whatsapp/send — manually send a WhatsApp message (admin) */
whatsappBotRouter.post('/send', async (c) => {
  const body = await c.req.json<{ to: string; message: string }>();
  if (!body.to || !body.message) return c.json({ success: false, error: 'to and message required' }, 400);
  const sent = await sendWhatsAppMessage(c.env.TERMII_API_KEY, body.to, body.message);
  return c.json({ success: sent });
});
