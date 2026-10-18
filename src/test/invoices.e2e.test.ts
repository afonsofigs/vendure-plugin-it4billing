/**
 * End-to-end: a real Vendure server with orders, the plugin in live mode (and dry-run where noted),
 * and the local fake IT4Billing. Covers the rules that matter most: one invoice per order, what
 * happens on each failure, the paused queue after a refused login, and the customer's PDF.
 */
import {
	dummyPaymentHandler,
	EventBus,
	ID,
	mergeConfig,
	RequestContextService
} from '@vendure/core';
import {
	createTestEnvironment,
	registerInitializer,
	SqljsInitializer,
	testConfig
} from '@vendure/testing';
import gql from 'graphql-tag';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { It4BillingInvoiceEvent } from '../events';
import { nifCheckDigit } from '../nif';
import { It4BillingPlugin } from '../plugin';
import { It4BillingService } from '../service/invoice.service';
import { LocalInvoiceStorageStrategy } from '../storage';
import type { It4BillingTaxType } from '../types';
import { FAKE_ACCOUNT, FAKE_PDF_PAGE_WIDTHS, FakeIt4Billing } from './fake-it4billing';
import { initialData } from './fixtures/initial-data';

registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__data__')));

const fake = new FakeIt4Billing();
const events: It4BillingInvoiceEvent[] = [];
const storageDir = mkdtempSync(path.join(tmpdir(), 'it4billing-e2e-'));
const storage = new LocalInvoiceStorageStrategy(storageDir);
const PASSWORD = fake.password;
let breakPrices = false;

// NIFs are computed from arbitrary prefixes: no real taxpayer is written here.
const nif = (firstEight: string) => `${firstEight}${nifCheckDigit(firstEight)}`;
const TAX_BY_RATE: Record<number, It4BillingTaxType> = {
	23: 'normal',
	13: 'intermediate',
	6: 'reduced'
};

const env = createTestEnvironment(
	mergeConfig(testConfig, {
		paymentOptions: { paymentMethodHandlers: [dummyPaymentHandler] },
		customFields: { Address: [{ name: 'nif', type: 'string', nullable: true }] },
		plugins: [
			It4BillingPlugin.init({
				// Placeholder until the fake starts; set in beforeAll.
				baseUrl: 'http://127.0.0.1:9',
				accountId: FAKE_ACCOUNT,
				credentials: { username: fake.username, password: PASSWORD },
				paymentMethod: 'Card',
				mode: 'live',
				minRequestIntervalMs: 1,
				retryDelayMs: 1,
				maxAutomaticRetries: 1,
				storage,
				dryRunCustomerSearch: 'Dry Run Customer',
				dryRunArticleReference: 'T-DRY',
				shippingLine: {
					article: {
						reference: 'T-SHIP',
						name: 'Shipping',
						productType: 'service',
						unit: 'Un',
						taxType: 'normal'
					},
					taxRatePercent: 23
				},
				invoiceLines: (_ctx, order) =>
					order.lines.map((line) => ({
						article: {
							reference: `T-${line.productVariant.sku}`,
							name: line.productVariant.name || line.productVariant.sku,
							productType: 'product',
							unit: 'Un',
							taxType: TAX_BY_RATE[line.taxRate],
							netUnitPrice: line.unitPrice + (breakPrices ? 1 : 0)
						},
						quantity: line.quantity,
						discountPercent: 0
					}))
			})
		]
	})
);
const { server, adminClient, shopClient } = env;

const REQUEST = gql`
	mutation ($orderCode: String!) {
		requestOrderInvoice(orderCode: $orderCode) {
			status
			documentNumber
			downloadPath
		}
	}
`;
const ORDER_INVOICE = gql`
	query ($code: String!) {
		orderByCode(code: $code) {
			it4billingInvoice {
				status
				documentNumber
				downloadPath
			}
		}
	}
`;
const INVOICES = gql`
	query {
		it4billingInvoices {
			id
			orderCode
			status
			attempts
			documentNumber
			total
			hasCustomerPdf
			failureReason
			lastError
			dryRunReport
		}
	}
`;

type Rec = {
	id: string;
	orderCode: string;
	status: string;
	attempts: number;
	documentNumber: string | null;
	total: number | null;
	hasCustomerPdf: boolean;
	failureReason: string | null;
	lastError: string | null;
	dryRunReport: string | null;
};

let customers: { id: string; emailAddress: string }[] = [];
let nextCustomer = 0;
let paymentMethodCode = '';
const variantIds: Record<string, string> = {};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function records(): Promise<Rec[]> {
	return (await adminClient.query(INVOICES)).it4billingInvoices;
}

async function waitFor(
	orderCode: string,
	done: (r: Rec) => boolean,
	timeoutMs = 20000
): Promise<Rec> {
	const until = Date.now() + timeoutMs;
	for (;;) {
		const rec = (await records()).find((r) => r.orderCode === orderCode);
		if (rec && done(rec)) return rec;
		if (Date.now() > until) throw new Error(`Timeout for ${orderCode}: ${JSON.stringify(rec)}`);
		await sleep(100);
	}
}

/** A customer with a default billing address, with or without a NIF. */
async function newCustomer(taxNumber: string | null) {
	const customer = customers[nextCustomer++];
	await adminClient.query(
		gql`
			mutation ($id: ID!, $input: CreateAddressInput!) {
				createCustomerAddress(customerId: $id, input: $input) {
					id
				}
			}
		`,
		{
			id: customer.id,
			input: {
				fullName: 'Test Person',
				company: `Example Company ${nextCustomer}`,
				streetLine1: 'Rua de Exemplo, 1',
				city: 'Lisboa',
				postalCode: '1000-001',
				countryCode: 'PT',
				defaultBillingAddress: true,
				defaultShippingAddress: true,
				customFields: { nif: taxNumber }
			}
		}
	);
	return customer;
}

/** Places and pays an order as the customer. Returns its code and id. */
async function placeOrder(
	customer: { emailAddress: string },
	items: [string, number][],
	pay = true,
	paidShipping = false
): Promise<{ code: string; id: ID }> {
	await shopClient.asUserWithCredentials(customer.emailAddress, 'test');
	let order: { code: string; id: ID } | undefined;
	for (const [sku, quantity] of items) {
		const res = await shopClient.query(
			gql`
				mutation ($id: ID!, $q: Int!) {
					addItemToOrder(productVariantId: $id, quantity: $q) {
						... on Order {
							id
							code
						}
					}
				}
			`,
			{ id: variantIds[sku], q: quantity }
		);
		order = res.addItemToOrder;
	}
	if (!pay) return order!;
	await shopClient.query(gql`
		mutation {
			setOrderShippingAddress(
				input: {
					fullName: "Test Person"
					streetLine1: "Rua de Exemplo, 1"
					city: "Lisboa"
					postalCode: "1000-001"
					countryCode: "PT"
				}
			) {
				... on Order {
					id
				}
			}
		}
	`);
	const { eligibleShippingMethods } = await shopClient.query(gql`
		query {
			eligibleShippingMethods {
				id
				price
			}
		}
	`);
	await shopClient.query(
		gql`
			mutation ($ids: [ID!]!) {
				setOrderShippingMethod(shippingMethodId: $ids) {
					... on Order {
						id
					}
				}
			}
		`,
		{
			ids: [
				eligibleShippingMethods.find((m: { price: number }) =>
					paidShipping ? m.price > 0 : m.price === 0
				).id
			]
		}
	);
	await shopClient.query(gql`
		mutation {
			transitionOrderToState(state: "ArrangingPayment") {
				... on Order {
					id
				}
			}
		}
	`);
	const { addPaymentToOrder } = await shopClient.query(
		gql`
			mutation ($code: String!) {
				addPaymentToOrder(input: { method: $code, metadata: {} }) {
					... on Order {
						id
						code
						state
					}
					... on ErrorResult {
						message
					}
				}
			}
		`,
		{ code: paymentMethodCode }
	);
	expect(addPaymentToOrder.state).toBe('PaymentSettled');
	return order!;
}

async function request(code: string) {
	return (await shopClient.query(REQUEST, { orderCode: code })).requestOrderInvoice;
}

async function adminCtx() {
	return server.app.get(RequestContextService).create({ apiType: 'admin' });
}

beforeAll(async () => {
	await fake.start();
	It4BillingPlugin.options.baseUrl = fake.baseUrl;
	await server.init({
		initialData,
		productsCsvPath: path.join(__dirname, 'fixtures/products.csv'),
		customerCount: 16
	});
	await adminClient.asSuperAdmin();
	server.app
		.get(EventBus)
		.ofType(It4BillingInvoiceEvent)
		.subscribe((e) => events.push(e));
	customers = (
		await adminClient.query(gql`
			query {
				customers {
					items {
						id
						emailAddress
					}
				}
			}
		`)
	).customers.items;
	const { productVariants } = await adminClient.query(gql`
		query {
			productVariants {
				items {
					id
					sku
				}
			}
		}
	`);
	for (const v of productVariants.items) variantIds[v.sku] = v.id;
	const { paymentMethods } = await adminClient.query(gql`
		query {
			paymentMethods {
				items {
					code
				}
			}
		}
	`);
	paymentMethodCode = paymentMethods.items[0].code;
}, 120000);

afterAll(async () => {
	await server.destroy();
	await fake.stop();
});

describe('issuing invoices', () => {
	test('issues once, stores the PDF, and only the customer downloads the Original page', async () => {
		const customer = await newCustomer(nif('51234567'));
		const { code } = await placeOrder(customer, [
			['BOX-1', 1],
			['ACC-1', 2]
		]);
		const saves = fake.saves;
		const prints = fake.prints;

		expect((await request(code)).status).toBe('PREPARING');
		const rec = await waitFor(code, (r) => r.status === 'issued' && r.hasCustomerPdf);
		expect(rec.documentNumber).toMatch(/^FR FR\/\d+$/);
		// 78,76 at 13% plus 2 x 5,00 at 23%, exactly the order total.
		expect(rec.total).toBe(10130);
		expect(fake.saves - saves).toBe(1);
		expect(fake.prints - prints).toBe(1);
		expect(fake.lastUserAgent).toMatch(/^Mozilla\/5\.0 \(compatible; vendure-plugin-it4billing\//);
		expect(fake.clients.find((c) => c.nif === nif('51234567'))).toMatchObject({
			name: 'Example Company 1',
			address: 'Rua de Exemplo, 1'
		});
		expect(fake.articles.map((a) => a.reference)).toEqual(
			expect.arrayContaining(['T-BOX-1', 'T-ACC-1'])
		);
		expect(events.some((e) => e.type === 'issued' && e.invoice?.orderCode === code)).toBe(true);

		const view = (await shopClient.query(ORDER_INVOICE, { code })).orderByCode.it4billingInvoice;
		expect(view).toMatchObject({ status: 'ISSUED', documentNumber: rec.documentNumber });

		const url = `http://localhost:3050${view.downloadPath}`;
		const res = await fetch(url, {
			headers: { authorization: `Bearer ${shopClient.getAuthToken()}` }
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/pdf');
		const pdf = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
		expect(pdf.getPageCount()).toBe(1);
		expect(pdf.getPage(0).getWidth()).toBe(FAKE_PDF_PAGE_WIDTHS[0]);

		// The full PDF is kept as the archive copy.
		const archived = (await server.app.get(It4BillingService).list(await adminCtx())).find(
			(i) => i.orderCode === code
		)!;
		const archive = await storage.read(archived.archivePdfKey!);
		expect((await PDFDocument.load(new Uint8Array(archive!))).getPageCount()).toBe(3);

		// Nobody else can download it.
		expect((await fetch(url)).status).toBe(403);
		await shopClient.asUserWithCredentials(customers[nextCustomer].emailAddress, 'test');
		const other = await fetch(url, {
			headers: { authorization: `Bearer ${shopClient.getAuthToken()}` }
		});
		expect(other.status).toBe(403);
	});

	test('concurrent requests for the same order end in a single invoice', async () => {
		const customer = await newCustomer(nif('52345678'));
		const order = await placeOrder(customer, [['BOX-1', 1]]);
		const saves = fake.saves;
		const service = server.app.get(It4BillingService);
		const ctx = await adminCtx();
		// The API encodes ids in tests (T_2); the service takes the internal one.
		const internalId = String(order.id).replace(/^T_/, '');

		await Promise.all([
			request(order.code),
			request(order.code),
			service.request(ctx, internalId),
			service.request(ctx, internalId)
		]);
		await waitFor(order.code, (r) => r.status === 'issued');
		await service.processDue();
		await sleep(1000);
		expect((await records()).filter((r) => r.orderCode === order.code)).toHaveLength(1);
		expect(fake.saves - saves).toBe(1);
		expect((await request(order.code)).status).toBe('ISSUED');
		expect(fake.saves - saves).toBe(1);
	});

	test('without a valid NIF there is no invoice', async () => {
		const customer = await newCustomer(null);
		const { code } = await placeOrder(customer, [['BOX-1', 1]]);
		expect((await request(code)).status).toBe('MISSING_NIF');
		expect((await records()).some((r) => r.orderCode === code)).toBe(false);
	});

	test('an order that is not paid is not eligible', async () => {
		const customer = await newCustomer(nif('53456789'));
		const { code } = await placeOrder(customer, [['BOX-1', 1]], false);
		expect((await request(code)).status).toBe('NOT_ELIGIBLE');
		expect((await records()).some((r) => r.orderCode === code)).toBe(false);
	});
});

describe('failures', () => {
	test('a network failure before saving is retried automatically', async () => {
		const customer = await newCustomer(nif('54567890'));
		const { code } = await placeOrder(customer, [['BOX-1', 1]]);
		const saves = fake.saves;
		fake.failOnce({ match: 'ctl00$Content$DocumentEntityBtn', status: 503 });

		await request(code);
		const waiting = await waitFor(code, (r) => r.status === 'pending' && !!r.lastError);
		expect(waiting.attempts).toBe(1);
		expect(fake.saves).toBe(saves);

		await server.app.get(It4BillingService).processDue();
		const rec = await waitFor(code, (r) => r.status === 'issued');
		expect(rec.attempts).toBe(2);
		expect(fake.saves - saves).toBe(1);
	});

	test('after the automatic retries, it stops as failed and reports it', async () => {
		const customer = await newCustomer(nif('55678901'));
		const { code } = await placeOrder(customer, [['BOX-1', 1]]);
		const saves = fake.saves;
		fake.failOnce({ match: 'ctl00$Content$DocumentEntityBtn', status: 503 });
		fake.failOnce({ match: 'ctl00$Content$DocumentEntityBtn', status: 503 });

		await request(code);
		await waitFor(code, (r) => r.status === 'pending' && !!r.lastError);
		await server.app.get(It4BillingService).processDue();
		const rec = await waitFor(code, (r) => r.status === 'failed');
		expect(rec.attempts).toBe(2);
		expect(fake.saves).toBe(saves);
		expect(events.some((e) => e.type === 'failed' && e.invoice?.orderCode === code)).toBe(true);
		expect((await request(code)).status).toBe('PREPARING');
	});

	test('a total that does not match the order is never saved', async () => {
		const customer = await newCustomer(nif('56789012'));
		const { code } = await placeOrder(customer, [['BOX-1', 1]]);
		const saves = fake.saves;
		breakPrices = true;
		try {
			await request(code);
			const rec = await waitFor(code, (r) => r.status === 'failed');
			expect(rec.failureReason).toBe('total_mismatch');
			expect(rec.attempts).toBe(1);
		} finally {
			breakPrices = false;
		}
		expect(fake.saves).toBe(saves);
	});

	test('a save without a number goes to review and is never repeated', async () => {
		const customer = await newCustomer(nif('57890123'));
		const { code } = await placeOrder(customer, [['BOX-1', 1]]);
		const saves = fake.saves;
		fake.failOnce({ match: 'ctl00$Content$SaveDocumentBtn', drop: true, after: true });

		await request(code);
		const rec = await waitFor(code, (r) => r.status === 'needs_review');
		expect(rec.failureReason).toBe('save_unknown');
		// The fake did save it: exactly the case where repeating would issue a second invoice.
		expect(fake.saves - saves).toBe(1);
		expect(events.some((e) => e.type === 'needs_review' && e.invoice?.orderCode === code)).toBe(
			true
		);

		await server.app.get(It4BillingService).processDue();
		await request(code);
		const retry = await adminClient
			.query(
				gql`
					mutation ($id: ID!) {
						retryIt4billingInvoice(id: $id) {
							status
						}
					}
				`,
				{ id: rec.id }
			)
			.catch((e: Error) => e);
		expect(retry).toBeInstanceOf(Error);
		await sleep(1000);
		expect((await waitFor(code, () => true)).status).toBe('needs_review');
		expect(fake.saves - saves).toBe(1);
		expect((await request(code)).status).toBe('PREPARING');
	});

	test('a refused login pauses the queue until an administrator resumes it', async () => {
		const customer = await newCustomer(nif('58901234'));
		const first = await placeOrder(customer, [['BOX-1', 1]]);
		const second = await placeOrder(customer, [['ACC-1', 1]]);
		const logins = fake.logins;
		fake.password = 'changed-by-someone';
		try {
			await request(first.code);
			const rec = await waitFor(first.code, (r) => r.status === 'failed');
			expect(rec.failureReason).toBe('login_refused');
			expect(fake.logins - logins).toBe(1);
			expect(events.some((e) => e.type === 'queue_paused')).toBe(true);

			await request(second.code);
			await sleep(1500);
			await server.app.get(It4BillingService).processDue();
			await sleep(500);
			expect((await waitFor(second.code, () => true)).status).toBe('pending');
			// Nobody tried to log in again while paused.
			expect(fake.logins - logins).toBe(1);
		} finally {
			fake.password = PASSWORD;
		}

		await adminClient.query(gql`
			mutation {
				resumeIt4billingQueue {
					paused
				}
			}
		`);
		await waitFor(second.code, (r) => r.status === 'issued');
		expect((await waitFor(first.code, () => true)).status).toBe('failed');
		expect(fake.logins - logins).toBe(2);
	});

	test('a PDF that cannot be fetched leaves the invoice issued, reported, and not printed again', async () => {
		const customer = await newCustomer(nif('59012345'));
		const { code } = await placeOrder(customer, [['BOX-1', 1]]);
		const prints = fake.prints;
		fake.failOnce({ match: 'PdfPreview.ashx', status: 500 });

		await request(code);
		const rec = await waitFor(code, (r) => r.status === 'issued' && !!r.lastError);
		expect(rec.hasCustomerPdf).toBe(false);
		expect(events.some((e) => e.type === 'pdf_missing' && e.invoice?.orderCode === code)).toBe(
			true
		);
		await sleep(1000);
		expect(fake.prints - prints).toBe(1);
		expect((await request(code)).status).toBe('PREPARING');
	});
});

describe('shipping', () => {
	test('the shipping the customer paid becomes a service line at its tax', async () => {
		const customer = await newCustomer(nif('65678901'));
		const { code } = await placeOrder(customer, [['BOX-1', 1]], true, true);
		await request(code);
		const rec = await waitFor(code, (r) => r.status === 'issued');
		expect(rec.total).toBe(8900 + 615);
		const doc = fake.documents.at(-1)!;
		expect(doc.lines.map((l) => [l.reference, l.priceMilli, l.taxId])).toEqual([
			['T-BOX-1', 78760, '3'],
			['T-SHIP', 5000, '1']
		]);
		expect(fake.articles.find((a) => a.reference === 'T-SHIP')).toMatchObject({ productType: '2' });
	});
});

describe('existing customers', () => {
	const seedCustomer = (taxNumber: string, id: string) =>
		fake.clients.push({
			id,
			name: 'Old Name, Lda',
			fiscalName: 'Old Name, Lda',
			nif: taxNumber,
			address: 'Rua Antiga, 9',
			postalCode: '2000-002',
			city: 'Santarém',
			country: 'Portugal'
		});

	test('a dry run only reports the changes it would make to the customer', async () => {
		const taxNumber = nif('63456789');
		seedCustomer(taxNumber, '910');
		const customer = await newCustomer(taxNumber);
		const { code } = await placeOrder(customer, [['BOX-1', 1]]);
		const updates = fake.clientUpdates;
		It4BillingPlugin.options.mode = 'dry-run';
		try {
			await request(code);
			const rec = await waitFor(code, (r) => r.status === 'dry_run');
			expect(JSON.parse(rec.dryRunReport!).wouldUpdate).toEqual([
				`customer with NIF ${taxNumber}: name, address, postal code, city`
			]);
		} finally {
			It4BillingPlugin.options.mode = 'live';
		}
		expect(fake.clientUpdates).toBe(updates);
		expect(fake.clients.find((c) => c.nif === taxNumber)).toMatchObject({
			address: 'Rua Antiga, 9'
		});
	});

	test('a customer whose name or address changed is updated before issuing', async () => {
		const taxNumber = nif('64567890');
		seedCustomer(taxNumber, '911');
		const customer = await newCustomer(taxNumber);
		const { code } = await placeOrder(customer, [['BOX-1', 1]]);
		const updates = fake.clientUpdates;

		await request(code);
		await waitFor(code, (r) => r.status === 'issued');
		expect(fake.clientUpdates - updates).toBe(1);
		expect(fake.clients.filter((c) => c.nif === taxNumber)).toEqual([
			expect.objectContaining({
				id: '911',
				fiscalName: `Example Company ${nextCustomer}`,
				address: 'Rua de Exemplo, 1',
				postalCode: '1000-001',
				city: 'Lisboa'
			})
		]);
		const doc = fake.documents.at(-1)!;
		expect(doc.clientId).toBe('911');
	});

	test('a customer that already matches is not touched', async () => {
		const taxNumber = nif('64567890');
		const customer = customers[nextCustomer - 1];
		const { code } = await placeOrder(customer, [['ACC-1', 1]]);
		const updates = fake.clientUpdates;
		await request(code);
		await waitFor(code, (r) => r.status === 'issued');
		expect(fake.clientUpdates).toBe(updates);
		expect(fake.clients.filter((c) => c.nif === taxNumber)).toHaveLength(1);
	});
});

describe('dry run and import', () => {
	test('a dry run creates and saves nothing, then live issues the same order once', async () => {
		const customer = await newCustomer(nif('61234567'));
		const { code } = await placeOrder(customer, [
			['BOX-1', 1],
			['ACC-1', 1]
		]);
		fake.clients.push({
			id: '900',
			name: 'Dry Run Customer',
			fiscalName: 'Dry Run Customer',
			nif: nif('29999999'),
			address: 'N/D',
			postalCode: '0000-000',
			city: 'N/D',
			country: 'Portugal'
		});
		fake.articles.push({
			reference: 'T-DRY',
			name: 'Dry run article',
			productType: '1',
			unit: 'Un',
			taxId: '1',
			priceMilli: 1000
		});
		const accessory = fake.articles.findIndex((a) => a.reference === 'T-ACC-1');
		const [removed] = fake.articles.splice(accessory, 1);
		const saves = fake.saves;
		const clients = fake.clients.length;

		It4BillingPlugin.options.mode = 'dry-run';
		try {
			await request(code);
			const rec = await waitFor(code, (r) => r.status === 'dry_run');
			const report = JSON.parse(rec.dryRunReport!);
			expect(report.wouldCreate).toEqual([
				`customer with NIF ${nif('61234567')}`,
				'article T-ACC-1'
			]);
			expect(report.totals.total).toBe(8900 + 615);
			expect(fake.saves).toBe(saves);
			expect(fake.clients).toHaveLength(clients);
			expect(fake.articles.some((a) => a.reference === 'T-ACC-1')).toBe(false);
		} finally {
			It4BillingPlugin.options.mode = 'live';
		}

		expect((await request(code)).status).toBe('PREPARING');
		await waitFor(code, (r) => r.status === 'issued' && r.hasCustomerPdf);
		expect(fake.saves - saves).toBe(1);
		expect(fake.articles.find((a) => a.reference === 'T-ACC-1')).toMatchObject({
			priceMilli: removed.priceMilli,
			taxId: removed.taxId
		});
	});

	test('an invoice issued by hand can be imported, so the order is never invoiced again', async () => {
		const customer = await newCustomer(nif('62345678'));
		const { code } = await placeOrder(customer, [['BOX-1', 1]]);
		const saves = fake.saves;
		const { importIt4billingInvoice } = await adminClient.query(
			gql`
				mutation ($code: String!, $pdf: String!) {
					importIt4billingInvoice(orderCode: $code, documentNumber: "FR FR/999", pdfBase64: $pdf) {
						status
						documentNumber
						hasCustomerPdf
					}
				}
			`,
			{ code, pdf: fake.pdf.toString('base64') }
		);
		expect(importIt4billingInvoice).toEqual({
			status: 'issued',
			documentNumber: 'FR FR/999',
			hasCustomerPdf: true
		});
		const view = await request(code);
		expect(view).toMatchObject({ status: 'ISSUED', documentNumber: 'FR FR/999' });
		await sleep(500);
		expect(fake.saves).toBe(saves);
		const res = await fetch(`http://localhost:3050${view.downloadPath}`, {
			headers: { authorization: `Bearer ${shopClient.getAuthToken()}` }
		});
		expect((await PDFDocument.load(new Uint8Array(await res.arrayBuffer()))).getPageCount()).toBe(
			1
		);
	});
});
