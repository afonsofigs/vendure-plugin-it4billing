import { describe, expect, test } from 'vitest';
import { DEFAULT_OPTIONS } from './constants';
import { resolveOptions, validateOptions } from './options';
import type { It4BillingPluginInitOptions, It4BillingPluginOptions } from './types';

const SECRET = 'not-a-real-password';

const required: It4BillingPluginInitOptions = {
	accountId: '000000000',
	credentials: { username: 'integration-user', password: SECRET },
	paymentMethod: 'Card',
	invoiceLines: () => []
};

const resolve = (overrides: Partial<It4BillingPluginOptions> = {}) =>
	({ ...DEFAULT_OPTIONS, ...required, ...overrides }) as It4BillingPluginOptions;

describe('options', () => {
	test('defaults to dry-run, the safe mode', () => {
		expect(resolveOptions(required).mode).toBe('dry-run');
	});

	test('keeps the defaults that were not overridden', () => {
		const options = resolveOptions({ ...required, minRequestIntervalMs: 2000 });
		expect(options.minRequestIntervalMs).toBe(2000);
		expect(options.customerPdf).toBe('original-page');
		expect(options.taxTypeIds).toEqual({ normal: 1, reduced: 2, intermediate: 3, exempt: 4 });
	});

	test('the default comments are the order code', () => {
		const options = resolveOptions(required);
		expect(options.comments({ code: 'ABC123' } as never)).toBe('ABC123');
	});

	test('valid options have no errors', () => {
		expect(validateOptions(resolve())).toEqual([]);
	});

	test.each([
		['baseUrl', { baseUrl: 'not a url' }],
		['baseUrl', { baseUrl: 'http://app.example.test' }],
		['accountId', { accountId: '' }],
		['accountId', { accountId: '12345' }],
		['credentials', { credentials: { username: 'integration-user', password: '' } }],
		['mode', { mode: 'production' as never }],
		['liveOrderCodes', { liveOrderCodes: ['ABC', ''] }],
		['paymentMethod', { paymentMethod: ' ' }],
		['minRequestIntervalMs', { minRequestIntervalMs: 100 }],
		['requestTimeoutMs', { requestTimeoutMs: 0 }],
		['maxAutomaticRetries', { maxAutomaticRetries: -1 }],
		['retryDelayMs', { retryDelayMs: 1.5 }],
		['customerPdf', { customerPdf: 'first' as never }],
		['taxTypeIds', { taxTypeIds: { normal: 1, reduced: 2, intermediate: 3 } as never }],
		['nifCustomField', { nifCustomField: '' }],
		['billingDetails', { billingDetails: 'default' as never }],
		['invoiceLines', { invoiceLines: undefined as never }],
		['comments', { comments: 'order' as never }]
	])('reports an invalid %s', (name, overrides) => {
		const errors = validateOptions(resolve(overrides));
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain(name);
	});

	test('accepts an account id with a suffix', () => {
		expect(validateOptions(resolve({ accountId: '000000000_Demo' }))).toEqual([]);
	});

	test('throws at init with every error listed, and never the password', () => {
		const call = () =>
			resolveOptions({ ...required, accountId: 'x', mode: 'nope' as never, paymentMethod: '' });
		expect(call).toThrow(/accountId[\s\S]*mode[\s\S]*paymentMethod/);
		try {
			call();
		} catch (e) {
			expect(String(e)).not.toContain(SECRET);
		}
	});
});
