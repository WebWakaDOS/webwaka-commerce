import React, { useState } from 'react';
import { MarketplaceCore, MarketplaceCartItem } from './core';
import { InventoryItem } from '../../core/db/schema';

// Mock initial inventory for the UI (aggregated from multiple vendors)
const mockMarketplaceInventory: (InventoryItem & { vendorId: string, vendorName: string })[] = [
  { id: 'item_1', tenantId: 'tnt_vendor_1', vendorId: 'tnt_vendor_1', vendorName: 'Mama Put', sku: 'SKU-001', name: 'Jollof Rice', quantity: 50, price: 250000, version: 1, createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null },
  { id: 'item_2', tenantId: 'tnt_vendor_2', vendorId: 'tnt_vendor_2', vendorName: 'Tech Hub', sku: 'SKU-002', name: 'USB Cable', quantity: 30, price: 150000, version: 1, createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null },
];

export const MarketplaceInterface: React.FC<{ marketplaceId: string, marketplaceName: string }> = ({ marketplaceId, marketplaceName }) => {
  const [inventory, setInventory] = useState(mockMarketplaceInventory);
  const [cart, setCart] = useState<MarketplaceCartItem[]>([]);
  const [email, setEmail] = useState('');
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [marketplaceCore] = useState(() => new MarketplaceCore(marketplaceId));

  const addToCart = (item: InventoryItem & { vendorId: string }) => {
    setCart(prev => {
      const existing = prev.find(i => i.id === item.id);
      if (existing) {
        return prev.map(i => i.id === item.id ? { ...i, cartQuantity: i.cartQuantity + 1 } : i);
      }
      return [...prev, { ...item, cartQuantity: 1, vendorId: item.vendorId }];
    });
  };

  const handleCheckout = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cart.length === 0 || !email) return;
    
    setIsCheckingOut(true);
    try {
      const order = await marketplaceCore.checkout(cart, email);
      alert(`Payment successful! Reference: ${order.paymentReference}`);
      setCart([]);
      setEmail('');
      
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
      alert('Payment failed. Please try again.');
    } finally {
      setIsCheckingOut(false);
    }
  };

  const totalAmount = cart.reduce((sum, item) => sum + (item.price * item.cartQuantity), 0);

  // Group inventory by vendor for display
  const vendors = Array.from(new Set(inventory.map(i => i.vendorName)));

  // Mobile-first styling
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', fontFamily: 'sans-serif', backgroundColor: '#f4f4f9' }}>
      <header style={{ padding: '1rem', backgroundColor: '#000', color: '#fff', position: 'sticky', top: 0, zIndex: 10 }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>{marketplaceName}</h1>
      </header>

      <main style={{ flex: 1, padding: '1rem', maxWidth: '800px', margin: '0 auto', width: '100%' }}>
        {vendors.map(vendorName => (
          <div key={vendorName} style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.2rem', marginBottom: '1rem', borderBottom: '2px solid #ccc', paddingBottom: '0.5rem' }}>{vendorName}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '1rem' }}>
              {inventory.filter(i => i.vendorName === vendorName).map(item => (
                <div key={item.id} style={{ backgroundColor: '#fff', padding: '1rem', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', display: 'flex', flexDirection: 'column' }}>
                  <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.1rem' }}>{item.name}</h3>
                  <p style={{ margin: '0 0 0.5rem 0', color: '#666', fontWeight: 'bold' }}>₦{(item.price / 100).toFixed(2)}</p>
                  <p style={{ margin: '0 0 1rem 0', fontSize: '0.9rem', color: item.quantity > 0 ? '#28a745' : '#dc3545' }}>
                    {item.quantity > 0 ? `${item.quantity} in stock` : 'Out of stock'}
                  </p>
                  <button 
                    onClick={() => addToCart(item)}
                    disabled={item.quantity === 0}
                    style={{ marginTop: 'auto', padding: '0.75rem', backgroundColor: '#007bff', color: '#fff', border: 'none', borderRadius: '4px', cursor: item.quantity === 0 ? 'not-allowed' : 'pointer', fontWeight: 'bold' }}
                  >
                    Add to Cart
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}

        {cart.length > 0 && (
          <div style={{ marginTop: '2rem', backgroundColor: '#fff', padding: '1rem', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
            <h2 style={{ fontSize: '1.2rem', margin: '0 0 1rem 0' }}>Marketplace Cart</h2>
            {cart.map(item => (
              <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0', borderBottom: '1px solid #eee' }}>
                <span>{item.name} (x{item.cartQuantity})</span>
                <span>₦{((item.price * item.cartQuantity) / 100).toFixed(2)}</span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '1rem 0', fontWeight: 'bold', fontSize: '1.1rem' }}>
              <span>Total:</span>
              <span>₦{(totalAmount / 100).toFixed(2)}</span>
            </div>

            <form onSubmit={handleCheckout} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
              <input 
                type="email" 
                placeholder="Enter your email" 
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                style={{ padding: '0.75rem', borderRadius: '4px', border: '1px solid #ccc', fontSize: '1rem' }}
              />
              <button 
                type="submit"
                disabled={isCheckingOut}
                style={{ padding: '1rem', backgroundColor: '#28a745', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '1.1rem', fontWeight: 'bold', cursor: isCheckingOut ? 'wait' : 'pointer' }}
              >
                {isCheckingOut ? 'Processing...' : 'Pay with Paystack'}
              </button>
            </form>
          </div>
        )}
      </main>
    </div>
  );
};
