/**
 * UI Config Branding Adapter — webwaka-commerce
 * Blueprint Reference: WEBWAKA_UI_BUILDER_ARCHITECTURE.md — "COM-5 Integration"
 *
 * Task: COM-5 — Refactor Commerce branding to use central UI_CONFIG_KV
 *
 * This module provides a bridge between the legacy `StorefrontBranding` schema
 * (used in `TenantConfig.branding`) and the canonical `TenantBrandingSchema`
 * stored in `UI_CONFIG_KV` by `webwaka-ui-builder`.
 *
 * MIGRATION STRATEGY:
 * - Commerce continues to read/write `StorefrontBranding` from its own D1 tenant config
 *   for backward compatibility with existing code
 * - This adapter additionally reads from `UI_CONFIG_KV` (canonical store) when available
 * - `UI_CONFIG_KV` takes precedence over the local D1 config when present
 * - The `syncBrandingToUIConfigKV()` function writes Commerce branding changes
 *   to `UI_CONFIG_KV` so that `webwaka-ui-builder` deployments pick up the latest config
 *
 * KV Key format: `branding:{tenantId}`
 * This matches the key format used by `webwaka-ui-builder/src/routes/branding.ts`
 */

export interface StorefrontBranding {
  primaryColor: string;
  accentColor?: string;
  fontFamily?: string;
  logoUrl?: string;
  heroImageUrl?: string;
  announcementBar?: string;
}

// Canonical TenantBrandingSchema (mirrors @webwaka/core v1.6.0)
export interface TenantBrandingSchema {
  tenantId: string;
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    text: string;
    textMuted?: string;
  };
  typography: {
    headingFont: string;
    bodyFont: string;
    baseFontSizePx?: number;
  };
  assets: {
    logoUrl: string;
    faviconUrl: string;
    heroImageUrl?: string;
  };
  layout: {
    navigationStyle: 'top-bar' | 'side-drawer' | 'bottom-tab' | 'hybrid';
    footerStyle: 'minimal' | 'standard' | 'extended' | 'none';
    borderRadius?: 'none' | 'sm' | 'md' | 'lg' | 'full';
  };
  seo?: {
    siteTitle: string;
    siteDescription?: string;
  };
  updatedAt?: string;
  version?: number;
}

/**
 * Retrieve branding for a tenant.
 *
 * Priority order:
 * 1. `UI_CONFIG_KV` — canonical store (set by webwaka-ui-builder)
 * 2. `localBranding` — legacy StorefrontBranding from D1 tenant config
 *
 * Returns a merged `StorefrontBranding` object for backward compatibility.
 */
export async function getEffectiveBranding(
  tenantId: string,
  uiConfigKV: KVNamespace,
  localBranding: StorefrontBranding,
): Promise<StorefrontBranding> {
  try {
    const canonical = await uiConfigKV.get(`branding:${tenantId}`);
    if (canonical) {
      const schema = JSON.parse(canonical) as TenantBrandingSchema;
      // Map canonical schema back to StorefrontBranding for backward compat
      return {
        primaryColor: schema.colors.primary,
        accentColor: schema.colors.accent,
        fontFamily: schema.typography.bodyFont,
        logoUrl: schema.assets.logoUrl,
        heroImageUrl: schema.assets.heroImageUrl,
        announcementBar: localBranding.announcementBar, // not in canonical schema
      };
    }
  } catch (err) {
    console.warn(`[commerce] Failed to read UI_CONFIG_KV branding for ${tenantId}:`, err);
  }
  // Fall back to local D1 branding
  return localBranding;
}

/**
 * Sync a Commerce branding update to UI_CONFIG_KV.
 *
 * Called whenever a tenant updates their branding via the Commerce admin panel
 * (PUT /admin/tenant/branding). This ensures webwaka-ui-builder deployments
 * always use the latest branding.
 *
 * @param tenantId      The tenant ID
 * @param uiConfigKV    The UI_CONFIG_KV namespace binding
 * @param branding      The updated StorefrontBranding from Commerce
 * @param tenantDomain  The tenant's domain (for SEO config)
 */
export async function syncBrandingToUIConfigKV(
  tenantId: string,
  uiConfigKV: KVNamespace,
  branding: StorefrontBranding,
  tenantDomain?: string,
): Promise<void> {
  try {
    // Read existing canonical config to preserve non-Commerce fields
    const existing = await uiConfigKV.get(`branding:${tenantId}`);
    const existingSchema: TenantBrandingSchema | null = existing ? JSON.parse(existing) : null;

    const canonical: TenantBrandingSchema = {
      tenantId,
      colors: {
        primary: branding.primaryColor,
        secondary: existingSchema?.colors.secondary ?? '#6b7280',
        accent: branding.accentColor ?? existingSchema?.colors.accent ?? '#16a34a',
        background: existingSchema?.colors.background ?? '#ffffff',
        text: existingSchema?.colors.text ?? '#111827',
        textMuted: existingSchema?.colors.textMuted,
      },
      typography: {
        headingFont: existingSchema?.typography.headingFont ?? branding.fontFamily ?? 'Inter, system-ui, sans-serif',
        bodyFont: branding.fontFamily ?? existingSchema?.typography.bodyFont ?? 'Inter, system-ui, sans-serif',
      },
      assets: {
        logoUrl: branding.logoUrl ?? existingSchema?.assets.logoUrl ?? '',
        faviconUrl: existingSchema?.assets.faviconUrl ?? '',
        heroImageUrl: branding.heroImageUrl ?? existingSchema?.assets.heroImageUrl,
      },
      layout: existingSchema?.layout ?? {
        navigationStyle: 'top-bar',
        footerStyle: 'standard',
        borderRadius: 'md',
      },
      seo: existingSchema?.seo ?? {
        siteTitle: tenantDomain ?? tenantId,
      },
      updatedAt: new Date().toISOString(),
      version: (existingSchema?.version ?? 0) + 1,
    };

    await uiConfigKV.put(`branding:${tenantId}`, JSON.stringify(canonical));
  } catch (err) {
    // Non-fatal: log but do not throw — Commerce branding update should not fail
    // because of a KV sync error
    console.error(`[commerce] Failed to sync branding to UI_CONFIG_KV for ${tenantId}:`, err);
  }
}
