import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * WebWaka Commerce Suite — Vite Build Configuration
 * Target: Cloudflare Pages (static SPA)
 * Invariants: Mobile-First, PWA-First, Build Once Use Infinitely
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    minify: 'esbuild',
    target: 'es2020',
    rollupOptions: {
      output: {
        // Code splitting for faster initial load (Mobile-First)
        manualChunks: {
          react: ['react', 'react-dom'],
          dexie: ['dexie'],
        },
      },
    },
  },
  define: {
    // Expose env vars to the frontend bundle
    'import.meta.env.VITE_API_BASE': JSON.stringify(process.env.VITE_API_BASE ?? ''),
    'import.meta.env.VITE_TENANT_ID': JSON.stringify(process.env.VITE_TENANT_ID ?? 'tnt_demo'),
  },
  server: {
    port: 5000,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'https://webwaka-commerce-api-staging.webwaka.workers.dev',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, '/api'),
      },
    },
  },
});
