import type { It4BillingPluginOptions } from './types';

export const IT4BILLING_PLUGIN_OPTIONS = Symbol('IT4BILLING_PLUGIN_OPTIONS');

export const loggerCtx = 'It4BillingPlugin';

/** IT4Billing limits the document comments field to this many characters. */
export const COMMENTS_MAX_LENGTH = 50;

/** IT4Billing limits an article reference to this many characters. */
export const ARTICLE_REFERENCE_MAX_LENGTH = 20;

/** IT4Billing limits article names and line descriptions to this many characters. */
export const TEXT_MAX_LENGTH = 150;

/** Floor for `minRequestIntervalMs`: the integration must not hammer the account. */
export const MIN_REQUEST_INTERVAL_FLOOR_MS = 500;

export const DEFAULT_OPTIONS: Omit<
	It4BillingPluginOptions,
	'accountId' | 'credentials' | 'paymentMethod' | 'invoiceLines'
> = {
	baseUrl: 'https://app.it4billing.com',
	mode: 'dry-run',
	minRequestIntervalMs: 1500,
	requestTimeoutMs: 30000,
	maxAutomaticRetries: 2,
	retryDelayMs: 15 * 60 * 1000,
	customerPdf: 'original-page',
	taxTypeIds: { normal: 1, reduced: 2, intermediate: 3, exempt: 4 },
	nifCustomField: 'nif',
	comments: (order) => order.code
};
