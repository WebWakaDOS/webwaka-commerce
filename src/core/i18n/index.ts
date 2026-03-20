/**
 * WebWaka Commerce Suite - Internationalization (i18n)
 * Invariants: Africa-First (4 languages), Nigeria-First (NGN default)
 * Languages: English (en), Yorùbá (yo), Igbo (ig), Hausa (ha)
 */

export type Language = 'en' | 'yo' | 'ig' | 'ha';

export interface CommerceTranslations {
  // Navigation
  nav_pos: string;
  nav_storefront: string;
  nav_marketplace: string;
  nav_orders: string;
  nav_dashboard: string;

  // POS
  pos_title: string;
  pos_products: string;
  pos_cart: string;
  pos_checkout: string;
  pos_total: string;
  pos_payment_method: string;
  pos_cash: string;
  pos_card: string;
  pos_transfer: string;
  pos_add_to_cart: string;
  pos_remove: string;
  pos_empty_cart: string;
  pos_sale_complete: string;
  pos_offline_queued: string;
  pos_sync_pending: string;
  pos_stock: string;
  pos_out_of_stock: string;

  // Storefront
  storefront_title: string;
  storefront_catalog: string;
  storefront_add_to_cart: string;
  storefront_checkout: string;
  storefront_email: string;
  storefront_phone: string;
  storefront_ndpr_consent: string;
  storefront_order_placed: string;

  // Marketplace
  marketplace_title: string;
  marketplace_vendors: string;
  marketplace_products: string;
  marketplace_register_vendor: string;
  marketplace_vendor_name: string;
  marketplace_commission: string;

  // Common
  common_loading: string;
  common_error: string;
  common_success: string;
  common_cancel: string;
  common_save: string;
  common_search: string;
  common_filter: string;
  common_currency: string;
  common_today: string;
  common_revenue: string;
  common_orders: string;
}

const translations: Record<Language, CommerceTranslations> = {
  en: {
    nav_pos: 'Point of Sale',
    nav_storefront: 'Storefront',
    nav_marketplace: 'Marketplace',
    nav_orders: 'Orders',
    nav_dashboard: 'Dashboard',
    pos_title: 'WebWaka POS',
    pos_products: 'Products',
    pos_cart: 'Cart',
    pos_checkout: 'Checkout',
    pos_total: 'Total',
    pos_payment_method: 'Payment Method',
    pos_cash: 'Cash',
    pos_card: 'Card',
    pos_transfer: 'Bank Transfer',
    pos_add_to_cart: 'Add to Cart',
    pos_remove: 'Remove',
    pos_empty_cart: 'Cart is empty',
    pos_sale_complete: 'Sale complete!',
    pos_offline_queued: 'Offline — sale queued for sync',
    pos_sync_pending: 'Sync pending',
    pos_stock: 'In stock',
    pos_out_of_stock: 'Out of stock',
    storefront_title: 'Online Store',
    storefront_catalog: 'Catalog',
    storefront_add_to_cart: 'Add to Cart',
    storefront_checkout: 'Checkout',
    storefront_email: 'Email Address',
    storefront_phone: 'Phone Number',
    storefront_ndpr_consent: 'I consent to my data being processed under the Nigeria Data Protection Regulation (NDPR)',
    storefront_order_placed: 'Order placed successfully!',
    marketplace_title: 'Marketplace',
    marketplace_vendors: 'Vendors',
    marketplace_products: 'Products',
    marketplace_register_vendor: 'Register Vendor',
    marketplace_vendor_name: 'Vendor Name',
    marketplace_commission: 'Commission Rate',
    common_loading: 'Loading...',
    common_error: 'An error occurred',
    common_success: 'Success',
    common_cancel: 'Cancel',
    common_save: 'Save',
    common_search: 'Search',
    common_filter: 'Filter',
    common_currency: '₦',
    common_today: 'Today',
    common_revenue: 'Revenue',
    common_orders: 'Orders',
  },
  yo: {
    nav_pos: 'Ibi Tita',
    nav_storefront: 'Ile Itaja',
    nav_marketplace: 'Oja',
    nav_orders: 'Awọn Aṣẹ',
    nav_dashboard: 'Pẹpẹ Iṣakoso',
    pos_title: 'WebWaka POS',
    pos_products: 'Awọn Ọja',
    pos_cart: 'Agbọn Rira',
    pos_checkout: 'Sanwo',
    pos_total: 'Apapọ',
    pos_payment_method: 'Ọna Isanwo',
    pos_cash: 'Owo Naira',
    pos_card: 'Kaadi',
    pos_transfer: 'Gbigbe Owo Banki',
    pos_add_to_cart: 'Fi si Agbọn',
    pos_remove: 'Yọ Kuro',
    pos_empty_cart: 'Agbọn ṣofo',
    pos_sale_complete: 'Tita ti pari!',
    pos_offline_queued: 'Aisiṣiṣẹ — tita ti fi sori atokọ',
    pos_sync_pending: 'Iduro fun isọdọkan',
    pos_stock: 'Wa ni ile itaja',
    pos_out_of_stock: 'Ko si ni ile itaja',
    storefront_title: 'Ile Itaja Ori Ayelujara',
    storefront_catalog: 'Atokọ Ọja',
    storefront_add_to_cart: 'Fi si Agbọn',
    storefront_checkout: 'Sanwo',
    storefront_email: 'Adirẹsi Imeeli',
    storefront_phone: 'Nọmba Foonu',
    storefront_ndpr_consent: 'Mo gba pe data mi le ṣe ilana labẹ Ofin Idaabobo Data Nigeria (NDPR)',
    storefront_order_placed: 'Aṣẹ ti fi silẹ!',
    marketplace_title: 'Oja',
    marketplace_vendors: 'Awọn Olutaja',
    marketplace_products: 'Awọn Ọja',
    marketplace_register_vendor: 'Forukọsilẹ Olutaja',
    marketplace_vendor_name: 'Orukọ Olutaja',
    marketplace_commission: 'Iye Komisọnu',
    common_loading: 'Ẹ duro...',
    common_error: 'Aṣiṣe kan waye',
    common_success: 'Aṣeyọri',
    common_cancel: 'Fagilee',
    common_save: 'Fipamọ',
    common_search: 'Wa',
    common_filter: 'Àlẹmọ',
    common_currency: '₦',
    common_today: 'Oni',
    common_revenue: 'Owo Wiwọle',
    common_orders: 'Awọn Aṣẹ',
  },
  ig: {
    nav_pos: 'Ebe Ire Ahịa',
    nav_storefront: 'Ụlọ Ahịa',
    nav_marketplace: 'Ahịa',
    nav_orders: 'Iwu',
    nav_dashboard: 'Ọnọdụ Njikwa',
    pos_title: 'WebWaka POS',
    pos_products: 'Ngwaahịa',
    pos_cart: 'Ụdọ Azụmahịa',
    pos_checkout: 'Kwụọ Ụgwọ',
    pos_total: 'Ngụkọta',
    pos_payment_method: 'Ụzọ Ịkwụ Ụgwọ',
    pos_cash: 'Ego Nke Aka',
    pos_card: 'Kaadị',
    pos_transfer: 'Nnyefe Ụlọ Akụ',
    pos_add_to_cart: 'Tinye na Ụdọ',
    pos_remove: 'Wepu',
    pos_empty_cart: 'Ụdọ dị efu',
    pos_sale_complete: 'Ire ahịa emechara!',
    pos_offline_queued: 'Ọ dịghị na ntanetị — e debere ire ahịa',
    pos_sync_pending: 'Na-atọ ndị ọzọ',
    pos_stock: 'Dị n\'ụlọ ahịa',
    pos_out_of_stock: 'Adịghị n\'ụlọ ahịa',
    storefront_title: 'Ụlọ Ahịa Ịntanetị',
    storefront_catalog: 'Ndepụta Ngwaahịa',
    storefront_add_to_cart: 'Tinye na Ụdọ',
    storefront_checkout: 'Kwụọ Ụgwọ',
    storefront_email: 'Adreesị Ozi-Elu',
    storefront_phone: 'Nọmba Ekwentị',
    storefront_ndpr_consent: 'Anabatara m ka a na-ahazi data m n\'okpuru Iwu Nchedo Data Nigeria (NDPR)',
    storefront_order_placed: 'Iwu ewepụtara nke ọma!',
    marketplace_title: 'Ahịa',
    marketplace_vendors: 'Ndị Ahịa',
    marketplace_products: 'Ngwaahịa',
    marketplace_register_vendor: 'Debanye Onye Ahịa',
    marketplace_vendor_name: 'Aha Onye Ahịa',
    marketplace_commission: 'Ọnụ Ahịa Komisọn',
    common_loading: 'Na-ebu...',
    common_error: 'Nsogbu mere',
    common_success: 'Ihe ọma',
    common_cancel: 'Kagbuo',
    common_save: 'Chekwaa',
    common_search: 'Chọọ',
    common_filter: 'Nyochaa',
    common_currency: '₦',
    common_today: 'Taa',
    common_revenue: 'Ego Ọnụ Ahịa',
    common_orders: 'Iwu',
  },
  ha: {
    nav_pos: 'Wurin Siyarwa',
    nav_storefront: 'Kantin Sayarwa',
    nav_marketplace: 'Kasuwa',
    nav_orders: 'Umarni',
    nav_dashboard: 'Allon Sarrafa',
    pos_title: 'WebWaka POS',
    pos_products: 'Kayayyaki',
    pos_cart: 'Kwandon Siya',
    pos_checkout: 'Biya',
    pos_total: 'Jimilar',
    pos_payment_method: 'Hanyar Biya',
    pos_cash: 'Kudi Tsabar',
    pos_card: 'Kati',
    pos_transfer: 'Canja Banki',
    pos_add_to_cart: 'Saka a Kwando',
    pos_remove: 'Cire',
    pos_empty_cart: 'Kwando ya wofi',
    pos_sale_complete: 'Siyarwa ta kammala!',
    pos_offline_queued: 'Ba intanet ba — an ajiye siyarwa',
    pos_sync_pending: 'Ana jiran daidaitawa',
    pos_stock: 'Yana cikin kantin',
    pos_out_of_stock: 'Ba shi a kantin',
    storefront_title: 'Kantin Intanet',
    storefront_catalog: 'Jerin Kayayyaki',
    storefront_add_to_cart: 'Saka a Kwando',
    storefront_checkout: 'Biya',
    storefront_email: 'Adireshin Imel',
    storefront_phone: 'Lambar Waya',
    storefront_ndpr_consent: 'Na yarda da sarrafa bayanan na ƙarƙashin Dokar Kare Bayanai ta Najeriya (NDPR)',
    storefront_order_placed: 'An saka umarni cikin nasara!',
    marketplace_title: 'Kasuwa',
    marketplace_vendors: 'Masu Sayarwa',
    marketplace_products: 'Kayayyaki',
    marketplace_register_vendor: 'Yi Rijista Mai Sayarwa',
    marketplace_vendor_name: 'Sunan Mai Sayarwa',
    marketplace_commission: 'Kimar Kwamishon',
    common_loading: 'Ana lodi...',
    common_error: 'Kuskure ya faru',
    common_success: 'Nasara',
    common_cancel: 'Soke',
    common_save: 'Ajiye',
    common_search: 'Nema',
    common_filter: 'Tace',
    common_currency: '₦',
    common_today: 'Yau',
    common_revenue: 'Kudin Shiga',
    common_orders: 'Umarni',
  },
};

export const DEFAULT_LANGUAGE: Language = 'en';

export function getSupportedLanguages(): Language[] {
  return ['en', 'yo', 'ig', 'ha'];
}

export function getTranslations(lang: Language): CommerceTranslations {
  return translations[lang] ?? translations[DEFAULT_LANGUAGE];
}

export function getLanguageName(lang: Language): string {
  const names: Record<Language, string> = {
    en: 'English',
    yo: 'Yorùbá',
    ig: 'Igbo',
    ha: 'Hausa',
  };
  return names[lang];
}

/**
 * Format amount from kobo to Naira display string
 * Nigeria-First: Always uses NGN (₦) as default currency
 */
export function formatKoboToNaira(kobo: number): string {
  return `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
