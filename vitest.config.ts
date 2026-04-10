import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@webwaka/core': path.resolve(__dirname, 'src/__mocks__/webwaka-core.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    exclude: ['**/node_modules/**', '**/dist/**', '**/playwright/**', '**/*.spec.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'json-summary'],
      // Only measure coverage for worker source files (not UI, scripts, or public assets)
      include: [
        'src/worker.ts',
        'src/core/**/*.ts',
        'src/modules/**/*.ts',
        'src/middleware/**/*.ts',
        'src/utils/**/*.ts',
      ],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/__mocks__/**',
        '**/playwright/**',
        // UI / frontend files (not part of worker unit tests)
        'src/app.tsx',
        'src/main.tsx',
        'src/components/**',
        'src/pages/**',
        'src/hooks/**',
        'src/stores/**',
        'src/styles/**',
        'src/types/**',
        // Worker entry point — integration-tested via deploy, not unit-testable
        'src/worker.ts',
        // Offline client-side Dexie DB — browser-only, not testable in Node
        'src/core/offline/db.ts',
        'src/core/offline/client.ts',
        // Event bus handlers — tested via integration, not unit tests
        'src/core/event-bus/handlers/**',
        // AI forecasting — external service integration
        'src/modules/ai/**',
        // Auth middleware — tested via worker integration
        'src/middleware/auth.ts',
        // Background sync and React hooks — browser-only, not Node-testable
        'src/modules/pos/backgroundSync.ts',
        'src/modules/pos/offlineCart.ts',
        'src/modules/pos/useBackgroundSync.ts',
        'src/modules/pos/useOfflineCart.ts',
        'src/modules/single-vendor/storefrontCart.ts',
        'src/modules/single-vendor/useStorefrontCart.ts',
        // Commerce extension modules — not yet unit-tested (integration-tested via deploy)
        'src/modules/commerce/**',
        'src/modules/b2b/**',
        // Core infrastructure — no unit tests (integration-tested)
        'src/core/central-mgmt.ts',
        'src/core/ui-config-branding.ts',
        'src/core/db/**',
        'src/core/i18n/**',
        'src/core/sync/client.ts',
        // i18n barrel
        'src/i18n/**',
        // AI recommendations — external service
        'src/modules/ai/**',
        // Scripts and config
        'scripts/**',
        'public/**',
        'workers/scripts/**',
        '**/*.spec.ts',
        'playwright.config.ts',
        'vite.config.ts',
        'vitest.config.ts',
      ],
      thresholds: {
        // Thresholds reflect actual coverage of worker source files (large API modules
        // like pos/api.ts ~9k lines have partial coverage; browser-only files excluded).
        lines: 60,
        functions: 70,
        branches: 70,
        statements: 60,
      },
    },
  },
});
