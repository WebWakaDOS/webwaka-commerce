import React, { useState, useEffect } from 'react';
import { POSCore, CartItem } from './core';
import { InventoryItem } from '../../core/db/schema';

// Mock initial inventory for the UI
const mockInventory: InventoryItem[] = [
  { id: 'item_1', tenantId: 'tnt_123', sku: 'SKU-001', name: 'Jollof Rice', quantity: 50, price: 250000, version: 1, createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null },
  { id: 'item_2', tenantId: 'tnt_123', sku: 'SKU-002', name: 'Fried Plantain', quantity: 30, price: 100000, version: 1, createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null },
];

export const POSInterface: React.FC<{ tenantId: string }> = ({ tenantId }) => {
  const [inventory, setInventory] = useState<InventoryItem[]>(mockInventory);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [posCore] = useState(() => new POSCore(tenantId, 'http://localhost/sync'));

  const addToCart = (item: InventoryItem) => {
    setCart(prev => {
      const existing = prev.find(i => i.id === item.id);
      if (existing) {
        return prev.map(i => i.id === item.id ? { ...i, cartQuantity: i.cartQuantity + 1 } : i);
      }
      return [...prev, { ...item, cartQuantity: 1 }];
    });
  };

  const handleCheckout = async () => {
    if (cart.length === 0) return;
    
    try {
      await posCore.checkout(cart, 'CASH');
      alert('Checkout successful! (Offline-first sync queued)');
      setCart([]);
      
      // Optimistically update local inventory UI
      setInventory(prev => prev.map(invItem => {
        const cartItem = cart.find(c => c.id === invItem.id);
        if (cartItem) {
          return { ...invItem, quantity: invItem.quantity - cartItem.cartQuantity };
        }
        return invItem;
      }));
    } catch (error) {
      console.error('Checkout failed', error);
      alert('Checkout failed');
    }
  };

  const totalAmount = cart.reduce((sum, item) => sum + (item.price * item.cartQuantity), 0);

  // Mobile-first styling (Tailwind classes assumed in a real build)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'sans-serif' }}>
      <header style={{ padding: '1rem', backgroundColor: '#000', color: '#fff', textAlign: 'center' }}>
        <h1>WebWaka POS</h1>
      </header>

      <main style={{ flex: 1, overflowY: 'auto', padding: '1rem' }}>
        <h2>Products</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '1rem' }}>
          {inventory.map(item => (
            <div key={item.id} style={{ border: '1px solid #ccc', padding: '1rem', borderRadius: '8px', textAlign: 'center' }}>
              <h3>{item.name}</h3>
              <p>₦{(item.price / 100).toFixed(2)}</p>
              <p>Stock: {item.quantity}</p>
              <button 
                onClick={() => addToCart(item)}
                disabled={item.quantity === 0}
                style={{ padding: '0.5rem 1rem', backgroundColor: '#007bff', color: '#fff', border: 'none', borderRadius: '4px', width: '100%' }}
              >
                Add to Cart
              </button>
            </div>
          ))}
        </div>
      </main>

      {/* Slide-up Cart for Mobile */}
      <aside style={{ borderTop: '2px solid #eee', padding: '1rem', backgroundColor: '#f9f9f9', maxHeight: '40vh', overflowY: 'auto' }}>
        <h2>Cart ({cart.length} items)</h2>
        {cart.map(item => (
          <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <span>{item.name} x{item.cartQuantity}</span>
            <span>₦{((item.price * item.cartQuantity) / 100).toFixed(2)}</span>
          </div>
        ))}
        <div style={{ marginTop: '1rem', borderTop: '1px solid #ccc', paddingTop: '1rem', display: 'flex', justifyContent: 'space-between', fontWeight: 'bold' }}>
          <span>Total:</span>
          <span>₦{(totalAmount / 100).toFixed(2)}</span>
        </div>
        <button 
          onClick={handleCheckout}
          disabled={cart.length === 0}
          style={{ marginTop: '1rem', padding: '1rem', backgroundColor: '#28a745', color: '#fff', border: 'none', borderRadius: '4px', width: '100%', fontSize: '1.1rem', fontWeight: 'bold' }}
        >
          Checkout (Cash)
        </button>
      </aside>
    </div>
  );
};
