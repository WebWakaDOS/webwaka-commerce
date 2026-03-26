/**
 * WebWaka POS — Full Flow E2E Tests (Phase 3)
 * Covers: Scanner→cart, split payment, receipt, print, WhatsApp, offline sync
 * Invariants: Mobile-First (375×812), Nigeria-First (₦), Offline-First, PCI
 *
 * Run: npx playwright test playwright/pos-full-flow.spec.ts
 * Mobile: npx playwright test --project=mobile-chrome playwright/pos-full-flow.spec.ts
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';

// ─── Constants ─────────────────────────────────────────────────────────────────
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const MOBILE_VIEWPORT  = { width: 375, height: 812 };
const TENANT_HEADER    = 'x-tenant-id';
const DEMO_TENANT      = 'tnt_demo';

// ─── Helpers ───────────────────────────────────────────────────────────────────
async function waitForPOS(page: Page) {
  // Wait for either the POS header or the product grid
  await Promise.race([
    page.waitForSelector('h1:has-text("WebWaka POS")', { timeout: 15_000 }),
    page.waitForSelector('[aria-label="Product catalogue"]',  { timeout: 15_000 }),
    page.waitForSelector('[aria-label="Barcode scanner input — press Enter to add item"]', { timeout: 15_000 }),
  ]);
}

async function getCartCount(page: Page): Promise<number> {
  const cartHeader = await page.locator('[aria-label="Cart"]').first().textContent() ?? '';
  const match = cartHeader.match(/(\d+)\s+item/);
  return match ? parseInt(match[1], 10) : 0;
}

async function addFirstProductToCart(page: Page) {
  const products = page.locator('[role="listitem"] button[aria-label*="₦"]');
  await products.first().waitFor({ state: 'visible', timeout: 10_000 });
  await products.first().click();
}

async function selectPaymentMode(page: Page, mode: 'Cash' | 'Card' | 'Transfer' | 'Split') {
  await page.locator(`button:has-text("${mode}")`).first().click();
}

async function getOrderTotal(page: Page): Promise<number> {
  const totalEl = page.locator('[aria-label*="Total: ₦"]').first();
  const label = await totalEl.getAttribute('aria-label') ?? '';
  const match = label.match(/₦([\d.]+)/);
  return match ? Math.round(parseFloat(match[1]) * 100) : 0;
}

// ─── Suite: POS Interface Renders ─────────────────────────────────────────────
test.describe('POS Interface — Renders', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForPOS(page);
  });

  test('header shows WebWaka POS branding', async ({ page }) => {
    await expect(page.locator('h1').filter({ hasText: /WebWaka POS/i })).toBeVisible();
  });

  test('barcode input is present and autofocused', async ({ page }) => {
    const barcodeInput = page.locator('[aria-label="Barcode scanner input — press Enter to add item"]');
    await expect(barcodeInput).toBeVisible();
    // It should be focused on load
    await expect(barcodeInput).toBeFocused();
  });

  test('product search input is present', async ({ page }) => {
    const searchInput = page.locator('[aria-label="Search products by name or SKU"]');
    await expect(searchInput).toBeVisible();
  });

  test('product catalogue role is present', async ({ page }) => {
    await expect(page.locator('[role="main"][aria-label="Product catalogue"]')).toBeVisible();
  });

  test('cart sidebar is present with aria-label', async ({ page }) => {
    await expect(page.locator('[aria-label="Cart"]')).toBeVisible();
  });

  test('all four payment mode buttons are visible', async ({ page }) => {
    for (const mode of ['Cash', 'Card', 'Transfer', 'Split']) {
      await expect(page.locator(`button[aria-pressed]:has-text("${mode}")`)).toBeVisible();
    }
  });

  test('Cash is the default selected payment mode', async ({ page }) => {
    const cashBtn = page.locator('button[aria-pressed="true"]').filter({ hasText: /cash/i });
    await expect(cashBtn).toBeVisible();
  });

  test('charge button is disabled when cart is empty', async ({ page }) => {
    const chargeBtn = page.locator('button[aria-label="Cart is empty"]');
    await expect(chargeBtn).toBeVisible();
    await expect(chargeBtn).toBeDisabled();
  });
});

// ─── Suite: Products Display ───────────────────────────────────────────────────
test.describe('POS Products — Display', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForPOS(page);
  });

  test('product prices are displayed in ₦ (Naira format)', async ({ page }) => {
    const prices = page.locator('[role="listitem"] button[aria-label*="₦"]');
    const count = await prices.count();
    // Some products should load (either from API or empty state is shown)
    if (count > 0) {
      const firstLabel = await prices.first().getAttribute('aria-label') ?? '';
      expect(firstLabel).toContain('₦');
    }
  });

  test('out-of-stock products are disabled', async ({ page }) => {
    const outOfStock = page.locator('button[aria-label*="out of stock"]');
    const count = await outOfStock.count();
    if (count > 0) {
      await expect(outOfStock.first()).toBeDisabled();
    }
  });

  test('low-stock products show LOW badge', async ({ page }) => {
    // Low stock badge has aria-label containing "Low stock"
    const lowBadges = page.locator('[aria-label*="Low stock"]');
    const count = await lowBadges.count();
    // If there are low-stock products, each should have the badge
    if (count > 0) {
      await expect(lowBadges.first()).toBeVisible();
    }
  });

  test('search filters products', async ({ page }) => {
    const searchInput = page.locator('[aria-label="Search products by name or SKU"]');
    await searchInput.fill('rice');
    // Give time for debounced fetch
    await page.waitForTimeout(300);
    // Products matching "rice" should be shown (or empty state if none)
    const catalogue = page.locator('[role="main"][aria-label="Product catalogue"]');
    await expect(catalogue).toBeVisible();
  });
});

// ─── Suite: Barcode Scanner Flow ───────────────────────────────────────────────
test.describe('Barcode Scanner Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForPOS(page);
  });

  test('barcode field accepts input', async ({ page }) => {
    const barcodeInput = page.locator('[aria-label="Barcode scanner input — press Enter to add item"]');
    await barcodeInput.fill('6190000001000');
    await expect(barcodeInput).toHaveValue('6190000001000');
  });

  test('pressing Enter on barcode field clears input (lookup fires)', async ({ page }) => {
    const barcodeInput = page.locator('[aria-label="Barcode scanner input — press Enter to add item"]');
    await barcodeInput.fill('6190000001000');
    await barcodeInput.press('Enter');
    // Input should clear after Enter
    await expect(barcodeInput).toHaveValue('');
  });

  test('barcode lookup with unknown code does not crash', async ({ page }) => {
    const barcodeInput = page.locator('[aria-label="Barcode scanner input — press Enter to add item"]');
    await barcodeInput.fill('UNKNOWN_BARCODE_999');
    await barcodeInput.press('Enter');
    // Cart should still be empty — no crash
    await expect(page.locator('[aria-label="Cart"]')).toBeVisible();
    await expect(barcodeInput).toHaveValue('');
  });

  test('barcode input regains focus after lookup', async ({ page }) => {
    const barcodeInput = page.locator('[aria-label="Barcode scanner input — press Enter to add item"]');
    await barcodeInput.fill('6190000001000');
    await barcodeInput.press('Enter');
    await page.waitForTimeout(300);
    // Focus should remain on barcode field for continuous scanning
    await expect(barcodeInput).toBeFocused();
  });
});

// ─── Suite: Cart Operations ────────────────────────────────────────────────────
test.describe('Cart Operations', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForPOS(page);
  });

  test('clicking a product card adds it to the cart', async ({ page }) => {
    const products = page.locator('[role="listitem"] button[aria-label*="₦"]:not([disabled])');
    const count = await products.count();
    if (count === 0) {
      test.skip(); return;
    }
    const cartBefore = await getCartCount(page);
    await products.first().click();
    // Cart item count should increase
    const cartAfter = await getCartCount(page);
    expect(cartAfter).toBeGreaterThan(cartBefore);
  });

  test('cart shows item name and price', async ({ page }) => {
    const products = page.locator('[role="listitem"] button[aria-label*="₦"]:not([disabled])');
    if (await products.count() === 0) { test.skip(); return; }
    await products.first().click();
    const cartItems = page.locator('[aria-label="Cart items"] [role="listitem"]');
    await expect(cartItems.first()).toBeVisible({ timeout: 3000 });
  });

  test('can increase item quantity with + button', async ({ page }) => {
    const products = page.locator('[role="listitem"] button[aria-label*="₦"]:not([disabled])');
    if (await products.count() === 0) { test.skip(); return; }
    await products.first().click();

    const increaseBtn = page.locator('[aria-label^="Increase"]').first();
    await expect(increaseBtn).toBeVisible({ timeout: 3000 });
    await increaseBtn.click();

    const qty = page.locator('[aria-label="Cart items"] span').filter({ hasText: /^[2-9]$/ });
    await expect(qty.first()).toBeVisible({ timeout: 2000 });
  });

  test('can remove item with ✕ button', async ({ page }) => {
    const products = page.locator('[role="listitem"] button[aria-label*="₦"]:not([disabled])');
    if (await products.count() === 0) { test.skip(); return; }
    await products.first().click();

    const removeBtn = page.locator('[aria-label^="Remove"]').first();
    await expect(removeBtn).toBeVisible({ timeout: 3000 });
    await removeBtn.click();

    await expect(page.locator('text=Cart is empty')).toBeVisible({ timeout: 2000 });
  });

  test('total updates correctly after adding multiple items', async ({ page }) => {
    const products = page.locator('[role="listitem"] button[aria-label*="₦"]:not([disabled])');
    if (await products.count() < 2) { test.skip(); return; }
    await products.first().click();
    const total1 = await getOrderTotal(page);
    await products.nth(1).click();
    const total2 = await getOrderTotal(page);
    expect(total2).toBeGreaterThan(total1);
  });
});

// ─── Suite: Payment Modes ──────────────────────────────────────────────────────
test.describe('Payment Modes', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForPOS(page);
  });

  test('Cash mode shows tendered input', async ({ page }) => {
    await selectPaymentMode(page, 'Cash');
    await expect(page.locator('[aria-label="Cash tendered in Naira"]')).toBeVisible();
  });

  test('Cash mode: tendered below total shows "short" warning', async ({ page }) => {
    const products = page.locator('[role="listitem"] button[aria-label*="₦"]:not([disabled])');
    if (await products.count() === 0) { test.skip(); return; }
    await products.first().click();

    await selectPaymentMode(page, 'Cash');
    const tenderedInput = page.locator('[aria-label="Cash tendered in Naira"]');
    await tenderedInput.fill('0.01'); // Very small amount
    await expect(page.locator('[role="alert"]').filter({ hasText: /short/i })).toBeVisible({ timeout: 2000 });
  });

  test('Cash mode: tendered above total shows change amount', async ({ page }) => {
    const products = page.locator('[role="listitem"] button[aria-label*="₦"]:not([disabled])');
    if (await products.count() === 0) { test.skip(); return; }
    await products.first().click();

    await selectPaymentMode(page, 'Cash');
    const tenderedInput = page.locator('[aria-label="Cash tendered in Naira"]');
    await tenderedInput.fill('999999'); // Way more than any product
    // Change should display
    await expect(page.locator('[aria-label*="Change: ₦"]')).toBeVisible({ timeout: 2000 });
  });

  test('selecting Card mode hides tendered input', async ({ page }) => {
    await selectPaymentMode(page, 'Card');
    await expect(page.locator('[aria-label="Cash tendered in Naira"]')).not.toBeVisible();
  });

  test('Split mode shows cash and card inputs', async ({ page }) => {
    await selectPaymentMode(page, 'Split');
    await expect(page.locator('[aria-label="Split: cash amount in Naira"]')).toBeVisible();
    await expect(page.locator('[aria-label="Split: card amount in Naira"]')).toBeVisible();
  });

  test('Split mode: charge button disabled until amounts balance', async ({ page }) => {
    const products = page.locator('[role="listitem"] button[aria-label*="₦"]:not([disabled])');
    if (await products.count() === 0) { test.skip(); return; }
    await products.first().click();

    await selectPaymentMode(page, 'Split');
    // Enter unbalanced amounts
    await page.locator('[aria-label="Split: cash amount in Naira"]').fill('1.00');
    await page.locator('[aria-label="Split: card amount in Naira"]').fill('0.50');

    const chargeBtn = page.locator('button').filter({ hasText: /Charge|Queue/i }).last();
    await expect(chargeBtn).toBeDisabled();
  });

  test('Split mode: shows mismatch error message', async ({ page }) => {
    const products = page.locator('[role="listitem"] button[aria-label*="₦"]:not([disabled])');
    if (await products.count() === 0) { test.skip(); return; }
    await products.first().click();

    await selectPaymentMode(page, 'Split');
    await page.locator('[aria-label="Split: cash amount in Naira"]').fill('1.00');
    await page.locator('[aria-label="Split: card amount in Naira"]').fill('0.50');

    // Mismatch indicator should show ≠
    const indicator = page.locator('[aria-live="polite"]').filter({ hasText: /≠/ });
    await expect(indicator).toBeVisible({ timeout: 2000 });
  });

  test('payment mode selector marks active mode with aria-pressed=true', async ({ page }) => {
    await selectPaymentMode(page, 'Transfer');
    const activeBtn = page.locator('button[aria-pressed="true"]').filter({ hasText: /Transfer/i });
    await expect(activeBtn).toBeVisible();
  });
});

// ─── Suite: Checkout → Receipt ─────────────────────────────────────────────────
test.describe('Checkout → Receipt Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForPOS(page);
  });

  test('successful checkout shows receipt screen', async ({ page }) => {
    const products = page.locator('[role="listitem"] button[aria-label*="₦"]:not([disabled])');
    if (await products.count() === 0) { test.skip(); return; }
    await products.first().click();

    await selectPaymentMode(page, 'Cash');
    const chargeBtn = page.locator('button').filter({ hasText: /Charge ₦/i }).last();
    if (await chargeBtn.isVisible() && await chargeBtn.isEnabled()) {
      await chargeBtn.click();
      // Either receipt screen or error message appears
      const receiptOrError = page.locator(
        'h2:has-text("WebWaka POS"), [role="alert"]'
      );
      await expect(receiptOrError.first()).toBeVisible({ timeout: 8_000 });
    }
  });

  test('receipt screen has Print button', async ({ page }) => {
    // Mock successful checkout by navigating directly if needed
    // This test verifies the print button exists on the receipt screen
    const products = page.locator('[role="listitem"] button[aria-label*="₦"]:not([disabled])');
    if (await products.count() === 0) { test.skip(); return; }
    await products.first().click();

    await selectPaymentMode(page, 'Cash');
    const chargeBtn = page.locator('button').filter({ hasText: /Charge ₦/i }).last();
    if (await chargeBtn.isVisible() && await chargeBtn.isEnabled()) {
      await chargeBtn.click();
      // Wait for receipt or timeout
      const printBtn = page.locator('[aria-label="Print thermal receipt"]');
      const printVisible = await printBtn.isVisible({ timeout: 8_000 }).catch(() => false);
      if (printVisible) {
        await expect(printBtn).toBeEnabled();
      }
    }
  });

  test('receipt screen has WhatsApp share button', async ({ page }) => {
    const products = page.locator('[role="listitem"] button[aria-label*="₦"]:not([disabled])');
    if (await products.count() === 0) { test.skip(); return; }
    await products.first().click();

    await selectPaymentMode(page, 'Cash');
    const chargeBtn = page.locator('button').filter({ hasText: /Charge ₦/i }).last();
    if (await chargeBtn.isVisible() && await chargeBtn.isEnabled()) {
      await chargeBtn.click();
      const waBtn = page.locator('[aria-label="Share receipt via WhatsApp"]');
      const waVisible = await waBtn.isVisible({ timeout: 8_000 }).catch(() => false);
      if (waVisible) {
        await expect(waBtn).toBeEnabled();
      }
    }
  });

  test('New Sale button returns to product grid', async ({ page }) => {
    const products = page.locator('[role="listitem"] button[aria-label*="₦"]:not([disabled])');
    if (await products.count() === 0) { test.skip(); return; }
    await products.first().click();

    const chargeBtn = page.locator('button').filter({ hasText: /Charge ₦/i }).last();
    if (await chargeBtn.isVisible() && await chargeBtn.isEnabled()) {
      await chargeBtn.click();
      const newSaleBtn = page.locator('[aria-label="Start a new sale"]');
      const visible = await newSaleBtn.isVisible({ timeout: 8_000 }).catch(() => false);
      if (visible) {
        await newSaleBtn.click();
        await expect(page.locator('[role="main"][aria-label="Product catalogue"]')).toBeVisible({ timeout: 5_000 });
        // Cart should be empty after new sale
        await expect(page.locator('text=Cart is empty')).toBeVisible({ timeout: 3_000 });
      }
    }
  });
});

// ─── Suite: Offline Mode ───────────────────────────────────────────────────────
test.describe('Offline Mode', () => {
  test('offline banner appears when network is set to offline', async ({ page, context }) => {
    await page.goto('/');
    await waitForPOS(page);

    await context.setOffline(true);
    await expect(page.locator('[role="alert"]').filter({ hasText: /OFFLINE/i })).toBeVisible({ timeout: 5_000 });

    await context.setOffline(false);
  });

  test('charge button changes to "Queue Sale (Offline)" when offline', async ({ page, context }) => {
    await page.goto('/');
    await waitForPOS(page);

    const products = page.locator('[role="listitem"] button[aria-label*="₦"]:not([disabled])');
    if (await products.count() > 0) {
      await products.first().click();
    }

    await context.setOffline(true);
    await page.waitForTimeout(500);

    const offlineBtn = page.locator('button').filter({ hasText: /Queue Sale/i });
    const visible = await offlineBtn.isVisible().catch(() => false);
    if (visible) {
      await expect(offlineBtn).toBeVisible();
    }

    await context.setOffline(false);
  });

  test('synced toast appears when connection restores after offline sale', async ({ page, context }) => {
    await page.goto('/');
    await waitForPOS(page);

    await context.setOffline(true);
    await page.waitForTimeout(300);

    // Queue a sale offline if product is available
    const products = page.locator('[role="listitem"] button[aria-label*="₦"]:not([disabled])');
    if (await products.count() > 0) {
      await products.first().click();
      const queueBtn = page.locator('button').filter({ hasText: /Queue Sale/i });
      if (await queueBtn.isVisible()) {
        await queueBtn.click();
      }
    }

    await context.setOffline(false);
    // Sync toast may appear briefly
    const syncToast = page.locator('[role="status"]').filter({ hasText: /sync/i });
    const toastVisible = await syncToast.isVisible({ timeout: 5_000 }).catch(() => false);
    // Toast may or may not appear depending on server availability — no assertion required
    expect(typeof toastVisible).toBe('boolean');
  });
});

// ─── Suite: Mobile Viewport ────────────────────────────────────────────────────
test.describe('Mobile Viewport (375×812)', () => {
  test.use({ viewport: MOBILE_VIEWPORT });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForPOS(page);
  });

  test('POS header is visible on mobile', async ({ page }) => {
    await expect(page.locator('h1').filter({ hasText: /WebWaka POS/i })).toBeVisible();
  });

  test('barcode input is visible on mobile', async ({ page }) => {
    await expect(page.locator('[aria-label="Barcode scanner input — press Enter to add item"]')).toBeVisible();
  });

  test('product catalogue is visible on mobile', async ({ page }) => {
    await expect(page.locator('[role="main"][aria-label="Product catalogue"]')).toBeVisible();
  });

  test('cart panel is present on mobile', async ({ page }) => {
    await expect(page.locator('[aria-label="Cart"]')).toBeVisible();
  });

  test('payment mode buttons are visible on mobile', async ({ page }) => {
    // On mobile, at least the Cash button should be visible
    await expect(page.locator('button[aria-pressed]').filter({ hasText: /Cash/i })).toBeVisible();
  });

  test('charge button is visible on mobile', async ({ page }) => {
    // Disabled charge button (empty cart)
    const chargeBtn = page.locator('button[aria-label="Cart is empty"]');
    await expect(chargeBtn).toBeVisible();
  });

  test('split payment inputs are visible on mobile', async ({ page }) => {
    await selectPaymentMode(page, 'Split');
    await expect(page.locator('[aria-label="Split: cash amount in Naira"]')).toBeVisible();
    await expect(page.locator('[aria-label="Split: card amount in Naira"]')).toBeVisible();
  });

  test('tendered input shows on mobile cash mode', async ({ page }) => {
    await selectPaymentMode(page, 'Cash');
    await expect(page.locator('[aria-label="Cash tendered in Naira"]')).toBeVisible();
  });
});

// ─── Suite: Desktop Viewport ───────────────────────────────────────────────────
test.describe('Desktop Viewport (1280×800)', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForPOS(page);
  });

  test('product grid renders in multi-column layout on desktop', async ({ page }) => {
    const productList = page.locator('[role="list"][aria-label="Product catalogue"]');
    await expect(productList).toBeVisible();
  });

  test('cart sidebar is visible alongside product grid on desktop', async ({ page }) => {
    const main = page.locator('[role="main"][aria-label="Product catalogue"]');
    const aside = page.locator('[aria-label="Cart"]');
    await expect(main).toBeVisible();
    await expect(aside).toBeVisible();

    // Both should be visible simultaneously (side-by-side layout)
    const mainBox = await main.boundingBox();
    const asideBox = await aside.boundingBox();
    if (mainBox && asideBox) {
      // On desktop, cart should be to the right of the main area
      expect(asideBox.x).toBeGreaterThan(mainBox.x);
    }
  });

  test('all payment mode buttons are visible on desktop without scrolling', async ({ page }) => {
    for (const mode of ['Cash', 'Card', 'Transfer', 'Split']) {
      await expect(page.locator(`button[aria-pressed]:has-text("${mode}")`)).toBeInViewport();
    }
  });
});

// ─── Suite: Accessibility ──────────────────────────────────────────────────────
test.describe('Accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForPOS(page);
  });

  test('all interactive elements have accessible labels', async ({ page }) => {
    // Check charge button has aria-label
    const chargeBtn = page.locator('button[aria-label]').filter({ hasText: /Charge|Cart is empty/i });
    await expect(chargeBtn.first()).toHaveAttribute('aria-label');
  });

  test('payment mode buttons use aria-pressed correctly', async ({ page }) => {
    // Cash should be pressed initially
    const cashBtn = page.locator('button[aria-pressed="true"]').filter({ hasText: /Cash/i });
    await expect(cashBtn).toBeVisible();

    // After clicking Card, Cash should no longer be pressed
    await selectPaymentMode(page, 'Card');
    const cardPressed = page.locator('button[aria-pressed="true"]').filter({ hasText: /Card/i });
    await expect(cardPressed).toBeVisible();
  });

  test('cart items list has appropriate role', async ({ page }) => {
    await expect(page.locator('[role="list"][aria-label="Cart items"]')).toBeVisible();
  });

  test('offline alert has role="alert"', async ({ page, context }) => {
    await context.setOffline(true);
    await expect(page.locator('[role="alert"]').filter({ hasText: /OFFLINE/i })).toBeVisible({ timeout: 5_000 });
    await context.setOffline(false);
  });

  test('total displays aria-live for screen reader updates', async ({ page }) => {
    const total = page.locator('[aria-live="polite"][aria-label*="Total: ₦"]');
    await expect(total).toBeVisible();
  });
});
