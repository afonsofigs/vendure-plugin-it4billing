import type { Injector, Order, RequestContext } from '@vendure/core';

/**
 * @description
 * `dry-run` logs in, builds the whole document and checks its totals, then logs out without
 * saving. Nothing is written to the IT4Billing account, not even a customer or an article.
 * `live` saves the document, which issues a certified tax document that can never be deleted.
 */
export type It4BillingMode = 'dry-run' | 'live';

/**
 * @description
 * The VAT categories of IT4Billing. The rate behind each one (for example 23%, 13% and 6% in
 * mainland Portugal) is configured in the IT4Billing account, not in this plugin.
 */
export type It4BillingTaxType = 'normal' | 'intermediate' | 'reduced' | 'exempt';

/**
 * @description
 * The product type of an article, as it is reported in the SAF-T (PT) file.
 */
export type It4BillingProductType = 'product' | 'service' | 'other';

export interface It4BillingCredentials {
	username: string;
	password: string;
}

/**
 * @description
 * Who the invoice is issued to. The plugin refuses to issue an invoice without a valid NIF.
 */
export interface BillingDetails {
	/** Portuguese tax number (NIF). Validated with its check digit before any request is made. */
	nif: string;
	/** Name printed on the invoice: the company or person the NIF belongs to. Max 150 characters. */
	name: string;
	streetLine: string;
	postalCode: string;
	city: string;
	/** ISO 3166-1 alpha-2 country code, for example `PT`. */
	countryCode: string;
}

/**
 * @description
 * An article in IT4Billing. The plugin looks it up by `reference` and, the first time it is needed,
 * creates it with these values. An existing article is never edited.
 */
export interface ArticleSpec {
	/** Unique reference in IT4Billing. Max 20 characters; short ones print on a single line. */
	reference: string;
	/** Max 150 characters. */
	name: string;
	productType: It4BillingProductType;
	/** Unit as configured in IT4Billing, for example `Un`. */
	unit: string;
	taxType: It4BillingTaxType;
	/** List price per unit excluding VAT, in cents. */
	netUnitPrice: number;
}

/**
 * @description
 * One line of the invoice. IT4Billing has no free-text lines: every line points to an article.
 */
export interface InvoiceLineSpec {
	article: ArticleSpec;
	/** Printed description. Defaults to the article name. Max 150 characters. */
	description?: string;
	quantity: number;
	/** Line discount in percent, from 0 to 100, with at most 2 decimal places. */
	discountPercent: number;
}

export type OrderStrategy<T> = (
	ctx: RequestContext,
	order: Order,
	injector: Injector
) => T | Promise<T>;

export interface It4BillingPluginOptions {
	/**
	 * @description
	 * Base URL of the IT4Billing web application.
	 * @default 'https://app.it4billing.com'
	 */
	baseUrl: string;

	/**
	 * @description
	 * The account segment of the IT4Billing URL: `https://app.it4billing.com/<accountId>/`.
	 * It is normally the company's NIF.
	 */
	accountId: string;

	/**
	 * @description
	 * A dedicated IT4Billing user for this integration. Read the values from environment variables or
	 * a secret store; never write them in code. A failed login is never retried: the queue pauses
	 * until an administrator resumes it, so a wrong password cannot lock the user out.
	 */
	credentials: It4BillingCredentials;

	/**
	 * @description
	 * See {@link It4BillingMode}. The default is the safe one.
	 * @default 'dry-run'
	 */
	mode: It4BillingMode;

	/**
	 * @description
	 * In `live` mode, only these order codes may be invoiced. Meant for a supervised first emission.
	 * Leave it undefined to allow every eligible order.
	 */
	liveOrderCodes?: string[];

	/**
	 * @description
	 * Name of the payment method exactly as it is listed in IT4Billing, for example `Card`.
	 */
	paymentMethod: string;

	/**
	 * @description
	 * Minimum time between two requests to IT4Billing, so the integration uses the account at the pace
	 * of a person. Values below 500 ms are rejected.
	 * @default 1500
	 */
	minRequestIntervalMs: number;

	/**
	 * @description
	 * Timeout of each request to IT4Billing.
	 * @default 30000
	 */
	requestTimeoutMs: number;

	/**
	 * @description
	 * Automatic retries of a failed emission. They only happen while the document has not been sent
	 * for saving; after that point the plugin never retries on its own.
	 * @default 2
	 */
	maxAutomaticRetries: number;

	/**
	 * @description
	 * Delay between automatic retries.
	 * @default 900000 (15 minutes)
	 */
	retryDelayMs: number;

	/**
	 * @description
	 * IT4Billing prints the original and its copies in one PDF. `original-page` gives the customer only
	 * the first page; the full PDF is always kept as the archive copy.
	 * @default 'original-page'
	 */
	customerPdf: 'original-page' | 'all-pages';

	/**
	 * @description
	 * Ids of the IT4Billing tax types, as used by the document line form.
	 * @default { normal: 1, reduced: 2, intermediate: 3, exempt: 4 }
	 */
	taxTypeIds: Record<It4BillingTaxType, number>;

	/**
	 * @description
	 * Whether an order can be invoiced at all. Orders that are not eligible never show an invoice
	 * action. By default, an order is eligible once its payment is settled.
	 */
	isEligible?: OrderStrategy<boolean>;

	/**
	 * @description
	 * Who the invoice is issued to. Return `undefined` when the customer has no valid billing details;
	 * the plugin then reports that a NIF is missing and issues nothing. By default, the customer's
	 * default billing address, with the NIF read from the address custom field `nifCustomField`.
	 */
	billingDetails?: OrderStrategy<BillingDetails | undefined>;

	/**
	 * @description
	 * Address custom field that holds the NIF, used by the default `billingDetails` strategy.
	 * @default 'nif'
	 */
	nifCustomField: string;

	/**
	 * @description
	 * The invoice lines for an order. This is where a store maps its products to IT4Billing articles,
	 * tax types and line discounts. Required.
	 */
	invoiceLines: OrderStrategy<InvoiceLineSpec[]>;

	/**
	 * @description
	 * Text for the document comments field, which IT4Billing limits to 50 characters. It should contain
	 * the order code: the plugin uses it to reconcile an emission whose result is unknown.
	 * @default (order) => order.code
	 */
	comments: (order: Order) => string;
}

/**
 * @description
 * What `It4BillingPlugin.init()` takes: the required options plus any default to override.
 */
export type It4BillingPluginInitOptions = Pick<
	It4BillingPluginOptions,
	'accountId' | 'credentials' | 'paymentMethod' | 'invoiceLines'
> &
	Partial<
		Omit<It4BillingPluginOptions, 'accountId' | 'credentials' | 'paymentMethod' | 'invoiceLines'>
	>;
