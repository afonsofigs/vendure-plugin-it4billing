/**
 * Money and number formats used by IT4Billing (Portuguese locale): `1.234,56 €`.
 */

/**
 * @description
 * Parses a Portuguese-formatted amount into integer cents. Returns `undefined` for an empty value.
 * Amounts with more than two decimals are rounded half up, as IT4Billing does on line totals.
 */
export function parseAmount(text: string): number | undefined {
	const clean = text.replace(/[€%\s\u00a0]/g, '');
	if (!clean) return undefined;
	if (!/^-?[\d.]*\d(,\d+)?$/.test(clean)) {
		throw new Error(`Not an amount: ${JSON.stringify(text)}`);
	}
	const [int, dec = ''] = clean.replace(/\./g, '').split(',');
	const sign = int.startsWith('-') ? -1 : 1;
	const units = Math.abs(Number(int));
	const thousandths = Number(`${dec}000`.slice(0, 3));
	return sign * (units * 100 + Math.round(thousandths / 10));
}

/**
 * @description
 * Formats integer cents the way a person types an amount in IT4Billing: `7876` becomes `78,76`.
 */
export function formatCents(cents: number): string {
	if (!Number.isInteger(cents)) throw new Error(`Cents must be an integer, got ${cents}`);
	const sign = cents < 0 ? '-' : '';
	const abs = Math.abs(cents);
	return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

/**
 * @description
 * Formats a quantity or a percentage with a comma decimal separator and two decimals.
 */
export function formatDecimal(value: number): string {
	if (!Number.isFinite(value)) throw new Error(`Not a number: ${value}`);
	return value.toFixed(2).replace('.', ',');
}

/**
 * @description
 * Formats a date as `dd-mm-yyyy`, the format of IT4Billing date fields.
 */
export function formatDate(date: Date): string {
	const dd = String(date.getDate()).padStart(2, '0');
	const mm = String(date.getMonth() + 1).padStart(2, '0');
	return `${dd}-${mm}-${date.getFullYear()}`;
}
