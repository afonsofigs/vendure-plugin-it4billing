import { LocalInvoiceStorageStrategy } from './storage';
import type { It4BillingPluginOptions } from './types';

/** Kept in sync with package.json by a test. */
export const PLUGIN_VERSION = '0.2.0';

/**
 * Honest User-Agent that names the plugin. IT4Billing (ASP.NET) needs a `Mozilla/5.0` token to
 * serve its full pages; with an unknown agent it serves a reduced version without partial postbacks.
 */
export const DEFAULT_USER_AGENT = `Mozilla/5.0 (compatible; vendure-plugin-it4billing/${PLUGIN_VERSION})`;

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
	userAgent: DEFAULT_USER_AGENT,
	maxAutomaticRetries: 2,
	retryDelayMs: 15 * 60 * 1000,
	customerPdf: 'original-page',
	taxTypeIds: { normal: 1, reduced: 2, intermediate: 3, exempt: 4 },
	nifCustomField: 'nif',
	comments: (order) => order.code,
	documentType: 'Fatura-Recibo',
	storage: new LocalInvoiceStorageStrategy('./it4billing-invoices')
};

/** Name of the job queue that issues invoices, one at a time. */
export const ISSUE_QUEUE = 'it4billing-issue';

/** How long a worker holds the account lease while it issues one invoice. */
export const LEASE_MS = 10 * 60 * 1000;
