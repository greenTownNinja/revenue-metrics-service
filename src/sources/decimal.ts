/**
 * Exact decimal-string → integer minor units.
 *
 * Some providers (PayPal) report money as a decimal string: `"45.00"`, `"1234.5"`.
 * The obvious conversion — `Math.round(parseFloat(v) * 100)` — is wrong in the way
 * this whole service exists to avoid: `19.99 * 100` is `1998.9999999999998`, and
 * values past 2^53 lose digits outright. This does it on the string, so no float
 * is ever involved.
 */

/**
 * Currency exponents that are not 2. ISO 4217 minor-unit counts, restricted to
 * the currencies PayPal actually supports — HUF, JPY and TWD take no decimals
 * there, so `"1500"` means 1500 units, not 15.00.
 */
const EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  huf: 0,
  jpy: 0,
  twd: 0,
});

export const DEFAULT_EXPONENT = 2;

export function currencyExponent(currency: string): number {
  return EXPONENTS[currency.trim().toLowerCase()] ?? DEFAULT_EXPONENT;
}

export class DecimalParseError extends Error {}

/**
 * Parses a decimal money string into integer minor units for `currency`.
 *
 * Rejects rather than rounds when the string carries more precision than the
 * currency has: `"10.005"` in USD is not a representable amount, and silently
 * rounding it would be a half-cent of invented or destroyed revenue. Trailing
 * zeros beyond the exponent are fine — `"10.5000"` in USD is unambiguously 1050.
 */
export function parseDecimalToMinor(value: string, currency: string): bigint {
  const raw = (value ?? '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new DecimalParseError(`not a decimal number: '${value}'`);
  }

  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole = '0', fraction = ''] = unsigned.split('.');

  const exponent = currencyExponent(currency);

  // Anything beyond the currency's precision must be zeros, or the value is not
  // representable and we refuse to guess.
  const significant = fraction.slice(0, exponent);
  const excess = fraction.slice(exponent);
  if (/[^0]/.test(excess)) {
    throw new DecimalParseError(
      `'${value}' has more precision than ${currency.toUpperCase()} supports (${exponent} decimals)`,
    );
  }

  const padded = significant.padEnd(exponent, '0');
  const minor = BigInt(whole + padded);
  return negative ? -minor : minor;
}
