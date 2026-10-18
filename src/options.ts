import { DEFAULT_OPTIONS, MIN_REQUEST_INTERVAL_FLOOR_MS } from './constants';
import type {
	It4BillingPluginInitOptions,
	It4BillingPluginOptions,
	It4BillingTaxType
} from './types';

const TAX_TYPES: It4BillingTaxType[] = ['normal', 'intermediate', 'reduced', 'exempt'];

/**
 * @description
 * Every problem with the options, as human-readable messages. The messages never contain the
 * credentials, so they are safe to log.
 */
export function validateOptions(options: It4BillingPluginOptions): string[] {
	const errors: string[] = [];
	const isPositiveInt = (v: unknown) => Number.isInteger(v) && (v as number) > 0;

	// A local address can only be a test server, never a real account: it may use http and a short
	// interval between requests.
	let local = false;
	try {
		const url = new URL(options.baseUrl);
		local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
		if (url.protocol !== 'https:' && !local) errors.push('baseUrl must use https');
	} catch {
		errors.push('baseUrl must be a valid URL');
	}
	if (typeof options.accountId !== 'string' || !/^\d{9}(_[A-Za-z]+)?$/.test(options.accountId)) {
		errors.push('accountId must be the account segment of the IT4Billing URL (nine digits)');
	}
	if (!options.credentials?.username || !options.credentials?.password) {
		errors.push('credentials.username and credentials.password are required');
	}
	if (options.mode !== 'dry-run' && options.mode !== 'live') {
		errors.push("mode must be 'dry-run' or 'live'");
	}
	if (
		options.liveOrderCodes !== undefined &&
		(!Array.isArray(options.liveOrderCodes) ||
			options.liveOrderCodes.some((code) => typeof code !== 'string' || !code))
	) {
		errors.push('liveOrderCodes must be a list of order codes');
	}
	if (typeof options.paymentMethod !== 'string' || !options.paymentMethod.trim()) {
		errors.push('paymentMethod is required');
	}
	if (
		!isPositiveInt(options.minRequestIntervalMs) ||
		(!local && options.minRequestIntervalMs < MIN_REQUEST_INTERVAL_FLOOR_MS)
	) {
		errors.push(`minRequestIntervalMs must be at least ${MIN_REQUEST_INTERVAL_FLOOR_MS}`);
	}
	if (!isPositiveInt(options.requestTimeoutMs)) {
		errors.push('requestTimeoutMs must be a positive integer');
	}
	if (
		typeof options.userAgent !== 'string' ||
		!options.userAgent.startsWith('Mozilla/5.0') ||
		/[\r\n]/.test(options.userAgent)
	) {
		errors.push(
			'userAgent must be a single line starting with Mozilla/5.0, or IT4Billing serves pages the plugin cannot use'
		);
	}
	if (!Number.isInteger(options.maxAutomaticRetries) || options.maxAutomaticRetries < 0) {
		errors.push('maxAutomaticRetries must be zero or a positive integer');
	}
	if (!isPositiveInt(options.retryDelayMs)) {
		errors.push('retryDelayMs must be a positive integer');
	}
	if (options.customerPdf !== 'original-page' && options.customerPdf !== 'all-pages') {
		errors.push("customerPdf must be 'original-page' or 'all-pages'");
	}
	if (!TAX_TYPES.every((type) => isPositiveInt(options.taxTypeIds?.[type]))) {
		errors.push(`taxTypeIds must have a positive integer id for ${TAX_TYPES.join(', ')}`);
	}
	if (typeof options.nifCustomField !== 'string' || !options.nifCustomField) {
		errors.push('nifCustomField is required');
	}
	for (const name of ['isEligible', 'billingDetails'] as const) {
		if (options[name] !== undefined && typeof options[name] !== 'function') {
			errors.push(`${name} must be a function`);
		}
	}
	if (typeof options.invoiceLines !== 'function') errors.push('invoiceLines must be a function');
	if (typeof options.comments !== 'function') errors.push('comments must be a function');
	if (typeof options.documentType !== 'string' || !options.documentType.trim()) {
		errors.push('documentType is required');
	}
	if (options.referenceDate !== undefined && typeof options.referenceDate !== 'function') {
		errors.push('referenceDate must be a function');
	}
	if (typeof options.storage?.save !== 'function' || typeof options.storage?.read !== 'function') {
		errors.push('storage must implement save() and read()');
	}
	if (
		options.orderRelations !== undefined &&
		(!Array.isArray(options.orderRelations) ||
			options.orderRelations.some((r) => typeof r !== 'string' || !r))
	) {
		errors.push('orderRelations must be a list of relation paths');
	}
	for (const name of ['dryRunCustomerSearch', 'dryRunArticleReference'] as const) {
		if (options[name] !== undefined && (typeof options[name] !== 'string' || !options[name])) {
			errors.push(`${name} must be a non-empty string`);
		}
	}
	return errors;
}

/**
 * @description
 * Merges the options with the defaults and throws if they are invalid, so a misconfigured plugin
 * stops the server at startup instead of failing on a customer's first invoice.
 */
export function resolveOptions(options: It4BillingPluginInitOptions): It4BillingPluginOptions {
	const resolved: It4BillingPluginOptions = { ...DEFAULT_OPTIONS, ...options };
	const errors = validateOptions(resolved);
	if (errors.length) {
		throw new Error(`Invalid It4BillingPlugin options:\n- ${errors.join('\n- ')}`);
	}
	return resolved;
}
