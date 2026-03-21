import { defineConfig, devices } from '@playwright/test';

/**
 * WebWaka Commerce Suite — Playwright E2E Configuration
 * Tests: POS checkout flow, Single-Vendor product management, Multi-Vendor marketplace
 * Invariants: Mobile-First (iPhone 12 primary), Offline-First (network intercept)
 */
export default defineConfig({
  testDir: './playwright',
  timeout: 30_000,
  retries: 1,
  reporter: [['html', { outputFolder: 'playwright-report', open: 'never' }], ['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    // Mobile-First: test on iPhone 12 viewport
    ...devices['iPhone 12'],
  },
  projects: [
    {
      name: 'mobile-chrome',
      use: { ...devices['iPhone 12'], channel: 'chromium' },
    },
    {
      name: 'desktop-chrome',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run preview:ui',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
