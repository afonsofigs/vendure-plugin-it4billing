import { DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity } from 'typeorm';

/**
 * Single row: whether the queue is paused (after a refused login) and the lease that lets only one
 * worker use the IT4Billing account at a time, across processes and servers.
 */
@Entity()
export class It4BillingQueueState extends VendureEntity {
	constructor(input?: DeepPartial<It4BillingQueueState>) {
		super(input);
	}

	@Column({ default: false })
	paused: boolean;

	@Column({ type: 'text', nullable: true })
	pausedReason: string | null;

	@Column({ type: Date, nullable: true })
	pausedAt: Date | null;

	@Column({ type: 'varchar', nullable: true })
	leaseToken: string | null;

	@Column({ type: Date, nullable: true })
	leaseUntil: Date | null;
}
