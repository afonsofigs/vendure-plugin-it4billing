import { PluginCommonModule, ScheduledTask, VendurePlugin } from '@vendure/core';
import { InvoiceDownloadController } from './api/download.controller';
import {
	AdminInvoiceResolver,
	ShopInvoiceResolver,
	ShopOrderInvoiceResolver
} from './api/resolvers';
import { adminSchema, shopSchema } from './api/schema';
import { IT4BILLING_PLUGIN_OPTIONS } from './constants';
import { It4BillingInvoice } from './entities/invoice.entity';
import { It4BillingQueueState } from './entities/queue-state.entity';
import { resolveOptions } from './options';
import { It4BillingService } from './service/invoice.service';
import type { It4BillingPluginInitOptions, It4BillingPluginOptions } from './types';

/**
 * Retries and crash recovery. Needs a scheduler plugin (for example `DefaultSchedulerPlugin`).
 */
export const processDueInvoicesTask = new ScheduledTask({
	id: 'it4billing-process-due',
	description: 'Queues IT4Billing invoices whose retry time has come',
	schedule: (cron) => cron.every(5).minutes(),
	async execute({ injector }) {
		await injector.get(It4BillingService).processDue();
		return { ok: true };
	}
});

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
	entities: [It4BillingInvoice, It4BillingQueueState],
	providers: [
		It4BillingService,
		{ provide: IT4BILLING_PLUGIN_OPTIONS, useFactory: () => It4BillingPlugin.options }
	],
	controllers: [InvoiceDownloadController],
	shopApiExtensions: {
		schema: shopSchema,
		resolvers: [ShopInvoiceResolver, ShopOrderInvoiceResolver]
	},
	adminApiExtensions: { schema: adminSchema, resolvers: [AdminInvoiceResolver] },
	configuration: (config) => {
		config.schedulerOptions.tasks.push(processDueInvoicesTask);
		return config;
	},
	compatibility: '^3.0.0'
})
export class It4BillingPlugin {
	static options: It4BillingPluginOptions;

	static init(options: It4BillingPluginInitOptions) {
		It4BillingPlugin.options = resolveOptions(options);
		return It4BillingPlugin;
	}
}
