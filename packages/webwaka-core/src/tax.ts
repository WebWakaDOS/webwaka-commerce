/**
 * @webwaka/core — Tax Engine
 * FIRS VAT 7.5% (Nigeria), configurable exemptions, kobo precision.
 * Build Once Use Infinitely — used by POS, Single-Vendor, Multi-Vendor.
 */

export interface TaxConfig {
  vatRate: number;
  vatRegistered: boolean;
  exemptCategories: string[];
}

export interface TaxLineItem {
  category: string;
  amountKobo: number;
}

export interface TaxResult {
  subtotalKobo: number;
  vatKobo: number;
  totalKobo: number;
  vatBreakdown: { category: string; vatKobo: number }[];
}

export class TaxEngine {
  private config: TaxConfig;

  constructor(config: TaxConfig) {
    this.config = config;
  }

  compute(items: TaxLineItem[]): TaxResult {
    const { vatRate, vatRegistered, exemptCategories } = this.config;
    const subtotalKobo = items.reduce((sum, item) => sum + item.amountKobo, 0);
    const vatBreakdown: { category: string; vatKobo: number }[] = [];

    let vatKobo = 0;

    if (vatRegistered) {
      for (const item of items) {
        const exempt = exemptCategories.includes(item.category);
        if (!exempt) {
          const itemVat = Math.round(item.amountKobo * vatRate);
          vatKobo += itemVat;
          vatBreakdown.push({ category: item.category, vatKobo: itemVat });
        }
      }
    }

    return {
      subtotalKobo,
      vatKobo,
      totalKobo: subtotalKobo + vatKobo,
      vatBreakdown,
    };
  }
}

export function createTaxEngine(config: TaxConfig): TaxEngine {
  return new TaxEngine(config);
}
