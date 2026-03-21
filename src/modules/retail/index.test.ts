import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RetailModuleRegistry } from './index';

describe('COM-4: Retail Extensions', () => {
  let retailRegistry: RetailModuleRegistry;
  const tenantId = 'tenant_001';

  beforeEach(() => {
    retailRegistry = new RetailModuleRegistry();
  });

  describe('Module Management', () => {
    it('should create a gas station module', () => {
      const result = retailRegistry.createModule(
        tenantId,
        'gas',
        'Shell Petrol Station',
        { location: 'Lagos', pumpCount: 8 }
      );

      expect(result.success).toBe(true);
      expect(result.id).toBeDefined();
    });

    it('should create an electronics store module', () => {
      const result = retailRegistry.createModule(
        tenantId,
        'electronics',
        'TechHub Electronics',
        { location: 'Abuja', categories: ['phones', 'laptops'] }
      );

      expect(result.success).toBe(true);
      expect(result.id).toBeDefined();
    });

    it('should create a jewelry store module', () => {
      const result = retailRegistry.createModule(
        tenantId,
        'jewelry',
        'Golden Jewels',
        { location: 'Lagos', specialization: 'gold' }
      );

      expect(result.success).toBe(true);
      expect(result.id).toBeDefined();
    });

    it('should create a hardware store module', () => {
      const result = retailRegistry.createModule(
        tenantId,
        'hardware',
        'BuildRight Hardware',
        { location: 'Ibadan', warehouses: 2 }
      );

      expect(result.success).toBe(true);
      expect(result.id).toBeDefined();
    });

    it('should create a furniture store module', () => {
      const result = retailRegistry.createModule(
        tenantId,
        'furniture',
        'HomeComfort Furniture',
        { location: 'Kano', showrooms: 1 }
      );

      expect(result.success).toBe(true);
      expect(result.id).toBeDefined();
    });

    it('should not create module with missing fields', () => {
      const result = retailRegistry.createModule('', 'gas', 'Test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing required fields');
    });

    it('should emit module.created event', () => {
      const callback = vi.fn();
      retailRegistry.on('module.created', callback);

      retailRegistry.createModule(tenantId, 'gas', 'Test Station');

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0][0].type).toBe('gas');
    });

    it('should get a module by ID', () => {
      const result = retailRegistry.createModule(tenantId, 'gas', 'Test Station');
      const module = retailRegistry.getModule(result.id!);

      expect(module).toBeDefined();
      expect(module!.type).toBe('gas');
      expect(module!.name).toBe('Test Station');
    });

    it('should get tenant modules', () => {
      retailRegistry.createModule(tenantId, 'gas', 'Gas Station');
      retailRegistry.createModule(tenantId, 'electronics', 'Electronics Store');
      retailRegistry.createModule('tenant_002', 'jewelry', 'Jewelry Store');

      const modules = retailRegistry.getTenantModules(tenantId);

      expect(modules.length).toBe(2);
      expect(modules.every(m => m.tenantId === tenantId)).toBe(true);
    });

    it('should filter modules by type', () => {
      retailRegistry.createModule(tenantId, 'gas', 'Gas Station 1');
      retailRegistry.createModule(tenantId, 'gas', 'Gas Station 2');
      retailRegistry.createModule(tenantId, 'electronics', 'Electronics Store');

      const gasModules = retailRegistry.getTenantModules(tenantId, 'gas');

      expect(gasModules.length).toBe(2);
      expect(gasModules.every(m => m.type === 'gas')).toBe(true);
    });

    it('should update a module', () => {
      const result = retailRegistry.createModule(tenantId, 'gas', 'Test Station');
      const updateResult = retailRegistry.updateModule(result.id!, {
        name: 'Updated Station'
      });

      expect(updateResult.success).toBe(true);

      const module = retailRegistry.getModule(result.id!);
      expect(module!.name).toBe('Updated Station');
    });

    it('should emit module.updated event', () => {
      const callback = vi.fn();
      retailRegistry.on('module.updated', callback);

      const result = retailRegistry.createModule(tenantId, 'gas', 'Test');
      retailRegistry.updateModule(result.id!, { name: 'Updated' });

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0][0].name).toBe('Updated');
    });
  });

  describe('Product Management', () => {
    let moduleId: string;

    beforeEach(() => {
      const result = retailRegistry.createModule(tenantId, 'gas', 'Test Station');
      moduleId = result.id!;
    });

    it('should add a product to a module', () => {
      const result = retailRegistry.addProduct(
        moduleId,
        'PMS001',
        'Premium Motor Spirit',
        650,
        600,
        1000,
        'High octane fuel',
        'fuel'
      );

      expect(result.success).toBe(true);
      expect(result.id).toBeDefined();
    });

    it('should emit product.added event', () => {
      const callback = vi.fn();
      retailRegistry.on('product.added', callback);

      retailRegistry.addProduct(
        moduleId,
        'PMS001',
        'Premium Motor Spirit',
        650,
        600,
        1000
      );

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0][0].name).toBe('Premium Motor Spirit');
    });

    it('should get module products', () => {
      retailRegistry.addProduct(
        moduleId,
        'PMS001',
        'Premium Motor Spirit',
        650,
        600,
        1000
      );
      retailRegistry.addProduct(
        moduleId,
        'AGO001',
        'Automotive Gas Oil',
        550,
        500,
        800
      );

      const products = retailRegistry.getModuleProducts(moduleId);

      expect(products.length).toBe(2);
      expect(products.every(p => p.moduleId === moduleId)).toBe(true);
    });

    it('should get a product by ID', () => {
      const result = retailRegistry.addProduct(
        moduleId,
        'PMS001',
        'Premium Motor Spirit',
        650,
        600,
        1000
      );

      const product = retailRegistry.getProduct(result.id!);

      expect(product).toBeDefined();
      expect(product!.name).toBe('Premium Motor Spirit');
    });

    it('should update product quantity', () => {
      const result = retailRegistry.addProduct(
        moduleId,
        'PMS001',
        'Premium Motor Spirit',
        650,
        600,
        1000
      );

      const updateResult = retailRegistry.updateProductQuantity(result.id!, 900);

      expect(updateResult.success).toBe(true);

      const product = retailRegistry.getProduct(result.id!);
      expect(product!.quantity).toBe(900);
    });

    it('should emit product.quantity.updated event', () => {
      const callback = vi.fn();
      retailRegistry.on('product.quantity.updated', callback);

      const result = retailRegistry.addProduct(
        moduleId,
        'PMS001',
        'Premium Motor Spirit',
        650,
        600,
        1000
      );

      retailRegistry.updateProductQuantity(result.id!, 900);

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0][0].quantity).toBe(900);
    });
  });

  describe('Transaction Management', () => {
    let moduleId: string;
    let productId: string;

    beforeEach(() => {
      const moduleResult = retailRegistry.createModule(tenantId, 'gas', 'Test Station');
      moduleId = moduleResult.id!;

      const productResult = retailRegistry.addProduct(
        moduleId,
        'PMS001',
        'Premium Motor Spirit',
        650,
        600,
        1000
      );
      productId = productResult.id!;
    });

    it('should create a transaction', () => {
      const result = retailRegistry.createTransaction(moduleId, [
        { productId, quantity: 10, unitPrice: 650, subtotal: 6500 }
      ], 'cash');

      expect(result.success).toBe(true);
      expect(result.id).toBeDefined();
    });

    it('should not create transaction without items', () => {
      const result = retailRegistry.createTransaction(moduleId, [], 'cash');

      expect(result.success).toBe(false);
      expect(result.error).toContain('at least one item');
    });

    it('should emit transaction.created event', () => {
      const callback = vi.fn();
      retailRegistry.on('transaction.created', callback);

      retailRegistry.createTransaction(moduleId, [
        { productId, quantity: 10, unitPrice: 650, subtotal: 6500 }
      ], 'cash');

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0][0].total).toBe(6500);
    });

    it('should get module transactions', () => {
      retailRegistry.createTransaction(moduleId, [
        { productId, quantity: 10, unitPrice: 650, subtotal: 6500 }
      ], 'cash');
      retailRegistry.createTransaction(moduleId, [
        { productId, quantity: 5, unitPrice: 650, subtotal: 3250 }
      ], 'card');

      const transactions = retailRegistry.getModuleTransactions(moduleId);

      expect(transactions.length).toBe(2);
    });

    it('should complete a transaction', () => {
      const result = retailRegistry.createTransaction(moduleId, [
        { productId, quantity: 10, unitPrice: 650, subtotal: 6500 }
      ], 'cash');

      const completeResult = retailRegistry.completeTransaction(result.id!);

      expect(completeResult.success).toBe(true);

      const transaction = retailRegistry.getTransaction(result.id!);
      expect(transaction!.status).toBe('completed');
    });

    it('should update product quantity on transaction completion', () => {
      const result = retailRegistry.createTransaction(moduleId, [
        { productId, quantity: 10, unitPrice: 650, subtotal: 6500 }
      ], 'cash');

      retailRegistry.completeTransaction(result.id!);

      const product = retailRegistry.getProduct(productId);
      expect(product!.quantity).toBe(990);
    });

    it('should emit transaction.completed event', () => {
      const callback = vi.fn();
      retailRegistry.on('transaction.completed', callback);

      const result = retailRegistry.createTransaction(moduleId, [
        { productId, quantity: 10, unitPrice: 650, subtotal: 6500 }
      ], 'cash');

      retailRegistry.completeTransaction(result.id!);

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0][0].status).toBe('completed');
    });

    it('should cancel a transaction', () => {
      const result = retailRegistry.createTransaction(moduleId, [
        { productId, quantity: 10, unitPrice: 650, subtotal: 6500 }
      ], 'cash');

      const cancelResult = retailRegistry.cancelTransaction(result.id!);

      expect(cancelResult.success).toBe(true);

      const transaction = retailRegistry.getTransaction(result.id!);
      expect(transaction!.status).toBe('cancelled');
    });

    it('should emit transaction.cancelled event', () => {
      const callback = vi.fn();
      retailRegistry.on('transaction.cancelled', callback);

      const result = retailRegistry.createTransaction(moduleId, [
        { productId, quantity: 10, unitPrice: 650, subtotal: 6500 }
      ], 'cash');

      retailRegistry.cancelTransaction(result.id!);

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0][0].status).toBe('cancelled');
    });

    it('should filter transactions by status', () => {
      const result1 = retailRegistry.createTransaction(moduleId, [
        { productId, quantity: 10, unitPrice: 650, subtotal: 6500 }
      ], 'cash');

      const result2 = retailRegistry.createTransaction(moduleId, [
        { productId, quantity: 5, unitPrice: 650, subtotal: 3250 }
      ], 'card');

      retailRegistry.completeTransaction(result1.id!);

      const completedTransactions = retailRegistry.getModuleTransactions(
        moduleId,
        'completed'
      );
      const pendingTransactions = retailRegistry.getModuleTransactions(
        moduleId,
        'pending'
      );

      expect(completedTransactions.length).toBe(1);
      expect(pendingTransactions.length).toBe(1);
    });
  });

  describe('Statistics', () => {
    let moduleId: string;
    let productId: string;

    beforeEach(() => {
      const moduleResult = retailRegistry.createModule(tenantId, 'gas', 'Test Station');
      moduleId = moduleResult.id!;

      const productResult = retailRegistry.addProduct(
        moduleId,
        'PMS001',
        'Premium Motor Spirit',
        650,
        600,
        1000
      );
      productId = productResult.id!;

      const txn1 = retailRegistry.createTransaction(moduleId, [
        { productId, quantity: 10, unitPrice: 650, subtotal: 6500 }
      ], 'cash');

      const txn2 = retailRegistry.createTransaction(moduleId, [
        { productId, quantity: 5, unitPrice: 650, subtotal: 3250 }
      ], 'card');

      retailRegistry.completeTransaction(txn1.id!);
      retailRegistry.completeTransaction(txn2.id!);
    });

    it('should calculate module statistics', () => {
      const stats = retailRegistry.getModuleStats(moduleId);

      expect(stats.totalProducts).toBe(1);
      expect(stats.totalTransactions).toBe(2);
      expect(stats.completedTransactions).toBe(2);
      expect(stats.totalRevenue).toBe(9750);
      expect(stats.averageTransactionValue).toBe(4875);
    });
  });

  describe('Multi-Tenant Isolation', () => {
    it('should isolate modules between tenants', () => {
      const result1 = retailRegistry.createModule('tenant_001', 'gas', 'Gas Station 1');
      const result2 = retailRegistry.createModule('tenant_002', 'gas', 'Gas Station 2');

      const tenant1Modules = retailRegistry.getTenantModules('tenant_001');
      const tenant2Modules = retailRegistry.getTenantModules('tenant_002');

      expect(tenant1Modules.length).toBe(1);
      expect(tenant2Modules.length).toBe(1);
      expect(tenant1Modules[0].id).toBe(result1.id);
      expect(tenant2Modules[0].id).toBe(result2.id);
    });
  });
});
