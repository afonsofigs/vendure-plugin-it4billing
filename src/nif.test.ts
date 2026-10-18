import { describe, expect, test } from 'vitest';
import { isValidNif, nifCheckDigit, normalizeNif } from './nif';

// Valid numbers are built here from arbitrary prefixes, so no real taxpayer is written in the tests.
const withCheckDigit = (firstEight: string) => `${firstEight}${nifCheckDigit(firstEight)}`;

describe('nif', () => {
	test('accepts the generic final-consumer NIF', () => {
		expect(isValidNif('999999990')).toBe(true);
	});

	test.each(['1', '2', '3', '5', '6', '8', '9'])('accepts numbers starting with %s', (first) => {
		expect(isValidNif(withCheckDigit(`${first}2345678`))).toBe(true);
	});

	test.each(['45', '70', '71', '72', '74', '75', '77', '79'])('accepts the prefix %s', (prefix) => {
		expect(isValidNif(withCheckDigit(`${prefix}345678`))).toBe(true);
	});

	test.each(['0', '4', '7'])(
		'rejects numbers starting with %s outside the valid prefixes',
		(first) => {
			expect(isValidNif(withCheckDigit(`${first}3345678`))).toBe(false);
		}
	);

	test('rejects a wrong check digit', () => {
		const valid = withCheckDigit('12345678');
		const wrong = `${valid.slice(0, 8)}${(Number(valid[8]) + 1) % 10}`;
		expect(isValidNif(wrong)).toBe(false);
	});

	test.each(['', '12345678', '1234567890', '12345678a', 'abcdefghi'])('rejects %j', (value) => {
		expect(isValidNif(value)).toBe(false);
	});

	test('normalizes spaces, separators and the PT prefix', () => {
		const valid = withCheckDigit('51234567');
		const spaced = `PT ${valid.slice(0, 3)} ${valid.slice(3, 6)}.${valid.slice(6)}`;
		expect(normalizeNif(spaced)).toBe(valid);
		expect(isValidNif(spaced)).toBe(true);
	});

	test('a check digit of 10 or 11 becomes 0', () => {
		// 99999999 sums to 396, a multiple of 11, so the check digit is 0.
		expect(nifCheckDigit('99999999')).toBe(0);
	});
});
