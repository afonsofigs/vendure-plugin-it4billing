import { RequestContext, VendureEvent } from '@vendure/core';
import type { It4BillingInvoice } from './entities/invoice.entity';

/**
 * - `issued`: the invoice was issued and its PDF stored.
 * - `pdf_missing`: the invoice was issued but its PDF could not be stored. It is not printed again
 *   automatically.
 * - `failed`: the emission stopped before saving. Nothing was issued.
 * - `needs_review`: the save may or may not have happened. Check IT4Billing before doing anything.
 * - `queue_paused`: IT4Billing refused the login. Nothing runs until an administrator resumes.
 * - `dry_run`: a dry run finished.
 */
export type It4BillingEventType =
	| 'issued'
	| 'pdf_missing'
	| 'failed'
	| 'needs_review'
	| 'queue_paused'
	| 'dry_run';

/**
 * @description
 * Published on every outcome worth knowing. Subscribe to it to alert someone, for example with an
 * email handler, on `failed`, `needs_review`, `pdf_missing` and `queue_paused`.
 */
export class It4BillingInvoiceEvent extends VendureEvent {
	constructor(
		public ctx: RequestContext,
		public type: It4BillingEventType,
		public invoice: It4BillingInvoice | undefined,
		public message: string
	) {
		super();
	}
}
