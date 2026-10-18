import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { IT4BILLING_PLUGIN_OPTIONS } from './constants';
import { resolveOptions } from './options';
import type { It4BillingPluginInitOptions, It4BillingPluginOptions } from './types';

/**
 * @description
 * Issues invoice-receipts in IT4Billing for Vendure orders and keeps the PDF for the customer.
 *
 * @example
 * ```ts
 * It4BillingPlugin.init({
 *   accountId: process.env.IT4BILLING_ACCOUNT_ID,
 *   credentials: {
 *     username: process.env.IT4BILLING_USER,
 *     password: process.env.IT4BILLING_PASSWORD
 *   },
 *   paymentMethod: 'Card',
 *   invoiceLines: (ctx, order) => order.lines.map(toInvoiceLine)
 * })
 * ```
 */
@VendurePlugin({
	imports: [PluginCommonModule],
	providers: [{ provide: IT4BILLING_PLUGIN_OPTIONS, useFactory: () => It4BillingPlugin.options }],
	compatibility: '^3.0.0'
})
export class It4BillingPlugin {
	static options: It4BillingPluginOptions;

	static init(options: It4BillingPluginInitOptions) {
		It4BillingPlugin.options = resolveOptions(options);
		return It4BillingPlugin;
	}
}
