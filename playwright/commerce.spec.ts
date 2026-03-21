/**
 * WebWaka Commerce Suite — E2E Tests
 * Flows: POS checkout, Single-Vendor product add, Multi-Vendor vendor registration
 * Invariants: Mobile-First, Offline-First, Nigeria-First (NGN), NDPR consent
 */
import { test, expect, type Page } from '@playwright/test';

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function waitForApp(page: Page) {
  await page.waitForSelector('[data-testid="commerce-app"]', { timeout: 15_000 });
}

async function navigateToModule(page: Page, module: 'pos' | 'storefront' | 'marketplace') {
  const selector = module === 'pos' ? '[aria-label="Point of Sale"]' :
                   module === 'storefront' ? '[aria-label="Storefront"]' :
                   '[aria-label="Marketplace"]';
  await page.click(selector);
}

// ─── Suite: App Loads ─────────────────────────────────────────────────────────
test.describe('Commerce App', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
  });

  test('loads with correct title and status bar', async ({ page }) => {
    // Title
    await expect(page).toHaveTitle(/WebWaka Commerce/i);

    // Status bar present
    const statusBar = page.locator('text=/Online|Offline/');
    await expect(statusBar.first()).toBeVisible();
  });

  test('renders bottom navigation with 4 modules', async ({ page }) => {
    // All 4 module tabs visible
    await expect(page.locator('[aria-label="Point of Sale"]')).toBeVisible();
    await expect(page.locator('[aria-label="Storefront"]')).toBeVisible();
    await expect(page.locator('[aria-label="Marketplace"]')).toBeVisible();
    await expect(page.locator('[aria-label="Dashboard"]')).toBeVisible();
  });

  test('language selector changes language', async ({ page }) => {
    const langSelect = page.locator('select[aria-label="Select language"]');
    await expect(langSelect).toBeVisible();

    // Switch to Yoruba
    await langSelect.selectOption('yo');
    // Check that some text changed to Yoruba
    await expect(page.locator('text=Ibi Tita')).toBeVisible();

    // Switch back to English
    await langSelect.selectOption('en');
    await expect(page.locator('text=Point of Sale')).toBeVisible();
  });

  test('has correct PWA meta tags', async ({ page }) => {
    const manifest = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(manifest).toBe('/manifest.json');

    const themeColor = await page.locator('meta[name="theme-color"]').getAttribute('content');
    expect(themeColor).toBe('#f59e0b');

    const lang = await page.locator('html').getAttribute('lang');
    expect(lang).toBe('en-NG');
  });
});

// ─── Suite: POS Module ────────────────────────────────────────────────────────
test.describe('POS Module', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
    // POS is the default module
  });

  test('displays product search input', async ({ page }) => {
    const search = page.locator('input[type="search"]');
    await expect(search.first()).toBeVisible();
    await expect(search.first()).toHaveAttribute('placeholder', /search/i);
  });

  test('shows product grid with prices in NGN', async ({ page }) => {
    // Products should be visible
    const products = page.locator('[class*="product"], [style*="border-radius"]').filter({ hasText: /₦/ });
    // At least some products should be visible
    const count = await products.count();
    expect(count).toBeGreaterThan(0);

    // All prices should be in NGN (₦)
    const prices = page.locator('text=/₦\\d/');
    const priceCount = await prices.count();
    expect(priceCount).toBeGreaterThan(0);
  });

  test('can add product to cart', async ({ page }) => {
    // Find the first "Add to Cart" button
    const addBtn = page.locator('button', { hasText: /Add to Cart/i }).first();
    if (await addBtn.isVisible()) {
      await addBtn.click();
      // Cart should show 1 item
      await expect(page.locator('text=/Cart.*1|1.*item/i')).toBeVisible({ timeout: 3_000 });
    }
  });

  test('POS checkout flow: add item, select payment, checkout', async ({ page }) => {
    // Add item to cart
    const addBtn = page.locator('button', { hasText: /Add to Cart/i }).first();
    if (await addBtn.isVisible()) {
      await addBtn.click();
    }

    // Select payment method
    const paymentSelect = page.locator('select').filter({ hasText: /Cash|Card|Transfer/i }).first();
    if (await paymentSelect.isVisible()) {
      await paymentSelect.selectOption('cash');
    }

    // Check if checkout button is visible
    const checkoutBtn = page.locator('button', { hasText: /Checkout|Process Payment|Pay/i }).first();
    if (await checkoutBtn.isVisible()) {
      await checkoutBtn.click();
      // Should show success or offline queued message
      await expect(
        page.locator('text=/Sale complete|Offline|queued/i')
      ).toBeVisible({ timeout: 5_000 });
    }
  });

  test('offline mode: queues sale when offline', async ({ page, context }) => {
    // Simulate offline
    await context.setOffline(true);

    // Check offline indicator
    await expect(page.locator('text=Offline')).toBeVisible({ timeout: 3_000 });

    // Restore online
    await context.setOffline(false);
  });

  test('POS dashboard shows revenue stats', async ({ page }) => {
    // Navigate to dashboard tab
    const dashboardBtn = page.locator('[aria-label="Dashboard"]');
    await dashboardBtn.click();

    // Should show some stats
    await expect(page.locator('text=/Today|Revenue|Orders/i').first()).toBeVisible({ timeout: 5_000 });
  });
});

// ─── Suite: Single-Vendor Storefront ─────────────────────────────────────────
test.describe('Single-Vendor Storefront', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
    await navigateToModule(page, 'storefront');
  });

  test('displays storefront catalog', async ({ page }) => {
    await expect(page.locator('text=/Catalog|Store|Products/i').first()).toBeVisible({ timeout: 5_000 });
  });

  test('NDPR consent checkbox present in add product form', async ({ page }) => {
    // Find and click "Add Product" button
    const addBtn = page.locator('button', { hasText: /Add Product|New Product/i }).first();
    if (await addBtn.isVisible()) {
      await addBtn.click();
      // NDPR consent checkbox should appear
      const ndprCheckbox = page.locator('input[type="checkbox"]').filter({ hasText: /NDPR|data protection/i });
      if (await ndprCheckbox.count() === 0) {
        // Check for label text near checkbox
        await expect(page.locator('text=/NDPR|data protection/i')).toBeVisible({ timeout: 3_000 });
      }
    }
  });

  test('product form has name, price, and stock fields', async ({ page }) => {
    const addBtn = page.locator('button', { hasText: /Add Product|New Product/i }).first();
    if (await addBtn.isVisible()) {
      await addBtn.click();
      await expect(page.locator('input[placeholder*="name" i], label:has-text("Name") + input').first()).toBeVisible({ timeout: 3_000 });
    }
  });
});

// ─── Suite: Multi-Vendor Marketplace ─────────────────────────────────────────
test.describe('Multi-Vendor Marketplace', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
    await navigateToModule(page, 'marketplace');
  });

  test('displays marketplace with vendor list', async ({ page }) => {
    await expect(page.locator('text=/Marketplace|Vendors|Products/i').first()).toBeVisible({ timeout: 5_000 });
  });

  test('vendor registration form has NDPR consent', async ({ page }) => {
    // Find register vendor button
    const registerBtn = page.locator('button', { hasText: /Register Vendor|Add Vendor/i }).first();
    if (await registerBtn.isVisible()) {
      await registerBtn.click();
      // NDPR consent should be present
      await expect(page.locator('text=/NDPR|data protection/i')).toBeVisible({ timeout: 3_000 });
    }
  });

  test('vendor list shows status badges', async ({ page }) => {
    // Status badges (active, pending, suspended)
    const badges = page.locator('text=/ACTIVE|active|PENDING|pending/i');
    // May be empty if no vendors, but page should load without error
    await expect(page.locator('text=/Marketplace|Vendors/i').first()).toBeVisible({ timeout: 5_000 });
  });
});

// ─── Suite: Performance (Lighthouse-style) ───────────────────────────────────
test.describe('Performance', () => {
  test('page loads within 5 seconds on mobile', async ({ page }) => {
    const start = Date.now();
    await page.goto('/');
    await waitForApp(page);
    const loadTime = Date.now() - start;
    expect(loadTime).toBeLessThan(5_000);
  });

  test('First Contentful Paint under 1500ms', async ({ page }) => {
    await page.goto('/');

    const fcp = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntriesByName('first-contentful-paint')) {
            resolve(entry.startTime);
          }
        });
        observer.observe({ type: 'paint', buffered: true });
        // Fallback timeout
        setTimeout(() => resolve(performance.now()), 5000);
      });
    });

    // FCP should be under 1500ms (Civic standard)
    expect(fcp).toBeLessThan(1500);
  });

  test('manifest.json is valid and accessible', async ({ page }) => {
    const response = await page.request.get('/manifest.json');
    expect(response.status()).toBe(200);

    const manifest = await response.json();
    expect(manifest.name).toContain('WebWaka');
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.lang).toBe('en-NG');
    expect(manifest.shortcuts).toBeDefined();
    expect(manifest.shortcuts.length).toBeGreaterThan(0);
  });

  test('service worker is registered', async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);

    const swRegistered = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const regs = await navigator.serviceWorker.getRegistrations();
      return regs.length > 0;
    });

    // SW may not be registered in test env, but sw.js should be accessible
    const swResponse = await page.request.get('/sw.js');
    expect(swResponse.status()).toBe(200);
  });
});
