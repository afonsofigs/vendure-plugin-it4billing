/**
 * Portuguese tax number (NIF) helpers. The check digit is validated locally, so an invalid number
 * never reaches IT4Billing.
 */

const VALID_FIRST_DIGITS = ['1', '2', '3', '5', '6', '8', '9'];
const VALID_PREFIXES = ['45', '70', '71', '72', '74', '75', '77', '79'];

/**
 * @description
 * Removes spaces, dots and dashes, and an optional `PT` country prefix.
 */
export function normalizeNif(value: string): string {
	return value
		.trim()
		.replace(/^PT/i, '')
		.replace(/[\s.-]/g, '');
}

/**
 * @description
 * The check digit for the first eight digits of a NIF.
 */
export function nifCheckDigit(firstEight: string): number {
	const sum = [...firstEight].reduce((acc, digit, i) => acc + Number(digit) * (9 - i), 0);
	const rest = 11 - (sum % 11);
	return rest >= 10 ? 0 : rest;
}

/**
 * @description
 * Whether `value` is a well-formed Portuguese NIF: nine digits, a valid leading digit or prefix, and
 * a matching check digit. It does not tell whether the number belongs to anyone.
 */
export function isValidNif(value: string): boolean {
	const nif = normalizeNif(value);
	if (!/^\d{9}$/.test(nif)) return false;
	if (!VALID_FIRST_DIGITS.includes(nif[0]) && !VALID_PREFIXES.includes(nif.slice(0, 2))) {
		return false;
	}
	return nifCheckDigit(nif.slice(0, 8)) === Number(nif[8]);
}
