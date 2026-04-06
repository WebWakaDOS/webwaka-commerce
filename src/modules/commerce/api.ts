/**
 * WebWaka — Shared Commerce API Router
 * Aggregates all commerce sub-module routers under /api/commerce/*
 *
 * Mounted sub-paths:
 *   /api/commerce/abandoned-carts    — Abandoned cart recovery
 *   /api/commerce/cmrc_subscriptions      — Subscription cmrc_products (Paystack recurring)
 *   /api/commerce/subscription-plans — Subscription plan management
 *   /api/commerce/gift-cards         — Gift cards & store credit
 *   /api/commerce/flash-sales        — Flash sales engine
 *   /api/commerce/bundles            — Product bundles
 *   /api/commerce/purchase-cmrc_orders    — PO generator
 *   /api/commerce/commissions        — Staff commission tracking
 *   /api/commerce/segmentation       — Customer segmentation (RFM)
 *   /api/commerce/dynamic-pricing    — Dynamic pricing rules
 *   /api/commerce/whatsapp           — WhatsApp commerce bot
 *   /api/commerce/warehouses         — Multi-warehouse management
 */

import { Hono } from 'hono';
import type { Env } from '../../worker';

import { abandonedCartRouter } from './abandoned-cart';
import { subscriptionsRouter } from './cmrc_subscriptions';
import { giftCardsRouter } from './gift-cards';
import { flashSalesRouter } from './flash-sales';
import { bundlesRouter } from './bundles';
import { purchaseOrdersRouter } from './purchase-cmrc_orders';
import { commissionsRouter } from './commissions';
import { segmentationRouter } from './segmentation';
import { dynamicPricingRouter } from './dynamic-pricing';
import { whatsappBotRouter } from './whatsapp-bot';
import { warehouseRouter } from './multi-warehouse';

export const commerceRouter = new Hono<{ Bindings: Env }>();

commerceRouter.route('/abandoned-carts', abandonedCartRouter);
commerceRouter.route('/cmrc_subscriptions', subscriptionsRouter);
commerceRouter.route('/gift-cards', giftCardsRouter);
commerceRouter.route('/flash-sales', flashSalesRouter);
commerceRouter.route('/bundles', bundlesRouter);
commerceRouter.route('/purchase-cmrc_orders', purchaseOrdersRouter);
commerceRouter.route('/commissions', commissionsRouter);
commerceRouter.route('/segmentation', segmentationRouter);
commerceRouter.route('/dynamic-pricing', dynamicPricingRouter);
commerceRouter.route('/whatsapp', whatsappBotRouter);
commerceRouter.route('/warehouses', warehouseRouter);

/** GET /api/commerce/health — Commerce module health check */
commerceRouter.get('/health', (c) =>
  c.json({
    success: true,
    data: {
      module: 'commerce',
      version: '4.2.0',
      sub_modules: [
        'abandoned-carts', 'cmrc_subscriptions', 'gift-cards', 'flash-sales',
        'bundles', 'purchase-cmrc_orders', 'commissions', 'segmentation',
        'dynamic-pricing', 'whatsapp', 'warehouses',
      ],
      timestamp: new Date().toISOString(),
    },
  })
);
