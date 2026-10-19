import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
	EventBus,
	ForbiddenError,
	ID,
	Injector,
	JobQueue,
	JobQueueService,
	Logger,
	Order,
	OrderService,
	RequestContext,
	RequestContextService,
	TransactionalConnection,
	UserInputError
} from '@vendure/core';
import { randomUUID } from 'node:crypto';
import {
	It4BillingClient,
	LoginFailedError,
	SessionExpiredError,
	TransportError,
	UnexpectedPageError,
	type ClientDetails,
	type ClientRecord,
	countryName
} from '../client';
import {
	ARTICLE_REFERENCE_MAX_LENGTH,
	COMMENTS_MAX_LENGTH,
	IT4BILLING_PLUGIN_OPTIONS,
	ISSUE_QUEUE,
	LEASE_MS,
	loggerCtx,
	TEXT_MAX_LENGTH
} from '../constants';
import { It4BillingInvoice, type InvoiceStatus } from '../entities/invoice.entity';
import { It4BillingQueueState } from '../entities/queue-state.entity';
import { It4BillingInvoiceEvent, type It4BillingEventType } from '../events';
import { isValidNif, normalizeNif } from '../nif';
import { originalPage } from '../pdf';
import type { BillingDetails, InvoiceLineSpec, It4BillingPluginOptions } from '../types';

export type CustomerInvoiceStatus =
	| 'NONE'
	| 'MISSING_NIF'
	| 'PREPARING'
	| 'ISSUED'
	| 'NOT_ELIGIBLE';

export interface CustomerInvoiceView {
	status: CustomerInvoiceStatus;
	documentNumber?: string;
	issuedAt?: Date;
	downloadPath?: string;
}

interface JobData {
	invoiceId: ID;
	channelToken: string;
}

/** A failure that retrying cannot fix: wrong data, a totals mismatch, a refused line. */
class PermanentFailure extends Error {
	constructor(
		readonly reason: string,
		message: string
	) {
		super(message);
	}
}

const DEFAULT_RELATIONS = [
	'lines',
	'lines.productVariant',
	'lines.productVariant.translations',
	'lines.productVariant.facetValues',
	'lines.productVariant.facetValues.facet',
	'lines.productVariant.product',
	'lines.productVariant.product.translations',
	'lines.productVariant.product.facetValues',
	'lines.productVariant.product.facetValues.facet',
	'customer',
	'customer.user',
	'customer.addresses',
	'customer.addresses.country',
	'payments'
];

const ELIGIBLE_STATES = [
	'PaymentSettled',
	'PartiallyShipped',
	'Shipped',
	'PartiallyDelivered',
	'Delivered'
];

@Injectable()
export class It4BillingService implements OnModuleInit {
	private queue: JobQueue<JobData>;

	constructor(
		private readonly connection: TransactionalConnection,
		private readonly orderService: OrderService,
		private readonly jobQueueService: JobQueueService,
		private readonly eventBus: EventBus,
		private readonly requestContextService: RequestContextService,
		private readonly moduleRef: ModuleRef,
		@Inject(IT4BILLING_PLUGIN_OPTIONS) private readonly options: It4BillingPluginOptions
	) {}

	async onModuleInit() {
		this.queue = await this.jobQueueService.createQueue<JobData>({
			name: ISSUE_QUEUE,
			process: async (job) => {
				const ctx = await this.adminContext(job.data.channelToken);
				await this.processInvoice(ctx, job.data.invoiceId);
			}
		});
	}

	// ---- Customer side -----------------------------------------------------------------------

	/** What the customer sees for an order. Never exposes a technical error. */
	async customerView(ctx: RequestContext, orderId: ID): Promise<CustomerInvoiceView> {
		const order = await this.loadOrder(ctx, orderId);
		if (!(await this.visibleToCustomer(ctx, order))) return { status: 'NOT_ELIGIBLE' };
		return this.viewFor(ctx, order, await this.findByOrder(ctx, order.id));
	}

	/**
	 * Asks for the invoice of one of the customer's orders. Idempotent: every call for the same order
	 * ends on the same record, and only the call that created it queues the emission.
	 */
	async requestForCustomer(ctx: RequestContext, orderCode: string): Promise<CustomerInvoiceView> {
		const order = await this.orderService.findOneByCode(ctx, orderCode, DEFAULT_RELATIONS as never);
		if (!order || !ctx.activeUserId || order.customer?.user?.id !== ctx.activeUserId) {
			throw new ForbiddenError();
		}
		if (!(await this.visibleToCustomer(ctx, order))) return { status: 'NOT_ELIGIBLE' };
		return this.request(ctx, order.id);
	}

	/**
	 * Asks for the invoice of an order on behalf of the customer, from the Admin API. Not affected by
	 * `customerVisible`, so a team can run the first emissions before customers see invoices.
	 */
	async requestForAdmin(
		ctx: RequestContext,
		orderCode: string,
		dryRun = false
	): Promise<It4BillingInvoice> {
		const order = await this.orderService.findOneByCode(ctx, orderCode, []);
		if (!order) throw new UserInputError(`No order ${orderCode}`);
		if (dryRun) return this.dryRunForAdmin(ctx, order.id, orderCode);
		const view = await this.request(ctx, order.id);
		const invoice = await this.findByOrder(ctx, order.id);
		if (!invoice) throw new UserInputError(`${orderCode} cannot be invoiced: ${view.status}`);
		return invoice;
	}

	/**
	 * A dry run asked by an administrator, also in `live` mode: the document is built in IT4Billing and
	 * checked, and nothing is saved. Only for an order without a real invoice; a later real request
	 * turns the dry run into the emission.
	 */
	private async dryRunForAdmin(
		ctx: RequestContext,
		orderId: ID,
		orderCode: string
	): Promise<It4BillingInvoice> {
		const order = await this.loadOrder(ctx, orderId);
		const existing = await this.findByOrder(ctx, order.id);
		if (existing && !existing.dryRun) {
			throw new UserInputError(`${orderCode} already has an invoice record: ${existing.status}`);
		}
		const view = await this.viewFor(ctx, order, undefined);
		if (view.status !== 'NONE') {
			throw new UserInputError(`${orderCode} cannot be invoiced: ${view.status}`);
		}
		const invoice = existing
			? await this.compareAndSet(ctx, existing.id, ['dry_run', 'failed'], {
					status: 'pending',
					attempts: 0,
					nextAttemptAt: null,
					failureReason: null,
					lastError: null,
					dryRunReport: null
				})
			: await this.insertOnce(ctx, order, 'pending', true);
		if (!invoice) throw new UserInputError(`${orderCode} is being processed right now`);
		await this.enqueue(ctx, invoice.id);
		return invoice;
	}

	async request(ctx: RequestContext, orderId: ID): Promise<CustomerInvoiceView> {
		const order = await this.loadOrder(ctx, orderId);
		const existing = await this.findByOrder(ctx, order.id);
		const live = this.options.mode === 'live';
		if (existing && !(live && existing.dryRun)) return this.viewFor(ctx, order, existing);

		const view = await this.viewFor(ctx, order, undefined);
		if (view.status !== 'NONE') return view;

		let invoice: It4BillingInvoice | undefined;
		if (existing) {
			// A dry-run record from before switching to live: turn it into a live request, once.
			invoice = await this.compareAndSet(ctx, existing.id, ['dry_run', 'failed', 'pending'], {
				status: 'pending',
				dryRun: false,
				attempts: 0,
				nextAttemptAt: null,
				failureReason: null,
				lastError: null
			});
		} else {
			invoice = await this.insertOnce(ctx, order);
		}
		if (invoice) await this.enqueue(ctx, invoice.id);
		return this.viewFor(ctx, order, await this.findByOrder(ctx, order.id));
	}

	/** The stored PDF for the customer, only for their own issued invoice. */
	async customerPdf(
		ctx: RequestContext,
		orderCode: string
	): Promise<{ data: Buffer; fileName: string } | undefined> {
		const order = await this.orderService.findOneByCode(ctx, orderCode, [
			'customer',
			'customer.user'
		]);
		if (!order || !ctx.activeUserId || order.customer?.user?.id !== ctx.activeUserId) {
			throw new ForbiddenError();
		}
		if (!(await this.visibleToCustomer(ctx, order))) return undefined;
		const invoice = await this.findByOrder(ctx, order.id);
		if (invoice?.status !== 'issued' || !invoice.customerPdfKey || !invoice.documentNumber) {
			return undefined;
		}
		const data = await this.options.storage.read(invoice.customerPdfKey);
		if (!data) return undefined;
		return { data, fileName: `${invoice.documentNumber.replace(/[^A-Za-z0-9-]+/g, '-')}.pdf` };
	}

	// ---- Processing --------------------------------------------------------------------------

	/**
	 * Issues one invoice. Safe to call several times and from several workers: only one worker holds
	 * the account lease, and only the worker that claims the record works on it.
	 */
	async processInvoice(ctx: RequestContext, invoiceId: ID): Promise<void> {
		const state = await this.queueState(ctx);
		if (state.paused) return;
		const lease = await this.acquireLease(ctx);
		if (!lease) {
			await this.compareAndSet(ctx, invoiceId, ['pending'], {
				nextAttemptAt: new Date(Date.now() + 60_000)
			});
			return;
		}
		try {
			const current = await this.repo(ctx).findOne({ where: { id: invoiceId } });
			if (!current || current.status !== 'pending') return;
			const claimed = await this.compareAndSet(ctx, invoiceId, ['pending'], {
				status: 'preparing',
				attempts: current.attempts + 1,
				nextAttemptAt: null
			});
			if (claimed) await this.issue(ctx, claimed);
		} finally {
			await this.releaseLease(ctx, lease);
		}
	}

	/**
	 * Queues the invoices whose retry time has come, and recovers records left behind by a crash.
	 * Runs on a schedule; also called when the queue is resumed.
	 */
	async processDue(ctx?: RequestContext): Promise<void> {
		const c = ctx ?? (await this.adminContext());
		if ((await this.queueState(c)).paused) return;
		const now = Date.now();
		for (const invoice of await this.repo(c).find({ where: { status: 'preparing' } })) {
			// A worker died before saving: nothing was sent, so it is safe to queue it again.
			if (now - invoice.updatedAt.getTime() > LEASE_MS) {
				await this.compareAndSet(c, invoice.id, ['preparing'], { status: 'pending' });
			}
		}
		for (const invoice of await this.repo(c).find({ where: { status: 'saving' } })) {
			// A worker died while saving: the outcome is unknown.
			if (now - invoice.updatedAt.getTime() > LEASE_MS) {
				const updated = await this.compareAndSet(c, invoice.id, ['saving'], {
					status: 'needs_review',
					lastError: 'The worker stopped while saving the document'
				});
				if (updated) await this.publish(c, 'needs_review', updated, updated.lastError ?? '');
			}
		}
		for (const invoice of await this.repo(c).find({ where: { status: 'pending' } })) {
			if (!invoice.nextAttemptAt || invoice.nextAttemptAt.getTime() <= now) {
				await this.enqueue(c, invoice.id);
			}
		}
	}

	private async issue(ctx: RequestContext, invoice: It4BillingInvoice): Promise<void> {
		const dryRun = invoice.dryRun;
		let stage: 'preparing' | 'saving' | 'issued' = 'preparing';
		let loggedIn = false;
		const client = new It4BillingClient({
			baseUrl: this.options.baseUrl,
			accountId: this.options.accountId,
			credentials: this.options.credentials,
			minRequestIntervalMs: this.options.minRequestIntervalMs,
			requestTimeoutMs: this.options.requestTimeoutMs,
			taxTypeIds: this.options.taxTypeIds,
			userAgent: this.options.userAgent,
			readOnly: dryRun
		});
		try {
			const order = await this.loadOrder(ctx, invoice.orderId);
			const injector = new Injector(this.moduleRef);
			const billing = await this.billingDetails(ctx, order, injector);
			if (!billing) throw new PermanentFailure('missing_nif', 'The order has no valid billing NIF');
			const lines = [
				...(await this.options.invoiceLines(ctx, order, injector)),
				...this.shippingLines(order)
			];
			this.validateLines(lines);
			const comments = this.options.comments(order);
			if (comments.length > COMMENTS_MAX_LENGTH) {
				throw new PermanentFailure(
					'comments_too_long',
					`Comments exceed ${COMMENTS_MAX_LENGTH} characters`
				);
			}
			const referenceDate = this.options.referenceDate
				? await this.options.referenceDate(ctx, order, injector)
				: (order.orderPlacedAt ?? undefined);

			const paymentMethod =
				typeof this.options.paymentMethod === 'function'
					? await this.options.paymentMethod(ctx, order, injector)
					: this.options.paymentMethod;
			if (!paymentMethod?.trim()) {
				throw new PermanentFailure('invalid_payment_method', 'The order has no payment method');
			}

			await client.login();
			loggedIn = true;

			const wouldCreate: string[] = [];
			const wouldUpdate: string[] = [];
			let customer: ClientRecord | undefined = await client.findClientByNif(billing.nif);
			if (customer) {
				// The customer may have moved or renamed the company since the last invoice.
				const changed = clientDifferences(await client.getClient(customer.id), billing);
				if (changed.length && dryRun) {
					wouldUpdate.push(`customer with NIF ${billing.nif}: ${changed.join(', ')}`);
				} else if (changed.length) {
					await client.updateClient(customer.id, billing);
					customer = await client.findClientByNif(billing.nif);
					if (!customer)
						throw new UnexpectedPageError('The customer disappeared after updating it');
				}
			} else if (dryRun) {
				wouldCreate.push(`customer with NIF ${billing.nif}`);
				customer = await this.dryRunCustomer(client);
			} else if (!customer) {
				customer = await client.createClient(billing);
			}

			const used = lines.map((l) => ({ ...l, article: { ...l.article } }));
			for (const reference of new Set(lines.map((l) => l.article.reference))) {
				if (await client.findArticle(reference)) continue;
				const spec = lines.find((l) => l.article.reference === reference)!.article;
				if (!dryRun) {
					await client.createArticle(spec);
					continue;
				}
				wouldCreate.push(`article ${reference}`);
				if (!this.options.dryRunArticleReference) {
					throw new PermanentFailure(
						'dry_run_incomplete',
						`Dry run: article ${reference} does not exist`
					);
				}
				for (const l of used.filter((x) => x.article.reference === reference)) {
					l.description = l.description ?? l.article.name;
					l.article.reference = this.options.dryRunArticleReference;
				}
			}

			const totals = await client.buildDocument({
				documentType: this.options.documentType,
				client: customer,
				lines: used,
				paymentMethod,
				comments,
				referenceDate
			});
			if (totals.total !== order.totalWithTax) {
				throw new PermanentFailure(
					'total_mismatch',
					`IT4Billing total ${totals.total} differs from the order total ${order.totalWithTax}`
				);
			}

			if (dryRun) {
				const updated = await this.update(ctx, invoice.id, {
					status: 'dry_run',
					total: totals.total,
					dryRunReport: JSON.stringify({
						orderTotal: order.totalWithTax,
						paymentMethod,
						totals,
						billing,
						lines,
						wouldCreate,
						wouldUpdate
					})
				});
				await this.publish(ctx, 'dry_run', updated, `Dry run total ${totals.total}`);
				return;
			}

			await this.update(ctx, invoice.id, { status: 'saving', total: totals.total });
			stage = 'saving';
			const documentNumber = await client.saveDocument();
			let issued = await this.update(ctx, invoice.id, {
				status: 'issued',
				documentNumber,
				issuedAt: new Date()
			});
			stage = 'issued';

			try {
				const pdf = await client.printDocument();
				issued = await this.storePdfs(ctx, issued, pdf);
				await this.publish(ctx, 'issued', issued, `Issued ${documentNumber}`);
			} catch (e) {
				const updated = await this.update(ctx, invoice.id, { lastError: describe(e) });
				await this.publish(ctx, 'pdf_missing', updated, `Issued ${documentNumber}, PDF not stored`);
			}
		} catch (e) {
			await this.handleFailure(ctx, invoice, stage, e);
		} finally {
			if (loggedIn) {
				await client.logout().catch((e) => Logger.warn(`Logout failed: ${describe(e)}`, loggerCtx));
			}
		}
	}

	private async handleFailure(
		ctx: RequestContext,
		invoice: It4BillingInvoice,
		stage: 'preparing' | 'saving' | 'issued',
		e: unknown
	) {
		const message = describe(e);
		if (stage === 'issued') {
			Logger.error(`After issuing ${invoice.orderCode}: ${message}`, loggerCtx);
			return;
		}
		if (stage === 'saving') {
			const updated = await this.update(ctx, invoice.id, {
				status: 'needs_review',
				failureReason: 'save_unknown',
				lastError: message
			});
			await this.publish(ctx, 'needs_review', updated, message);
			return;
		}
		if (e instanceof LoginFailedError) {
			await this.pause(ctx, message);
			const updated = await this.update(ctx, invoice.id, {
				status: 'failed',
				failureReason: 'login_refused',
				lastError: message
			});
			await this.publish(ctx, 'queue_paused', updated, message);
			return;
		}
		const transient =
			e instanceof TransportError ||
			e instanceof SessionExpiredError ||
			e instanceof UnexpectedPageError;
		if (transient && invoice.attempts <= this.options.maxAutomaticRetries) {
			await this.update(ctx, invoice.id, {
				status: 'pending',
				nextAttemptAt: new Date(Date.now() + this.options.retryDelayMs),
				lastError: message
			});
			return;
		}
		const updated = await this.update(ctx, invoice.id, {
			status: 'failed',
			failureReason: e instanceof PermanentFailure ? e.reason : 'error',
			lastError: message
		});
		await this.publish(ctx, 'failed', updated, message);
	}

	// ---- Administration ----------------------------------------------------------------------

	async list(ctx: RequestContext, status?: string): Promise<It4BillingInvoice[]> {
		return this.repo(ctx).find({
			where: status ? { status: status as InvoiceStatus } : {},
			order: { createdAt: 'DESC' }
		});
	}

	/**
	 * Queues a stopped emission again. An invoice that may already have been saved (`needs_review`)
	 * is only retried when someone confirms, after checking IT4Billing, that it was not issued.
	 */
	async retry(ctx: RequestContext, id: ID, confirmNotIssued = false): Promise<It4BillingInvoice> {
		const allowed: InvoiceStatus[] = confirmNotIssued
			? ['failed', 'dry_run', 'needs_review']
			: ['failed', 'dry_run'];
		const updated = await this.compareAndSet(ctx, id, allowed, {
			status: 'pending',
			attempts: 0,
			nextAttemptAt: null,
			failureReason: null,
			lastError: null,
			dryRun: this.options.mode !== 'live'
		});
		if (!updated) {
			throw new UserInputError(
				'Only failed invoices and dry runs can be retried; a "needs_review" invoice needs confirmNotIssued'
			);
		}
		await this.enqueue(ctx, updated.id);
		return updated;
	}

	/**
	 * Records an invoice issued outside the plugin (by hand, or a `needs_review` one found in
	 * IT4Billing), with its PDF, so the order is never invoiced again. For an invoice that was issued
	 * but whose PDF was not stored, it only attaches the PDF, and the number must be the same.
	 */
	async importIssued(
		ctx: RequestContext,
		orderCode: string,
		documentNumber: string,
		pdf: Buffer
	): Promise<It4BillingInvoice> {
		if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new UserInputError('Not a PDF');
		if (!documentNumber.trim()) throw new UserInputError('The document number is required');
		const order = await this.orderService.findOneByCode(ctx, orderCode, []);
		if (!order) throw new UserInputError(`No order ${orderCode}`);
		let invoice = await this.findByOrder(ctx, order.id);
		if (invoice?.status === 'issued') {
			if (invoice.archivePdfKey) throw new UserInputError(`${orderCode} is already invoiced`);
			// Issued, but the PDF was not stored (`pdf_missing`): attach it, under the same number.
			if (invoice.documentNumber !== documentNumber.trim()) {
				throw new UserInputError(`${orderCode} was issued as ${invoice.documentNumber}`);
			}
			return this.storePdfs(ctx, invoice, pdf);
		}
		if (invoice && ['preparing', 'saving'].includes(invoice.status)) {
			throw new UserInputError(`${orderCode} is being invoiced right now`);
		}
		invoice = invoice ?? (await this.insertOnce(ctx, order, 'failed'));
		if (!invoice) throw new UserInputError(`${orderCode} could not be recorded`);
		const issued = await this.update(ctx, invoice.id, {
			status: 'issued',
			documentNumber: documentNumber.trim(),
			issuedAt: new Date(),
			dryRun: false,
			failureReason: null,
			lastError: null
		});
		return this.storePdfs(ctx, issued, pdf);
	}

	/** A stored PDF of an invoice, for the administration. */
	async storedPdf(
		ctx: RequestContext,
		id: ID,
		copy: 'customer' | 'archive'
	): Promise<Buffer | undefined> {
		const invoice = await this.repo(ctx).findOne({ where: { id } });
		const key = copy === 'archive' ? invoice?.archivePdfKey : invoice?.customerPdfKey;
		return key ? this.options.storage.read(key) : undefined;
	}

	async queueState(ctx: RequestContext): Promise<It4BillingQueueState> {
		const repo = this.connection.getRepository(ctx, It4BillingQueueState);
		const [existing] = await repo.find({ order: { id: 'ASC' }, take: 1 });
		return existing ?? repo.save(new It4BillingQueueState({ paused: false }));
	}

	async resume(ctx: RequestContext): Promise<It4BillingQueueState> {
		const state = await this.queueState(ctx);
		await this.connection
			.getRepository(ctx, It4BillingQueueState)
			.update(state.id, { paused: false, pausedReason: null, pausedAt: null });
		await this.processDue(ctx);
		return this.queueState(ctx);
	}

	// ---- Internals ---------------------------------------------------------------------------

	private async viewFor(
		ctx: RequestContext,
		order: Order,
		invoice: It4BillingInvoice | undefined
	): Promise<CustomerInvoiceView> {
		if (invoice?.status === 'issued' && invoice.customerPdfKey) {
			return {
				status: 'ISSUED',
				documentNumber: invoice.documentNumber ?? undefined,
				issuedAt: invoice.issuedAt ?? undefined,
				downloadPath: `/it4billing/invoices/${encodeURIComponent(order.code)}/pdf`
			};
		}
		if (invoice && !(this.options.mode === 'live' && invoice.dryRun))
			return { status: 'PREPARING' };
		if (!(await this.isEligible(ctx, order))) return { status: 'NOT_ELIGIBLE' };
		const billing = await this.billingDetails(ctx, order, new Injector(this.moduleRef));
		return { status: billing ? 'NONE' : 'MISSING_NIF' };
	}

	private async visibleToCustomer(ctx: RequestContext, order: Order): Promise<boolean> {
		if (!this.options.customerVisible) return true;
		return this.options.customerVisible(ctx, order, new Injector(this.moduleRef));
	}

	private async isEligible(ctx: RequestContext, order: Order): Promise<boolean> {
		if (this.options.mode === 'live' && this.options.liveOrderCodes) {
			if (!this.options.liveOrderCodes.includes(order.code)) return false;
		}
		if (this.options.isEligible) {
			return this.options.isEligible(ctx, order, new Injector(this.moduleRef));
		}
		return !order.active && ELIGIBLE_STATES.includes(order.state);
	}

	/** The billing details, only if complete and with a valid NIF. */
	private async billingDetails(
		ctx: RequestContext,
		order: Order,
		injector: Injector
	): Promise<BillingDetails | undefined> {
		const details = this.options.billingDetails
			? await this.options.billingDetails(ctx, order, injector)
			: this.defaultBillingDetails(order);
		if (!details) return undefined;
		const nif = normalizeNif(details.nif ?? '');
		if (!isValidNif(nif)) return undefined;
		// Customers type spaces around their address; IT4Billing would keep them on the customer.
		const billing: BillingDetails = {
			nif,
			name: details.name?.trim() ?? '',
			streetLine: details.streetLine?.trim() ?? '',
			postalCode: details.postalCode?.trim() ?? '',
			city: details.city?.trim() ?? '',
			countryCode: details.countryCode?.trim() ?? ''
		};
		if (!billing.name || !billing.streetLine || !billing.city) return undefined;
		return billing;
	}

	private defaultBillingDetails(order: Order): BillingDetails | undefined {
		const address = order.customer?.addresses?.find((a) => a.defaultBillingAddress);
		if (!address) return undefined;
		const nif = (address.customFields as Record<string, unknown> | undefined)?.[
			this.options.nifCustomField
		];
		if (typeof nif !== 'string') return undefined;
		return {
			nif,
			name: (address.company || address.fullName || '').trim(),
			streetLine: [address.streetLine1, address.streetLine2].filter(Boolean).join(', '),
			postalCode: address.postalCode ?? '',
			city: address.city ?? '',
			countryCode: address.country?.code ?? 'PT'
		};
	}

	private validateLines(lines: InvoiceLineSpec[]) {
		if (!Array.isArray(lines) || !lines.length) {
			throw new PermanentFailure('no_lines', 'The order has no invoice lines');
		}
		for (const l of lines) {
			const a = l.article;
			const problem =
				!a?.reference || a.reference.length > ARTICLE_REFERENCE_MAX_LENGTH
					? `reference must have 1 to ${ARTICLE_REFERENCE_MAX_LENGTH} characters`
					: !a.name || a.name.length > TEXT_MAX_LENGTH
						? `name must have 1 to ${TEXT_MAX_LENGTH} characters`
						: (l.description ?? '').length > TEXT_MAX_LENGTH
							? `description exceeds ${TEXT_MAX_LENGTH} characters`
							: !Number.isInteger(a.netUnitPrice) || a.netUnitPrice < 0
								? 'netUnitPrice must be integer cents'
								: !(l.quantity > 0)
									? 'quantity must be positive'
									: !(l.discountPercent >= 0 && l.discountPercent <= 100) ||
										  Math.round(l.discountPercent * 100) !== l.discountPercent * 100
										? 'discountPercent must be 0 to 100 with at most 2 decimals'
										: undefined;
			if (problem) {
				throw new PermanentFailure('invalid_line', `Line ${a?.reference ?? '?'}: ${problem}`);
			}
		}
	}

	/** The shipping line from `shippingLine`, when the order charged shipping. */
	private shippingLines(order: Order): InvoiceLineSpec[] {
		const config = this.options.shippingLine;
		const gross = order.shippingWithTax;
		if (!config || !gross) return [];
		const rate = config.taxRatePercent;
		const net = Math.round((gross * 100) / (100 + rate));
		if (net + Math.round((net * rate) / 100) !== gross) {
			throw new PermanentFailure(
				'shipping_unreachable',
				`Shipping of ${gross} cents cannot be reached at ${rate}% in IT4Billing`
			);
		}
		return [
			{
				article: { ...config.article, netUnitPrice: net },
				description: config.description,
				quantity: 1,
				discountPercent: 0
			}
		];
	}

	private async dryRunCustomer(client: It4BillingClient): Promise<ClientRecord> {
		if (!this.options.dryRunCustomerSearch) {
			throw new PermanentFailure('dry_run_incomplete', 'Dry run: the customer does not exist');
		}
		const found = await client.searchClients(this.options.dryRunCustomerSearch);
		if (found.length !== 1) {
			throw new PermanentFailure(
				'dry_run_incomplete',
				'Dry run: dryRunCustomerSearch must find one customer'
			);
		}
		return found[0];
	}

	private async storePdfs(
		ctx: RequestContext,
		invoice: It4BillingInvoice,
		pdf: Buffer
	): Promise<It4BillingInvoice> {
		const base = `invoice-${String(invoice.id).replace(/[^A-Za-z0-9-]/g, '')}-${randomUUID()}`;
		const archivePdfKey = `${base}-archive.pdf`;
		const customerPdfKey = `${base}-customer.pdf`;
		const customer = this.options.customerPdf === 'original-page' ? await originalPage(pdf) : pdf;
		await this.options.storage.save(archivePdfKey, pdf);
		await this.options.storage.save(customerPdfKey, customer);
		return this.update(ctx, invoice.id, { archivePdfKey, customerPdfKey });
	}

	private async insertOnce(
		ctx: RequestContext,
		order: Order,
		status: InvoiceStatus = 'pending',
		dryRun = this.options.mode !== 'live'
	): Promise<It4BillingInvoice | undefined> {
		try {
			return await this.repo(ctx).save(
				new It4BillingInvoice({
					orderId: order.id,
					orderCode: order.code,
					status,
					dryRun,
					attempts: 0
				})
			);
		} catch (e) {
			// Another request created it first: the unique order id guarantees a single record.
			if (await this.findByOrder(ctx, order.id)) return undefined;
			throw e;
		}
	}

	/**
	 * Atomic on any database: update only if the status is still one of `from`, stamping a fresh
	 * token, then read it back. Only the caller whose token is there won.
	 */
	private async compareAndSet(
		ctx: RequestContext,
		id: ID,
		from: InvoiceStatus[],
		values: Partial<It4BillingInvoice>
	): Promise<It4BillingInvoice | undefined> {
		const token = randomUUID();
		await this.repo(ctx)
			.createQueryBuilder()
			.update(It4BillingInvoice)
			.set({ ...values, claimToken: token })
			.where('id = :id', { id })
			.andWhere('status IN (:...from)', { from })
			.execute();
		const after = await this.repo(ctx).findOne({ where: { id } });
		return after?.claimToken === token ? after : undefined;
	}

	private async update(
		ctx: RequestContext,
		id: ID,
		values: Partial<It4BillingInvoice>
	): Promise<It4BillingInvoice> {
		await this.repo(ctx).update(id, values);
		return this.repo(ctx).findOneOrFail({ where: { id } });
	}

	private async acquireLease(ctx: RequestContext): Promise<string | undefined> {
		const state = await this.queueState(ctx);
		if (state.leaseToken && state.leaseUntil && state.leaseUntil.getTime() > Date.now()) {
			return undefined;
		}
		const token = randomUUID();
		const qb = this.connection
			.getRepository(ctx, It4BillingQueueState)
			.createQueryBuilder()
			.update(It4BillingQueueState)
			.set({ leaseToken: token, leaseUntil: new Date(Date.now() + LEASE_MS) })
			.where('id = :id', { id: state.id });
		if (state.leaseToken) qb.andWhere('leaseToken = :old', { old: state.leaseToken });
		else qb.andWhere('leaseToken IS NULL');
		await qb.execute();
		const after = await this.queueState(ctx);
		return after.leaseToken === token ? token : undefined;
	}

	private async releaseLease(ctx: RequestContext, token: string) {
		await this.connection
			.getRepository(ctx, It4BillingQueueState)
			.createQueryBuilder()
			.update(It4BillingQueueState)
			.set({ leaseToken: null, leaseUntil: null })
			.where('leaseToken = :token', { token })
			.execute();
	}

	private async pause(ctx: RequestContext, reason: string) {
		const state = await this.queueState(ctx);
		await this.connection
			.getRepository(ctx, It4BillingQueueState)
			.update(state.id, { paused: true, pausedReason: reason, pausedAt: new Date() });
	}

	private async enqueue(ctx: RequestContext, invoiceId: ID) {
		await this.queue.add({ invoiceId, channelToken: ctx.channel.token }, { retries: 0 });
	}

	private async publish(
		ctx: RequestContext,
		type: It4BillingEventType,
		invoice: It4BillingInvoice | undefined,
		message: string
	) {
		Logger.info(`${type} ${invoice?.orderCode ?? ''}: ${message}`, loggerCtx);
		await this.eventBus.publish(new It4BillingInvoiceEvent(ctx, type, invoice, message));
	}

	private async loadOrder(ctx: RequestContext, orderId: ID): Promise<Order> {
		const relations = [...DEFAULT_RELATIONS, ...(this.options.orderRelations ?? [])];
		const order = await this.orderService.findOne(ctx, orderId, relations as never);
		if (!order) throw new UserInputError(`No order ${orderId}`);
		return order;
	}

	private findByOrder(ctx: RequestContext, orderId: ID) {
		return this.repo(ctx)
			.findOne({ where: { orderId } })
			.then((r) => r ?? undefined);
	}

	private repo(ctx: RequestContext) {
		return this.connection.getRepository(ctx, It4BillingInvoice);
	}

	private adminContext(channelToken?: string) {
		return this.requestContextService.create({ apiType: 'admin', channelOrToken: channelToken });
	}
}

/** The billing fields that differ between IT4Billing and the order's billing details. */
export function clientDifferences(stored: ClientDetails, wanted: BillingDetails): string[] {
	const same = (a: string, b: string) =>
		a.trim().replace(/\s+/g, ' ') === b.trim().replace(/\s+/g, ' ');
	const changed: string[] = [];
	if (!same(stored.fiscalName, wanted.name) || !same(stored.name, wanted.name))
		changed.push('name');
	if (!same(stored.streetLine, wanted.streetLine)) changed.push('address');
	if (!same(stored.postalCode, wanted.postalCode)) changed.push('postal code');
	if (!same(stored.city, wanted.city)) changed.push('city');
	if (stored.country !== countryName(wanted.countryCode)) changed.push('country');
	return changed;
}

function describe(e: unknown): string {
	return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
