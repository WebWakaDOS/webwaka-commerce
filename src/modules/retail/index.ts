/**
 * COM-4: Retail Extensions
 * Blueprint Reference: Part 10.2 (Commerce & Retail Suite)
 * 
 * Specialized retail modules for different business types:
 * Gas Stations, Electronics, Jewelry, Hardware, Furniture
 */

export type RetailModuleType = 'gas' | 'electronics' | 'jewelry' | 'hardware' | 'furniture';

export interface RetailModuleConfig {
  [key: string]: any;
}

export interface RetailModule {
  id: string;
  tenantId: string;
  type: RetailModuleType;
  name: string;
  config: RetailModuleConfig;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface RetailProduct {
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

export interface RetailTransactionItem {
  productId: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  moduleSpecificData?: Record<string, any>;
}

export interface RetailTransaction {
  id: string;
  moduleId: string;
  items: RetailTransactionItem[];
  total: number;
  paymentMethod: string;
  status: 'pending' | 'completed' | 'cancelled';
  createdAt: Date;
  updatedAt: Date;
}

export interface RetailResult {
  success: boolean;
  id?: string;
  error?: string;
}

export class RetailModuleRegistry {
  private modules: Map<string, RetailModule> = new Map();
  private products: Map<string, RetailProduct> = new Map();
  private transactions: Map<string, RetailTransaction> = new Map();
  private eventCallbacks: Map<string, Function[]> = new Map();

  /**
   * Creates a new retail module.
   */
  createModule(
    tenantId: string,
    type: RetailModuleType,
    name: string,
    config: RetailModuleConfig = {}
  ): RetailResult {
    if (!tenantId || !type || !name) {
      return { success: false, error: 'Missing required fields' };
    }

    const module: RetailModule = {
      id: `retail_${crypto.randomUUID()}`,
      tenantId,
      type,
      name,
      config,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.modules.set(module.id, module);
    this.emit('module.created', module);

    return { success: true, id: module.id };
  }

  /**
   * Gets a module by ID.
   */
  getModule(moduleId: string): RetailModule | null {
    return this.modules.get(moduleId) || null;
  }

  /**
   * Gets modules for a tenant.
   */
  getTenantModules(tenantId: string, type?: RetailModuleType): RetailModule[] {
    return Array.from(this.modules.values()).filter(
      m => m.tenantId === tenantId && (!type || m.type === type)
    );
  }

  /**
   * Updates a module.
   */
  updateModule(moduleId: string, updates: Partial<RetailModule>): RetailResult {
    const module = this.modules.get(moduleId);
    if (!module) {
      return { success: false, error: 'Module not found' };
    }

    Object.assign(module, updates, { updatedAt: new Date() });
    this.emit('module.updated', module);

    return { success: true, id: moduleId };
  }

  /**
   * Adds a product to a module.
   */
  addProduct(
    moduleId: string,
    sku: string,
    name: string,
    price: number,
    cost: number,
    quantity: number,
    description: string = '',
    category: string = 'general',
    moduleSpecificData: Record<string, any> = {}
  ): RetailResult {
    const module = this.modules.get(moduleId);
    if (!module) {
      return { success: false, error: 'Module not found' };
    }

    const product: RetailProduct = {
      id: `prod_${crypto.randomUUID()}`,
      moduleId,
      sku,
      name,
      description,
      category,
      price,
      cost,
      quantity,
      moduleSpecificData,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.products.set(product.id, product);
    this.emit('product.added', product);

    return { success: true, id: product.id };
  }

  /**
   * Gets products for a module.
   */
  getModuleProducts(moduleId: string): RetailProduct[] {
    return Array.from(this.products.values()).filter(p => p.moduleId === moduleId);
  }

  /**
   * Gets a product by ID.
   */
  getProduct(productId: string): RetailProduct | null {
    return this.products.get(productId) || null;
  }

  /**
   * Updates product quantity.
   */
  updateProductQuantity(productId: string, newQuantity: number): RetailResult {
    const product = this.products.get(productId);
    if (!product) {
      return { success: false, error: 'Product not found' };
    }

    product.quantity = newQuantity;
    product.updatedAt = new Date();
    this.emit('product.quantity.updated', product);

    return { success: true, id: productId };
  }

  /**
   * Creates a transaction.
   */
  createTransaction(
    moduleId: string,
    items: RetailTransactionItem[],
    paymentMethod: string
  ): RetailResult {
    const module = this.modules.get(moduleId);
    if (!module) {
      return { success: false, error: 'Module not found' };
    }

    if (!items || items.length === 0) {
      return { success: false, error: 'Transaction must have at least one item' };
    }

    const total = items.reduce((sum, item) => sum + item.subtotal, 0);

    const transaction: RetailTransaction = {
      id: `txn_${crypto.randomUUID()}`,
      moduleId,
      items,
      total,
      paymentMethod,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.transactions.set(transaction.id, transaction);
    this.emit('transaction.created', transaction);

    return { success: true, id: transaction.id };
  }

  /**
   * Gets a transaction by ID.
   */
  getTransaction(transactionId: string): RetailTransaction | null {
    return this.transactions.get(transactionId) || null;
  }

  /**
   * Gets transactions for a module.
   */
  getModuleTransactions(moduleId: string, status?: string): RetailTransaction[] {
    return Array.from(this.transactions.values()).filter(
      t => t.moduleId === moduleId && (!status || t.status === status)
    );
  }

  /**
   * Completes a transaction.
   */
  completeTransaction(transactionId: string): RetailResult {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      return { success: false, error: 'Transaction not found' };
    }

    transaction.status = 'completed';
    transaction.updatedAt = new Date();

    // Update product quantities
    for (const item of transaction.items) {
      const product = this.products.get(item.productId);
      if (product) {
        product.quantity -= item.quantity;
        product.updatedAt = new Date();
      }
    }

    this.emit('transaction.completed', transaction);

    return { success: true, id: transactionId };
  }

  /**
   * Cancels a transaction.
   */
  cancelTransaction(transactionId: string): RetailResult {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      return { success: false, error: 'Transaction not found' };
    }

    transaction.status = 'cancelled';
    transaction.updatedAt = new Date();
    this.emit('transaction.cancelled', transaction);

    return { success: true, id: transactionId };
  }

  /**
   * Gets retail statistics for a module.
   */
  getModuleStats(moduleId: string): {
    totalProducts: number;
    totalTransactions: number;
    completedTransactions: number;
    totalRevenue: number;
    averageTransactionValue: number;
  } {
    const products = this.getModuleProducts(moduleId);
    const transactions = this.getModuleTransactions(moduleId);
    const completedTransactions = transactions.filter(t => t.status === 'completed');
    const totalRevenue = completedTransactions.reduce((sum, t) => sum + t.total, 0);

    return {
      totalProducts: products.length,
      totalTransactions: transactions.length,
      completedTransactions: completedTransactions.length,
      totalRevenue,
      averageTransactionValue:
        completedTransactions.length > 0
          ? totalRevenue / completedTransactions.length
          : 0
    };
  }

  /**
   * Event system for pub/sub.
   */
  on(eventType: string, callback: Function): void {
    if (!this.eventCallbacks.has(eventType)) {
      this.eventCallbacks.set(eventType, []);
    }
    this.eventCallbacks.get(eventType)!.push(callback);
  }

  private emit(eventType: string, data: any): void {
    const callbacks = this.eventCallbacks.get(eventType) || [];
    callbacks.forEach(cb => cb(data));
  }
}
