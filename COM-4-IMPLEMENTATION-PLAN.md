# COM-4: Retail Extensions - Implementation Plan

**Blueprint Reference:** Part 10.2 (Commerce & Retail Suite)  
**Repository:** `webwaka-commerce`  
**Status:** In Progress  
**Date:** March 15, 2026

## Overview

COM-4 implements specialized retail modules for different business types: Gas Stations, Electronics Stores, Jewelry Stores, Hardware Stores, and Furniture Stores. Each module extends the base commerce platform (COM-1, COM-2, COM-3) with industry-specific features.

## Architecture

### Core Components

**Retail Module Registry:** Manages specialized retail modules and their configurations.

**Industry-Specific Features:** Each retail type has unique inventory, pricing, and workflow requirements.

**Multi-Tenant Support:** Each tenant can run one or more retail module types with complete isolation.

**Event Integration:** All modules integrate with CORE-2 event bus for real-time updates.

## Retail Module Specifications

### 1. Gas Station Module (GAS)
- **Features:**
  - Pump management and fuel grade tracking
  - Real-time price updates
  - Fuel tank inventory
  - Attendant management
  - Payment processing (cash, card, mobile)
  - Loyalty program integration
  - Fuel quality testing records
  
- **Inventory Model:**
  - Fuel types: Premium Motor Spirit (PMS), Automotive Gas Oil (AGO), Dual Purpose Kerosene (DPK)
  - Tank capacity tracking
  - Pump allocation per tank
  - Real-time consumption tracking

- **Compliance:**
  - DPRN (Downstream Petroleum Regulatory Authority) compliance
  - Safety regulations
  - Fuel quality standards

### 2. Electronics Store Module (ELEC)
- **Features:**
  - Product SKU management with variants (color, size, specs)
  - Serial number tracking for warranty
  - Supplier management
  - Warranty and service tracking
  - Technical specifications database
  - Return and exchange management
  - Trade-in valuation

- **Inventory Model:**
  - Multi-variant products
  - Batch tracking
  - Expiry date management (for batteries, etc.)
  - Serial number registration

- **Compliance:**
  - SON (Standards Organisation of Nigeria) certification
  - Warranty documentation
  - Consumer protection regulations

### 3. Jewelry Store Module (JEWEL)
- **Features:**
  - Precious metal tracking (gold, silver, platinum)
  - Purity certification (carat, fineness)
  - Gemstone grading and valuation
  - Hallmark management
  - Weight-based pricing
  - Custom design orders
  - Appraisal records

- **Inventory Model:**
  - Metal type and purity
  - Weight tracking (grams, carats)
  - Gemstone specifications
  - Valuation history
  - Certification records

- **Compliance:**
  - Hallmark standards
  - Precious metal regulations
  - Gemstone authenticity certification

### 4. Hardware Store Module (HARD)
- **Features:**
  - Bulk item management
  - Tool rental system
  - Contractor account management
  - Project-based ordering
  - Safety data sheet (SDS) management
  - Supplier catalogs
  - Bulk discount tiers

- **Inventory Model:**
  - Bulk quantities (per unit, per pack, per box)
  - Shelf location management
  - Supplier SKU mapping
  - Reorder points

- **Compliance:**
  - Safety regulations
  - Hazardous material handling
  - SDS documentation

### 5. Furniture Store Module (FURN)
- **Features:**
  - Catalog management with images
  - Customization options (color, material, dimensions)
  - Delivery and installation scheduling
  - Warranty management
  - Assembly instructions
  - Supplier management
  - Bulk order management

- **Inventory Model:**
  - Product variants (color, size, material)
  - Stock by location/warehouse
  - Delivery logistics
  - Installation tracking

- **Compliance:**
  - Safety standards
  - Material certifications
  - Delivery regulations

## Data Model

```typescript
interface RetailModule {
  id: string;
  tenantId: string;
  type: 'gas' | 'electronics' | 'jewelry' | 'hardware' | 'furniture';
  name: string;
  config: Record<string, any>;
  enabled: boolean;
  createdAt: Date;
}

interface RetailProduct {
  id: string;
  moduleId: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  price: number;
  cost: number;
  quantity: number;
  moduleSpecificData: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

interface RetailTransaction {
  id: string;
  moduleId: string;
  items: RetailTransactionItem[];
  total: number;
  paymentMethod: string;
  status: 'pending' | 'completed' | 'cancelled';
  createdAt: Date;
}

interface RetailTransactionItem {
  productId: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  moduleSpecificData?: Record<string, any>;
}
```

## Implementation Tasks

### Task 1: Retail Module Registry
- Implement RetailModuleRegistry class
- Module CRUD operations
- Module configuration management
- Unit tests (>90% coverage)

### Task 2: Gas Station Module
- Implement GasStationModule
- Fuel inventory management
- Pump management
- Price management
- Unit tests

### Task 3: Electronics Store Module
- Implement ElectronicsModule
- Product variant management
- Serial number tracking
- Warranty management
- Unit tests

### Task 4: Jewelry Store Module
- Implement JewelryModule
- Metal and gemstone tracking
- Weight-based pricing
- Appraisal management
- Unit tests

### Task 5: Hardware Store Module
- Implement HardwareModule
- Bulk management
- Tool rental system
- Contractor accounts
- Unit tests

### Task 6: Furniture Store Module
- Implement FurnitureModule
- Customization management
- Delivery scheduling
- Installation tracking
- Unit tests

## QA Protocol (5-Layer)

### Layer 1: Static Analysis
- TypeScript strict mode
- ESLint rules
- No any types

### Layer 2: Unit Tests
- RetailModuleRegistry tests
- Module-specific tests
- Integration tests with COM-1, COM-2, COM-3

### Layer 3: Integration Tests
- CORE-2 event bus integration
- Multi-tenant isolation
- Cross-module communication

### Layer 4: E2E Tests
- Complete retail workflows per module type
- Transaction processing
- Inventory management

### Layer 5: Acceptance Tests
- Nigeria use case
- Performance benchmarks
- Multi-tenant scenarios

## 7 Core Invariants Compliance

- ✅ **Build Once Use Infinitely** - Reusable across all vertical suites
- ✅ **Mobile First** - Responsive retail UIs
- ✅ **PWA First** - Offline-capable retail modules
- ✅ **Offline First** - Transactions queue-able
- ✅ **Nigeria First** - Nigeria-focused retail
- ✅ **Africa First** - Multi-currency support
- ✅ **Vendor Neutral AI** - CORE-5 compatible

## Dependencies

- ✅ CORE-1 (Universal Offline Sync Engine)
- ✅ CORE-2 (Platform Event Bus)
- ✅ COM-1 (Point of Sale - POS)
- ✅ COM-2 (Single Vendor Storefront)
- ✅ COM-3 (Multi-Vendor Marketplace)

## Deliverables

1. ✅ `src/modules/retail/index.ts` - Retail module registry
2. ✅ `src/modules/retail/gas.ts` - Gas station module
3. ✅ `src/modules/retail/electronics.ts` - Electronics module
4. ✅ `src/modules/retail/jewelry.ts` - Jewelry module
5. ✅ `src/modules/retail/hardware.ts` - Hardware module
6. ✅ `src/modules/retail/furniture.ts` - Furniture module
7. ✅ Comprehensive test suites for all modules
8. ✅ GitHub commits with conventional format
9. ✅ QA verification report
