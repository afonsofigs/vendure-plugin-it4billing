import { DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

/**
 * - `pending`: waiting for the queue (also between automatic retries).
 * - `preparing`: a worker is building the document. Nothing has been sent for saving.
 * - `saving`: the save request is being sent. If anything goes wrong from here, the outcome is
 *   unknown and the invoice goes to `needs_review`: it is never retried automatically.
 * - `issued`: IT4Billing assigned a number.
 * - `failed`: stopped before saving. Nothing was issued; an administrator can retry it.
 * - `needs_review`: the save may or may not have happened. A person must check IT4Billing.
 * - `dry_run`: a dry run built and checked the document. Nothing was issued.
 */
export type InvoiceStatus =
	| 'pending'
	| 'preparing'
	| 'saving'
	| 'issued'
	| 'failed'
	| 'needs_review'
	| 'dry_run';

/**
 * One invoice per order: the order id is unique, so concurrent requests end up on the same record.
 */
@Entity()
@Index(['orderId'], { unique: true })
export class It4BillingInvoice extends VendureEntity {
	constructor(input?: DeepPartial<It4BillingInvoice>) {
		super(input);
	}

	@EntityId()
	orderId: ID;

	@Column()
	orderCode: string;

	@Column('varchar')
	status: InvoiceStatus;

	@Column({ default: false })
	dryRun: boolean;

	@Column({ default: 0 })
	attempts: number;

	@Column({ type: Date, nullable: true })
	nextAttemptAt: Date | null;

	/** Set by the worker that claimed the record, to make the claim atomic on any database. */
	@Column({ type: 'varchar', nullable: true })
	claimToken: string | null;

	@Column({ type: 'varchar', nullable: true })
	documentNumber: string | null;

	/** Document total in cents, as IT4Billing computed it before saving. */
	@Column({ type: 'int', nullable: true })
	total: number | null;

	@Column({ type: Date, nullable: true })
	issuedAt: Date | null;

	@Column({ type: 'varchar', nullable: true })
	archivePdfKey: string | null;

	@Column({ type: 'varchar', nullable: true })
	customerPdfKey: string | null;

	@Column({ type: 'varchar', nullable: true })
	failureReason: string | null;

	@Column({ type: 'text', nullable: true })
	lastError: string | null;

	/** JSON: what a dry run checked and what it would have created. */
	@Column({ type: 'text', nullable: true })
	dryRunReport: string | null;
}
