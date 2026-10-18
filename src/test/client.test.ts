import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
	It4BillingClient,
	LoginFailedError,
	ReadOnlyViolationError,
	SessionExpiredError,
	TransportError,
	type It4BillingClientOptions
} from '../client';
import type { RequestLog } from '../client/http';
import { nifCheckDigit } from '../nif';
import type { ArticleSpec, BillingDetails } from '../types';
import { FAKE_ACCOUNT, FakeIt4Billing } from './fake-it4billing';

const fake = new FakeIt4Billing();
const nif = (firstEight: string) => `${firstEight}${nifCheckDigit(firstEight)}`;

const customer: BillingDetails = {
	nif: nif('51234567'),
	name: 'Example Trading, Lda',
	streetLine: 'Rua de Exemplo, 1',
	postalCode: '1000-001',
	city: 'Lisboa',
	countryCode: 'PT'
};

const box: ArticleSpec = {
	reference: 'BOX-M-2610',
	name: 'Monthly box, October 2026',
	productType: 'product',
	unit: 'Un',
	taxType: 'intermediate',
	netUnitPrice: 7876
};

const accessory: ArticleSpec = {
	reference: 'ACC-1',
	name: 'Accessory',
	productType: 'product',
	unit: 'Un',
	taxType: 'normal',
	netUnitPrice: 500
};

function makeClient(overrides: Partial<It4BillingClientOptions> = {}) {
	const logs: RequestLog[] = [];
	const waits: number[] = [];
	const client = new It4BillingClient({
		baseUrl: fake.baseUrl,
		accountId: FAKE_ACCOUNT,
		credentials: { username: fake.username, password: fake.password },
		minRequestIntervalMs: 500,
		requestTimeoutMs: 5000,
		taxTypeIds: { normal: 1, reduced: 2, intermediate: 3, exempt: 4 },
		onRequest: (log) => logs.push(log),
		sleep: async (ms) => {
			waits.push(ms);
		},
		...overrides
	});
	return { client, logs, waits };
}

beforeAll(() => fake.start());
afterAll(() => fake.stop());
afterEach(() => {
	fake.password = 'not-a-real-password';
});

describe('It4BillingClient against the fake IT4Billing', () => {
	test('logs in and out, at the pace of a person', async () => {
		const { client, waits } = makeClient();
		await client.login();
		await client.logout();
		expect(fake.requests.at(-1)).toMatchObject({ method: 'GET', path: 'Login' });
		expect(waits.length).toBeGreaterThan(0);
		expect(waits.every((ms) => ms <= 500)).toBe(true);
	});

	test('names itself in the User-Agent, which IT4Billing needs to serve full pages', async () => {
		const { client } = makeClient();
		await client.login();
		expect(fake.lastUserAgent).toMatch(
			/^Mozilla\/5\.0 \(compatible; vendure-plugin-it4billing\/\d+\.\d+\.\d+\)$/
		);
		await client.logout();
		const { client: plain } = makeClient({ userAgent: 'node' });
		await expect(plain.login()).rejects.toThrow(/no ScriptManager/);
	});

	test('a refused login throws once and is never retried', async () => {
		const { client } = makeClient();
		fake.password = 'changed';
		const before = fake.logins;
		await expect(client.login()).rejects.toBeInstanceOf(LoginFailedError);
		expect(fake.logins - before).toBe(1);
	});

	test('creates and finds a customer by NIF', async () => {
		const { client } = makeClient();
		await client.login();
		expect(await client.findClientByNif(customer.nif)).toBeUndefined();
		const created = await client.createClient(customer);
		expect(created).toMatchObject({ nif: customer.nif, name: customer.name });
		expect(created.suggestion).toBe(
			`${created.id} | ${customer.name} | ${customer.name} | ${customer.nif}`
		);
		expect(fake.clients.at(-1)).toMatchObject({
			address: customer.streetLine,
			country: 'Portugal'
		});
		await client.logout();
	});

	test('creates articles with their tax type and net price', async () => {
		const { client } = makeClient();
		await client.login();
		const created = await client.createArticle(box);
		await client.createArticle(accessory);
		expect(created).toEqual({
			reference: box.reference,
			name: box.name,
			suggestion: `${box.reference} | ${box.name}`
		});
		expect(fake.articles.find((a) => a.reference === box.reference)).toMatchObject({
			taxId: '3',
			priceMilli: 78760,
			productType: '1'
		});
		await client.logout();
	});

	test('builds a two-rate invoice-receipt and only issues it on save', async () => {
		const { client } = makeClient();
		await client.login();
		const target = (await client.findClientByNif(customer.nif))!;
		const savesBefore = fake.saves;
		const totals = await client.buildDocument({
			documentType: 'Fatura-Recibo',
			client: target,
			lines: [
				{ article: box, quantity: 1, discountPercent: 20 },
				{ article: accessory, quantity: 2, discountPercent: 0, description: 'Accessory, black' }
			],
			paymentMethod: 'Card',
			comments: 'Order ABC123',
			referenceDate: new Date(2026, 8, 11)
		});
		// 78,76 with 20% is 63,008, rounded to 63,01; VAT 13% is 8,19. Plus 2 x 5,00 at 23%.
		expect(totals).toEqual({
			gross: 8876,
			discount: 1575,
			net: 7301,
			retention: 0,
			vat: 1049,
			total: 8350
		});
		expect(fake.saves).toBe(savesBefore);

		const number = await client.saveDocument();
		expect(number).toMatch(/^FR FR\/\d+$/);
		expect(fake.saves).toBe(savesBefore + 1);
		expect(fake.documents.at(-1)).toMatchObject({
			number,
			comments: 'Order ABC123',
			payment: 'Card',
			referralDate: '11-09-2026',
			total: 8350
		});
		expect(fake.documents.at(-1)!.lines[1].description).toBe('Accessory, black');

		const printsBefore = fake.prints;
		expect((await client.printDocument()).equals(fake.pdf)).toBe(true);
		expect(fake.prints).toBe(printsBefore + 1);
		await client.logout();
	});

	test('a read-only client builds documents but refuses every write', async () => {
		const { client } = makeClient({ readOnly: true });
		await client.login();
		const target = (await client.findClientByNif(customer.nif))!;
		const savesBefore = fake.saves;
		await client.buildDocument({
			documentType: 'Fatura-Recibo',
			client: target,
			lines: [{ article: box, quantity: 1, discountPercent: 20 }],
			paymentMethod: 'Card',
			comments: 'Order DRY'
		});
		await expect(client.saveDocument()).rejects.toBeInstanceOf(ReadOnlyViolationError);
		await expect(client.createClient(customer)).rejects.toBeInstanceOf(ReadOnlyViolationError);
		await expect(client.createArticle(box)).rejects.toBeInstanceOf(ReadOnlyViolationError);
		await expect(client.printDocument()).rejects.toBeInstanceOf(ReadOnlyViolationError);
		expect(fake.saves).toBe(savesBefore);
		await client.logout();
	});

	test('refuses an unknown article and values longer than the field allows', async () => {
		const { client } = makeClient({ readOnly: true });
		await client.login();
		const target = (await client.findClientByNif(customer.nif))!;
		const base = { documentType: 'Fatura-Recibo', client: target, paymentMethod: 'Card' };
		await expect(
			client.buildDocument({
				...base,
				lines: [{ article: { ...box, reference: 'MISSING' }, quantity: 1, discountPercent: 0 }],
				comments: 'x'
			})
		).rejects.toThrow(/MISSING does not exist/);
		await expect(
			client.buildDocument({
				...base,
				lines: [{ article: box, quantity: 1, discountPercent: 0 }],
				comments: 'x'.repeat(51)
			})
		).rejects.toThrow(/at most 50/);
		await client.logout();
	});

	test('notices an expired session instead of acting on the wrong page', async () => {
		const { client } = makeClient({ readOnly: true });
		await client.login();
		fake.expireSessions();
		await expect(client.buildDocument({} as never)).rejects.toBeInstanceOf(SessionExpiredError);
	});

	test('surfaces HTTP failures as transport errors', async () => {
		const { client } = makeClient({ readOnly: true });
		await client.login();
		fake.failOnce({ match: 'Search_Clients.ashx', status: 503 });
		await expect(client.findClientByNif(customer.nif)).rejects.toBeInstanceOf(TransportError);
		await client.logout();
	});

	test('logs requests without bodies, search terms or credentials', async () => {
		const { client, logs } = makeClient({ readOnly: true });
		await client.login();
		await client.findClientByNif(customer.nif);
		await client.logout();
		const text = JSON.stringify(logs);
		expect(text).not.toContain(fake.password);
		expect(text).not.toContain(fake.username);
		expect(text).not.toContain(customer.nif);
		expect(logs.find((l) => l.path === 'Search_Clients.ashx')).toBeDefined();
	});
});
