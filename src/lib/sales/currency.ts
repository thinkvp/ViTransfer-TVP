/**
 * Currency utility functions for sales module
 */

/**
 * Map of common currency codes to their symbols.
 * Covers major currencies worldwide.
 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  // Americas
  AUD: '$', // Australian Dollar
  CAD: '$', // Canadian Dollar
  USD: '$', // US Dollar
  MXN: '$', // Mexican Peso
  BRL: 'R$', // Brazilian Real
  ARS: '$', // Argentine Peso
  CLP: '$', // Chilean Peso
  COP: '$', // Colombian Peso

  // Europe
  EUR: '€', // Euro
  GBP: '£', // British Pound
  CHF: 'CHF', // Swiss Franc
  SEK: 'kr', // Swedish Krona
  NOK: 'kr', // Norwegian Krone
  DKK: 'kr', // Danish Krone
  PLN: 'zł', // Polish Zloty
  CZK: 'Kč', // Czech Koruna
  HUF: 'Ft', // Hungarian Forint
  RON: 'lei', // Romanian Leu
  BGN: 'лв', // Bulgarian Lev
  HRK: 'kn', // Croatian Kuna
  RUB: '₽', // Russian Ruble
  UAH: '₴', // Ukrainian Hryvnia
  TRY: '₺', // Turkish Lira

  // Asia & Pacific
  JPY: '¥', // Japanese Yen
  CNY: '¥', // Chinese Yuan
  KRW: '₩', // South Korean Won
  INR: '₹', // Indian Rupee
  IDR: 'Rp', // Indonesian Rupiah
  MYR: 'RM', // Malaysian Ringgit
  PHP: '₱', // Philippine Peso
  SGD: '$', // Singapore Dollar
  THB: '฿', // Thai Baht
  VND: '₫', // Vietnamese Dong
  HKD: '$', // Hong Kong Dollar
  TWD: 'NT$', // Taiwan Dollar
  NZD: '$', // New Zealand Dollar
  PKR: '₨', // Pakistani Rupee
  BDT: '৳', // Bangladeshi Taka
  LKR: '₨', // Sri Lankan Rupee

  // Middle East & Africa
  AED: 'د.إ', // UAE Dirham
  SAR: '﷼', // Saudi Riyal
  ILS: '₪', // Israeli New Shekel
  QAR: '﷼', // Qatari Riyal
  KWD: 'د.ك', // Kuwaiti Dinar
  BHD: '.د.ب', // Bahraini Dinar
  OMR: '﷼', // Omani Rial
  JOD: 'د.ا', // Jordanian Dinar
  EGP: '£', // Egyptian Pound
  ZAR: 'R', // South African Rand
  NGN: '₦', // Nigerian Naira
  KES: 'KSh', // Kenyan Shilling
  GHS: '₵', // Ghanaian Cedi

  // Others
  BTC: '₿', // Bitcoin (crypto)
  ETH: 'Ξ', // Ethereum (crypto)
}

/**
 * Get the currency symbol for a given currency code.
 * Defaults to '$' if the currency code is unknown.
 * 
 * @param currencyCode - The ISO 4217 currency code (e.g., 'AUD', 'USD', 'EUR')
 * @returns The currency symbol (e.g., '$', '€', '£')
 */
export function getCurrencySymbol(currencyCode: string | null | undefined): string {
  if (!currencyCode || typeof currencyCode !== 'string') return '$'
  
  const code = currencyCode.trim().toUpperCase()
  return CURRENCY_SYMBOLS[code] ?? '$'
}

/**
 * Get a list of all supported currency codes.
 * @returns Array of currency codes
 */
export function getSupportedCurrencies(): string[] {
  return Object.keys(CURRENCY_SYMBOLS).sort()
}
