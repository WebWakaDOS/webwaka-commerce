/**
 * WebWaka Commerce Suite — i18n Configuration
 * Blueprint Reference: Part 9.2 (Africa First — en, yo, ig, ha)
 * Pattern: Follows Civic Suite useTranslation pattern exactly
 *
 * Languages:
 * - en: English (default)
 * - yo: Yoruba
 * - ig: Igbo
 * - ha: Hausa
 */
import en from './en.json';
import yo from './yo.json';
import ig from './ig.json';
import ha from './ha.json';

export type Language = 'en' | 'yo' | 'ig' | 'ha';

export interface SupportedLanguage {
  code: Language;
  name: string;
  flag: string;
}

const translations: Record<Language, typeof en> = { en, yo: yo as typeof en, ig: ig as typeof en, ha: ha as typeof en };

let currentLanguage: Language = (
  (typeof localStorage !== 'undefined' && (localStorage.getItem('ww-commerce-lang') as Language)) ||
  'en'
);

export function setLanguage(lang: Language): void {
  currentLanguage = lang;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('ww-commerce-lang', lang);
  }
}

export function getLanguage(): Language {
  return currentLanguage;
}

export function getSupportedLanguages(): SupportedLanguage[] {
  return [
    { code: 'en', name: 'English', flag: '🇬🇧' },
    { code: 'yo', name: 'Yorùbá', flag: '🇳🇬' },
    { code: 'ig', name: 'Igbo', flag: '🇳🇬' },
    { code: 'ha', name: 'Hausa', flag: '🇳🇬' },
  ];
}

/**
 * Get translation value by dot-separated key path
 * Falls back to English if key not found in current language
 * @example t('pos.checkout') → "Checkout"
 */
export function t(key: string, lang?: Language): string {
  const language = lang ?? currentLanguage;
  const keys = key.split('.');
  let value: unknown = translations[language];
  for (const k of keys) {
    if (value && typeof value === 'object' && k in (value as Record<string, unknown>)) {
      value = (value as Record<string, unknown>)[k];
    } else {
      // Fallback to English
      value = translations.en;
      for (const fk of keys) {
        if (value && typeof value === 'object' && fk in (value as Record<string, unknown>)) {
          value = (value as Record<string, unknown>)[fk];
        } else {
          return key;
        }
      }
      break;
    }
  }
  return typeof value === 'string' ? value : key;
}

/**
 * Format kobo amount to Naira display string
 * Nigeria First: all monetary values stored in kobo (integer)
 */
export function formatKoboToNaira(kobo: number, lang: Language = currentLanguage): string {
  const naira = kobo / 100;
  const localeMap: Record<Language, string> = {
    en: 'en-NG',
    yo: 'en-NG',
    ig: 'en-NG',
    ha: 'en-NG',
  };
  return naira.toLocaleString(localeMap[lang], {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 0,
  });
}

/**
 * Format date with language-specific locale
 */
export function formatDate(
  timestamp: number,
  lang: Language = currentLanguage,
  format: 'short' | 'long' = 'short'
): string {
  const date = new Date(timestamp);
  const localeMap: Record<Language, string> = {
    en: 'en-NG',
    yo: 'en-NG',
    ig: 'en-NG',
    ha: 'en-NG',
  };
  const options: Intl.DateTimeFormatOptions =
    format === 'short'
      ? { year: 'numeric', month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' };
  return date.toLocaleDateString(localeMap[lang], options);
}

export default { t, setLanguage, getLanguage, getSupportedLanguages, formatKoboToNaira, formatDate };
