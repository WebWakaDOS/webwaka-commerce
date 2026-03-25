#!/usr/bin/env node
/**
 * WebWaka POS — Local Seed Script (Phase 3)
 * Generates 200 realistic Nigerian retail products across 6 categories.
 *
 * Usage:
 *   node workers/scripts/seed-pos-local.mjs | wrangler d1 execute webwaka-commerce --local --file=-
 *
 *   Or write to a file first:
 *   node workers/scripts/seed-pos-local.mjs > seed-pos.sql
 *   wrangler d1 execute webwaka-commerce --local --file=seed-pos.sql
 *
 * Env:
 *   SEED_TENANT_ID=tnt_demo   (default: tnt_demo)
 *   SEED_CLEAR=1              (default: 0 — set to 1 to DELETE existing products first)
 */

const TENANT_ID = process.env.SEED_TENANT_ID ?? 'tnt_demo';
const CLEAR = process.env.SEED_CLEAR === '1';
const NOW = Date.now();

// ─── Barcode generator (EAN-13 style, prefix = 619 for Nigeria) ────────────
let barcodeSeq = 1000;
const barcode = () => `619${String(barcodeSeq++).padStart(10, '0')}`;

// ─── SKU generator ─────────────────────────────────────────────────────────
const sku = (prefix, n) => `${prefix}-${String(n).padStart(4, '0')}`;

// ─── Product builder ────────────────────────────────────────────────────────
const p = (cat, skuPfx, n, name, priceNaira, qty, lowThreshold = 5, unit = 'piece') => ({
  id: `prod_seed_${cat.toLowerCase()}_${n}`,
  tenant_id: TENANT_ID,
  sku: sku(skuPfx, n),
  name,
  category: cat,
  price: priceNaira * 100,           // kobo
  cost_price: Math.floor(priceNaira * 100 * 0.65), // 65% COGS
  quantity: qty,
  low_stock_threshold: lowThreshold,
  unit,
  barcode: barcode(),
  is_active: 1,
  version: 1,
  created_at: NOW,
  updated_at: NOW,
});

// ─── CATEGORY 1: Groceries (80 products) ──────────────────────────────────
const groceries = [
  // Rice
  p('GROCERY', 'GRC', 1,  'Honeywell Rice 5kg',         4500, 120, 10, 'bag'),
  p('GROCERY', 'GRC', 2,  'Royal Stallion Rice 5kg',    4200,  85, 10, 'bag'),
  p('GROCERY', 'GRC', 3,  'Mama Gold Rice 10kg',        8800,  60, 5,  'bag'),
  p('GROCERY', 'GRC', 4,  'Honeywell Rice 25kg',       21000,  18, 3,  'bag'),
  p('GROCERY', 'GRC', 5,  'Parboiled Rice 5kg',         4000, 200, 15, 'bag'),
  // Beans
  p('GROCERY', 'GRC', 6,  'Oloyin Beans 1kg',           1200,  90, 10, 'kg'),
  p('GROCERY', 'GRC', 7,  'Black-eyed Beans 1kg',        950,  75, 10, 'kg'),
  p('GROCERY', 'GRC', 8,  'Brown Beans 2kg',            1800,  55, 5,  'kg'),
  // Oils
  p('GROCERY', 'GRC', 9,  'Okin Palm Oil 1L',           1800, 140, 10, 'litre'),
  p('GROCERY', 'GRC', 10, 'Okin Palm Oil 2.5L',         4200,  80, 10, 'litre'),
  p('GROCERY', 'GRC', 11, 'Gino Palm Oil 4L',           7000,  35, 5,  'litre'),
  p('GROCERY', 'GRC', 12, 'Kings Groundnut Oil 1L',     2200,  65, 8,  'litre'),
  p('GROCERY', 'GRC', 13, 'Power Oil Vegetable Oil 2L', 3500,  50, 5,  'litre'),
  p('GROCERY', 'GRC', 14, 'Zino Soya Oil 1L',           2100,   4, 5,  'litre'), // LOW STOCK
  // Noodles / Pasta
  p('GROCERY', 'GRC', 15, 'Indomie Instant Noodles (pack of 40)', 6500, 300, 20, 'pack'),
  p('GROCERY', 'GRC', 16, 'Dangote Spaghetti 500g',      650,  200, 25, 'pack'),
  p('GROCERY', 'GRC', 17, 'Honeywell Spaghetti 500g',    700,  180, 25, 'pack'),
  p('GROCERY', 'GRC', 18, 'Semovita 1kg',               1200,   90, 10, 'pack'),
  p('GROCERY', 'GRC', 19, 'Semovita 2kg',               2300,   60, 8,  'pack'),
  p('GROCERY', 'GRC', 20, 'Garri Ijebu 1kg',             500,  150, 20, 'kg'),
  p('GROCERY', 'GRC', 21, 'Garri Ijebu 5kg',            2200,   80, 10, 'bag'),
  // Flour
  p('GROCERY', 'GRC', 22, 'Honeywell Flour 1kg',        1000,  120, 10, 'kg'),
  p('GROCERY', 'GRC', 23, 'Dangote Flour 2kg',          1900,   70, 8,  'kg'),
  p('GROCERY', 'GRC', 24, 'Golden Penny Flour 500g',     600,  200, 20, 'pack'),
  // Condiments
  p('GROCERY', 'GRC', 25, 'Maggi Seasoning (100 cubes)', 1200, 500, 30, 'box'),
  p('GROCERY', 'GRC', 26, 'Knorr Chicken Cubes (72pk)',  900, 450, 30, 'box'),
  p('GROCERY', 'GRC', 27, 'Royco Beef Mix 200g',         700, 300, 20, 'pack'),
  p('GROCERY', 'GRC', 28, 'Gino Tomato Paste 70g',       350,   2, 5,  'tin'),  // LOW STOCK
  p('GROCERY', 'GRC', 29, 'Gino Tomato Paste 400g',     1200, 180, 15, 'tin'),
  p('GROCERY', 'GRC', 30, 'Bama Mayonnaise 270g',        950,  80, 10, 'jar'),
  p('GROCERY', 'GRC', 31, 'Suya Spice 100g',             800, 120, 10, 'pack'),
  p('GROCERY', 'GRC', 32, 'Dried Tatashe 50g',           600,  90, 10, 'pack'),
  p('GROCERY', 'GRC', 33, 'Cameroon Pepper 50g',         700,  80, 8,  'pack'),
  p('GROCERY', 'GRC', 34, 'Uziza Leaves (dried) 30g',    400, 100, 10, 'pack'),
  p('GROCERY', 'GRC', 35, 'Crayfish Powder 100g',        900,  75, 8,  'pack'),
  // Sugar & Sweeteners
  p('GROCERY', 'GRC', 36, 'Dangote Sugar 1kg',           900, 500, 30, 'kg'),
  p('GROCERY', 'GRC', 37, 'Dangote Sugar 5kg',          4200,  90, 10, 'bag'),
  p('GROCERY', 'GRC', 38, 'Honey (pure, 500ml)',         3500,  40, 5,  'bottle'),
  // Beverages
  p('GROCERY', 'GRC', 39, 'Milo 200g sachet',            800, 250, 20, 'pack'),
  p('GROCERY', 'GRC', 40, 'Milo 400g tin',              1800, 120, 10, 'tin'),
  p('GROCERY', 'GRC', 41, 'Bournvita 400g',             2200,  80, 8,  'tin'),
  p('GROCERY', 'GRC', 42, 'Peak Milk 160ml (24-pack)',   8000,  45, 5,  'carton'),
  p('GROCERY', 'GRC', 43, 'Peak Full Cream 900g',        5500,  55, 5,  'tin'),
  p('GROCERY', 'GRC', 44, 'Lipton Yellow Label Teabags', 1200, 200, 15, 'box'),
  p('GROCERY', 'GRC', 45, 'Zobo Leaves 200g (hibiscus)', 600, 100, 10, 'pack'),
  p('GROCERY', 'GRC', 46, 'Ovaltine 400g',              2000,  60, 5,  'tin'),
  // Snacks
  p('GROCERY', 'GRC', 47, 'Chin Chin 500g',              800, 150, 10, 'pack'),
  p('GROCERY', 'GRC', 48, 'Plantain Chips 100g',         500, 200, 15, 'pack'),
  p('GROCERY', 'GRC', 49, 'Gala Sausage Roll (each)',    300, 500, 30, 'piece'),
  p('GROCERY', 'GRC', 50, 'Digestive Biscuits 200g',     700, 180, 15, 'pack'),
  // Salt & Basics
  p('GROCERY', 'GRC', 51, 'Dangote Salt 500g',           250, 800, 50, 'pack'),
  p('GROCERY', 'GRC', 52, 'Iodised Salt 1kg',            400, 600, 40, 'pack'),
  // Eggs & Dairy
  p('GROCERY', 'GRC', 53, 'Farm Fresh Eggs (crate of 30)', 4500, 80, 8, 'crate'),
  p('GROCERY', 'GRC', 54, 'Farm Fresh Eggs (half crate 15)', 2300, 120, 10, 'crate'),
  p('GROCERY', 'GRC', 55, 'Hollandia Yoghurt 500ml',    1500,  60, 8,  'bottle'),
  // Protein / Fish / Meat
  p('GROCERY', 'GRC', 56, 'Stockfish Head Medium',       4000,  30, 3,  'piece'), // LOW STOCK
  p('GROCERY', 'GRC', 57, 'Stockfish Fillet 500g',       3500,  45, 5,  'pack'),
  p('GROCERY', 'GRC', 58, 'Dried Sardine (shawa) 200g',  1500,  80, 8,  'pack'),
  p('GROCERY', 'GRC', 59, 'Corned Beef 340g (can)',      3200,  70, 8,  'tin'),
  p('GROCERY', 'GRC', 60, 'Mackerel in Tomato Sauce',   1200, 100, 10, 'tin'),
  // Fresh-ish produce (dry goods equivalent)
  p('GROCERY', 'GRC', 61, 'Yam (medium tuber)',          2000, 100, 10, 'piece'),
  p('GROCERY', 'GRC', 62, 'Irish Potatoes 1kg',           800, 150, 15, 'kg'),
  p('GROCERY', 'GRC', 63, 'Onion 1kg',                   900, 200, 20, 'kg'),
  p('GROCERY', 'GRC', 64, 'Ginger (dried) 100g',         500, 120, 10, 'pack'),
  p('GROCERY', 'GRC', 65, 'Garlic (dried) 50g',          400, 100, 10, 'pack'),
  // Water / Drinks
  p('GROCERY', 'GRC', 66, 'Ragolis Water 1.5L',           300, 500, 30, 'bottle'),
  p('GROCERY', 'GRC', 67, 'Eva Water 1.5L',               350, 400, 30, 'bottle'),
  p('GROCERY', 'GRC', 68, 'Coca-Cola 50cl',               350, 500, 40, 'bottle'),
  p('GROCERY', 'GRC', 69, 'Pepsi 50cl',                   350, 480, 40, 'bottle'),
  p('GROCERY', 'GRC', 70, 'Malta Guinness 33cl (can)',    600, 250, 20, 'can'),
  // Bread / Bakery
  p('GROCERY', 'GRC', 71, 'Agege Bread (large)',          900, 150, 15, 'loaf'),
  p('GROCERY', 'GRC', 72, 'Sliced Bread (600g)',         1200,  80, 10, 'loaf'),
  // More dry goods
  p('GROCERY', 'GRC', 73, 'Oatmeal 500g',               1100,  90, 8,  'pack'),
  p('GROCERY', 'GRC', 74, 'Custard Powder 500g',         1000, 100, 10, 'pack'),
  p('GROCERY', 'GRC', 75, 'Baking Powder 100g',           400,  80, 8,  'pack'),
  p('GROCERY', 'GRC', 76, 'Vegetable Stock Cube Box',     500,   3, 5,  'box'),  // LOW STOCK
  p('GROCERY', 'GRC', 77, 'Curry Powder 100g',            600, 150, 15, 'pack'),
  p('GROCERY', 'GRC', 78, 'Thyme 50g',                    400, 180, 15, 'pack'),
  p('GROCERY', 'GRC', 79, 'Peanut Butter 400g',          1800,  55, 5,  'jar'),
  p('GROCERY', 'GRC', 80, 'Sesame Seeds 100g',            600,  70, 8,  'pack'),
];

// ─── CATEGORY 2: Fabrics (40 products) ─────────────────────────────────────
const fabrics = [
  p('FABRIC', 'FAB', 1,  'Ankara Print (6 yards) — Geometric Blue',  3500,  40, 5, 'yard'),
  p('FABRIC', 'FAB', 2,  'Ankara Print (6 yards) — Floral Orange',   3500,  35, 5, 'yard'),
  p('FABRIC', 'FAB', 3,  'Ankara Print (6 yards) — Kente Pattern',   4000,  20, 3, 'yard'),
  p('FABRIC', 'FAB', 4,  'Ankara Print (6 yards) — Black & Gold',    4200,  30, 3, 'yard'),
  p('FABRIC', 'FAB', 5,  'Ankara Print (6 yards) — Red & Yellow',    3800,  25, 3, 'yard'),
  p('FABRIC', 'FAB', 6,  'Ankara Print (3 yards) — Mix Pattern',     1900,  50, 5, 'yard'),
  p('FABRIC', 'FAB', 7,  'Hollandais Wax Print 6 yards — Premium',   8500,  15, 2, 'yard'), // LOW STOCK
  p('FABRIC', 'FAB', 8,  'Hollandais Wax Print 6 yards — Standard',  6000,  22, 3, 'yard'),
  p('FABRIC', 'FAB', 9,  'Guinea Brocade (6 yards) — Gold',         12000,  12, 2, 'yard'),
  p('FABRIC', 'FAB', 10, 'Guinea Brocade (6 yards) — Silver',       12000,  10, 2, 'yard'),
  p('FABRIC', 'FAB', 11, 'Aso-Oke Set (3-piece) — Navy Blue',       25000,   8, 2, 'set'),
  p('FABRIC', 'FAB', 12, 'Aso-Oke Set (3-piece) — Burgundy',        25000,   6, 2, 'set'), // LOW STOCK
  p('FABRIC', 'FAB', 13, 'Aso-Oke Set (3-piece) — Champagne Gold',  28000,   5, 2, 'set'), // LOW STOCK
  p('FABRIC', 'FAB', 14, 'French Lace (5 yards) — White',           35000,  10, 2, 'yard'),
  p('FABRIC', 'FAB', 15, 'French Lace (5 yards) — Nude/Cream',      35000,   8, 2, 'yard'), // LOW STOCK
  p('FABRIC', 'FAB', 16, 'Cord Lace (5 yards) — Teal',              18000,  14, 2, 'yard'),
  p('FABRIC', 'FAB', 17, 'Cord Lace (5 yards) — Champagne',         18000,  12, 2, 'yard'),
  p('FABRIC', 'FAB', 18, 'Sequence Lace (5 yards) — Black',         22000,   9, 2, 'yard'), // LOW STOCK
  p('FABRIC', 'FAB', 19, 'George Wrapper (2-piece) — Classic',       9500,  20, 3, 'set'),
  p('FABRIC', 'FAB', 20, 'George Wrapper (2-piece) — Indian',       14000,  15, 2, 'set'),
  p('FABRIC', 'FAB', 21, 'Adire Yoruba Indigo (2 yards)',            3500,  30, 5, 'yard'),
  p('FABRIC', 'FAB', 22, 'Batik Fabric (3 yards) — Earth tones',    3000,  35, 5, 'yard'),
  p('FABRIC', 'FAB', 23, 'Plain Poly Cotton (per yard) — White',     500,  200, 20, 'yard'),
  p('FABRIC', 'FAB', 24, 'Plain Poly Cotton (per yard) — Black',     500,  180, 20, 'yard'),
  p('FABRIC', 'FAB', 25, 'Plain Poly Cotton (per yard) — Red',       550,  160, 20, 'yard'),
  p('FABRIC', 'FAB', 26, 'Plain Poly Cotton (per yard) — Blue',      550,  170, 20, 'yard'),
  p('FABRIC', 'FAB', 27, 'Organza Fabric (per yard) — Gold',         800,  80, 10, 'yard'),
  p('FABRIC', 'FAB', 28, 'Organza Fabric (per yard) — Silver',       800,  75, 10, 'yard'),
  p('FABRIC', 'FAB', 29, 'Satin Fabric (per yard) — Cream',          900,  90, 10, 'yard'),
  p('FABRIC', 'FAB', 30, 'Silk Chiffon (per yard) — Pink',          1500,  60, 8,  'yard'),
  p('FABRIC', 'FAB', 31, 'Silk Chiffon (per yard) — Sage Green',    1500,  55, 8,  'yard'),
  p('FABRIC', 'FAB', 32, 'Dashiki Fabric (2 yards) — Traditional',  2500,  40, 5, 'yard'),
  p('FABRIC', 'FAB', 33, 'Kente Strip Cloth (2 yards)',             5000,  15, 2, 'yard'),
  p('FABRIC', 'FAB', 34, 'Kampala Tie-Dye (6 yards)',               2800,  25, 3, 'yard'),
  p('FABRIC', 'FAB', 35, 'Velvet Fabric (per yard) — Maroon',       2200,  40, 5, 'yard'),
  p('FABRIC', 'FAB', 36, 'Velvet Fabric (per yard) — Forest Green', 2200,  35, 5, 'yard'),
  p('FABRIC', 'FAB', 37, 'Denim Fabric (per yard) — Medium Wash',   1800,  60, 8, 'yard'),
  p('FABRIC', 'FAB', 38, 'Woollen Check Fabric (per yard)',          2500,  30, 3, 'yard'),
  p('FABRIC', 'FAB', 39, 'Embroidery Thread Set (20 colours)',       1500,  50, 5, 'set'),
  p('FABRIC', 'FAB', 40, 'Lining Fabric (5 yards) — White',         1500,  60, 8, 'yard'),
];

// ─── CATEGORY 3: Household Items (30 products) ─────────────────────────────
const household = [
  p('HOUSEHOLD', 'HHD', 1,  'Omo Detergent 2kg',           2200, 150, 10, 'pack'),
  p('HOUSEHOLD', 'HHD', 2,  'Ariel Detergent 2kg',         2500, 130, 10, 'pack'),
  p('HOUSEHOLD', 'HHD', 3,  'Jik Bleach 1L',                900, 200, 15, 'bottle'),
  p('HOUSEHOLD', 'HHD', 4,  'Dettol Antiseptic Liquid 1L', 3500,  80, 5,  'bottle'),
  p('HOUSEHOLD', 'HHD', 5,  'Morning Fresh Dishwash 500ml', 1200, 120, 10, 'bottle'),
  p('HOUSEHOLD', 'HHD', 6,  'Harpic Toilet Cleaner 500ml', 1800,  90, 8,  'bottle'),
  p('HOUSEHOLD', 'HHD', 7,  'Air Freshener (Glade) 300ml', 2000,  70, 5,  'can'),
  p('HOUSEHOLD', 'HHD', 8,  'Insecticide Spray 300ml',     1500, 100, 8,  'can'),
  p('HOUSEHOLD', 'HHD', 9,  'Mop Head (cotton)',            2500,  50, 5,  'piece'),
  p('HOUSEHOLD', 'HHD', 10, 'Bucket 10L (plastic)',         1800,  60, 5,  'piece'),
  p('HOUSEHOLD', 'HHD', 11, 'Soft Broom (Coconut)',         1200, 100, 8,  'piece'),
  p('HOUSEHOLD', 'HHD', 12, 'Hard Broom (grass)',           1500,  80, 8,  'piece'),
  p('HOUSEHOLD', 'HHD', 13, 'Dustpan (plastic)',             800,  70, 5,  'piece'),
  p('HOUSEHOLD', 'HHD', 14, 'Ceramic Plate Set (6 pieces)', 6000,  30, 3,  'set'),
  p('HOUSEHOLD', 'HHD', 15, 'Glass Cups Set (6 pieces)',    4500,  25, 3,  'set'),
  p('HOUSEHOLD', 'HHD', 16, 'Stainless Pot 4L',            8000,  20, 2,  'piece'),
  p('HOUSEHOLD', 'HHD', 17, 'Stainless Pot 2L',            5500,  30, 3,  'piece'),
  p('HOUSEHOLD', 'HHD', 18, 'Aluminum Pot 8L',             6000,   4, 3,  'piece'), // LOW STOCK
  p('HOUSEHOLD', 'HHD', 19, 'Non-stick Frying Pan 26cm',   9500,  18, 2,  'piece'),
  p('HOUSEHOLD', 'HHD', 20, 'Wooden Spoon Set (3 pieces)',  1200,  80, 8,  'set'),
  p('HOUSEHOLD', 'HHD', 21, 'Stainless Ladle',              1800,  60, 5,  'piece'),
  p('HOUSEHOLD', 'HHD', 22, 'Plastic Waste Bin 20L',        2500,  40, 5,  'piece'),
  p('HOUSEHOLD', 'HHD', 23, 'Toilet Roll (12-pack)',        2800, 200, 15, 'pack'),
  p('HOUSEHOLD', 'HHD', 24, 'Paper Towels (6-pack)',        2200, 100, 10, 'pack'),
  p('HOUSEHOLD', 'HHD', 25, 'Zip Lock Bags (100 pieces)',    800, 150, 10, 'pack'),
  p('HOUSEHOLD', 'HHD', 26, 'Aluminium Foil Roll 30cm×7m', 1500,  80, 8,  'roll'),
  p('HOUSEHOLD', 'HHD', 27, 'Kerosene 1L',                  800, 300, 20, 'litre'),
  p('HOUSEHOLD', 'HHD', 28, 'Kerosene Lantern (hurricane)',  3500,  25, 3,  'piece'),
  p('HOUSEHOLD', 'HHD', 29, 'Matchbox (box of 12)',          600, 500, 30, 'box'),
  p('HOUSEHOLD', 'HHD', 30, 'Candles (pack of 12)',          900, 200, 15, 'pack'),
];

// ─── CATEGORY 4: Electronics (20 products) ─────────────────────────────────
const electronics = [
  p('ELECTRONICS', 'ELC', 1,  'LED Bulb 9W (Philips)',         1200,  150, 10, 'piece'),
  p('ELECTRONICS', 'ELC', 2,  'LED Bulb 15W (Philips)',        1600,  120, 10, 'piece'),
  p('ELECTRONICS', 'ELC', 3,  'Energy-Saving Bulb 23W',        1800,   90,  8, 'piece'),
  p('ELECTRONICS', 'ELC', 4,  'AA Batteries (Duracell 4-pack)', 2000,  200, 15, 'pack'),
  p('ELECTRONICS', 'ELC', 5,  'AAA Batteries (4-pack)',        1800,  180, 15, 'pack'),
  p('ELECTRONICS', 'ELC', 6,  'D-cell Battery (2-pack)',       1500,   80, 8,  'pack'),
  p('ELECTRONICS', 'ELC', 7,  'USB-C Charging Cable 1m',       2500,  100, 10, 'piece'),
  p('ELECTRONICS', 'ELC', 8,  'Lightning Cable 1m',            3500,   80, 8,  'piece'),
  p('ELECTRONICS', 'ELC', 9,  'USB-A Wall Charger 10W',        3500,   60, 5,  'piece'),
  p('ELECTRONICS', 'ELC', 10, 'Power Bank 10000mAh',          15000,   30, 3,  'piece'),
  p('ELECTRONICS', 'ELC', 11, 'Extension Cord 4-way 1.8m',     6000,   50, 5,  'piece'),
  p('ELECTRONICS', 'ELC', 12, 'Extension Cord 2-way 5m',       5500,   40, 5,  'piece'),
  p('ELECTRONICS', 'ELC', 13, 'Rechargeable Torch (LED)',      4500,    3, 3,  'piece'), // LOW STOCK
  p('ELECTRONICS', 'ELC', 14, 'Solar Lantern (small)',          8000,   20, 2,  'piece'),
  p('ELECTRONICS', 'ELC', 15, 'Wired Earphones (3.5mm)',        2500,   90, 8,  'piece'),
  p('ELECTRONICS', 'ELC', 16, 'Bluetooth Speaker (mini)',      18000,   15, 2,  'piece'),
  p('ELECTRONICS', 'ELC', 17, 'Electric Kettle 1.5L',         18000,   25, 3,  'piece'),
  p('ELECTRONICS', 'ELC', 18, 'Electric Iron (dry)',           15000,   20, 2,  'piece'),
  p('ELECTRONICS', 'ELC', 19, 'Desk Fan 12" (USB)',            12000,   35, 3,  'piece'),
  p('ELECTRONICS', 'ELC', 20, 'Surge Protector 3-way',         8000,   40, 5,  'piece'),
];

// ─── CATEGORY 5: Personal Care (20 products) ───────────────────────────────
const personalCare = [
  p('PERSONAL_CARE', 'PCA', 1,  'Dettol Bar Soap 175g (3-pack)',  2500, 200, 15, 'pack'),
  p('PERSONAL_CARE', 'PCA', 2,  'Key Soap 200g',                   800, 300, 20, 'piece'),
  p('PERSONAL_CARE', 'PCA', 3,  'Imperial Leather Soap 125g',     1500, 180, 15, 'piece'),
  p('PERSONAL_CARE', 'PCA', 4,  'Vaseline Original 250ml',        2200, 120, 10, 'jar'),
  p('PERSONAL_CARE', 'PCA', 5,  'Shea Butter (raw) 250g',         1800,  90, 8,  'jar'),
  p('PERSONAL_CARE', 'PCA', 6,  'Coconut Oil (organic) 250ml',    2500,  70, 5,  'bottle'),
  p('PERSONAL_CARE', 'PCA', 7,  'Macleans Toothpaste 100ml',      1000, 250, 20, 'tube'),
  p('PERSONAL_CARE', 'PCA', 8,  'Close-Up Toothpaste 80ml',        900, 200, 15, 'tube'),
  p('PERSONAL_CARE', 'PCA', 9,  'Oral-B Toothbrush (2-pack)',     2000, 150, 10, 'pack'),
  p('PERSONAL_CARE', 'PCA', 10, 'Pears Baby Oil 200ml',           1800, 100, 8,  'bottle'),
  p('PERSONAL_CARE', 'PCA', 11, 'Palmolive Shower Gel 250ml',     2200,  80, 5,  'bottle'),
  p('PERSONAL_CARE', 'PCA', 12, 'Sure Deodorant Roll-On 50ml',    1800, 100, 8,  'piece'),
  p('PERSONAL_CARE', 'PCA', 13, 'Rexona Body Spray 150ml',        2500,  90, 8,  'can'),
  p('PERSONAL_CARE', 'PCA', 14, 'Always Classic Pads (24-pack)',  1500, 200, 15, 'pack'),
  p('PERSONAL_CARE', 'PCA', 15, 'Kotex Regular Pads (10-pack)',   1200, 180, 15, 'pack'),
  p('PERSONAL_CARE', 'PCA', 16, 'Dark & Lovely Relaxer Kit',      4500,  35, 3,  'kit'),
  p('PERSONAL_CARE', 'PCA', 17, 'Olive Oil Hair Food 125ml',      1500,  60, 5,  'jar'),
  p('PERSONAL_CARE', 'PCA', 18, 'Hair Net (pack of 12)',           500, 200, 15, 'pack'),
  p('PERSONAL_CARE', 'PCA', 19, 'Nail Clipper + File Set',        1000,  80, 5,  'set'),
  p('PERSONAL_CARE', 'PCA', 20, 'Cotton Wool 100g',                700, 150, 10, 'pack'),
];

// ─── CATEGORY 6: Stationery & Misc (10 products) ───────────────────────────
const misc = [
  p('STATIONERY', 'STA', 1,  'A4 Paper (Ream, 500 sheets)',    3500, 100, 8,  'ream'),
  p('STATIONERY', 'STA', 2,  'Ballpoint Pens (Biro 12-pack)',   800, 300, 20, 'pack'),
  p('STATIONERY', 'STA', 3,  'Permanent Marker (3-pack)',       900, 150, 10, 'pack'),
  p('STATIONERY', 'STA', 4,  'Sticky Notes (5 pads)',           600, 200, 15, 'pack'),
  p('STATIONERY', 'STA', 5,  'Tape (Sellotape 24mm)',           500, 250, 20, 'roll'),
  p('STATIONERY', 'STA', 6,  'Stapler + 1000 Staples',        1800,  50, 5,  'piece'),
  p('STATIONERY', 'STA', 7,  'Receipt Book (50 leaves)',        500, 200, 15, 'book'),
  p('STATIONERY', 'STA', 8,  'Padlock (small, 40mm)',          2500,  60, 5,  'piece'),
  p('STATIONERY', 'STA', 9,  'Packaging Tape (6-roll pack)',   2200,  80, 8,  'pack'),
  p('STATIONERY', 'STA', 10, 'Calculator (12-digit)',           3500,  40, 3,  'piece'),
];

// ─── Combine all 200 products ──────────────────────────────────────────────
const all = [...groceries, ...fabrics, ...household, ...electronics, ...personalCare, ...misc];

if (all.length !== 200) {
  process.stderr.write(`WARNING: Expected 200 products, got ${all.length}\n`);
}

// ─── Generate SQL ──────────────────────────────────────────────────────────
const lines = [];

lines.push('-- WebWaka POS Local Seed — 200 Nigerian Retail Products');
lines.push(`-- Tenant: ${TENANT_ID} | Generated: ${new Date().toISOString()}`);
lines.push('');

if (CLEAR) {
  lines.push(`DELETE FROM products WHERE tenant_id = '${TENANT_ID}';`);
  lines.push('');
}

for (const prod of all) {
  const esc = (v) => v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
  lines.push(
    `INSERT OR IGNORE INTO products (id, tenant_id, sku, name, category, price, cost_price, quantity, low_stock_threshold, unit, barcode, is_active, version, created_at, updated_at) VALUES (` +
    `${esc(prod.id)}, ${esc(prod.tenant_id)}, ${esc(prod.sku)}, ${esc(prod.name)}, ` +
    `${esc(prod.category)}, ${prod.price}, ${prod.cost_price}, ${prod.quantity}, ` +
    `${prod.low_stock_threshold}, ${esc(prod.unit)}, ${esc(prod.barcode)}, ` +
    `${prod.is_active}, ${prod.version}, ${prod.created_at}, ${prod.updated_at}` +
    `);`
  );
}

lines.push('');
lines.push(`-- Seeded ${all.length} products into tenant ${TENANT_ID}`);
lines.push(`-- Low-stock items (quantity <= threshold): ${all.filter(p => p.quantity <= p.low_stock_threshold).length}`);
lines.push(`-- Categories: GROCERY(${groceries.length}), FABRIC(${fabrics.length}), HOUSEHOLD(${household.length}), ELECTRONICS(${electronics.length}), PERSONAL_CARE(${personalCare.length}), STATIONERY(${misc.length})`);

process.stdout.write(lines.join('\n') + '\n');
