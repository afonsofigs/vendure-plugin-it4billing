/**
 * Read-only smoke test against a real IT4Billing account. One login, then searches and a document
 * built in the session up to the point before saving, then logout. Nothing is written: the client
 * runs with `readOnly: true`, which refuses to create customers or articles, save or print.
 *
 * Run it with the credentials in an env file that is not in this repository:
 *
 *   node --env-file=/path/outside/the/repo/it4billing.env --import tsx scripts/smoke.ts
 *
 * Environment:
 *   IT4BILLING_ACCOUNT_ID, IT4BILLING_USER, IT4BILLING_PASSWORD   required
 *   IT4BILLING_BASE_URL       default https://app.it4billing.com
 *   SMOKE_CLIENT_SEARCH       search term that finds exactly one existing test customer
 *   SMOKE_ARTICLE_REFERENCE   reference of an existing test article
 *   SMOKE_PAYMENT_METHOD      payment method name, as listed in IT4Billing
 *   SMOKE_DOCUMENT_TYPE       default Fatura-Recibo
 *   SMOKE_NET_CENTS           net price used on the lines, default 1000
 *
 * A failed login is reported and never retried.
 */
import { It4BillingClient, LoginFailedError } from '../src/client';

function env(name: string, fallback?: string): string {
	const value = process.env[name] ?? fallback;
	if (!value) throw new Error(`Missing ${name}`);
	return value;
}

async function main() {
	const client = new It4BillingClient({
		baseUrl: env('IT4BILLING_BASE_URL', 'https://app.it4billing.com'),
		accountId: env('IT4BILLING_ACCOUNT_ID'),
		credentials: { username: env('IT4BILLING_USER'), password: env('IT4BILLING_PASSWORD') },
		minRequestIntervalMs: 1500,
		requestTimeoutMs: 30000,
		taxTypeIds: { normal: 1, reduced: 2, intermediate: 3, exempt: 4 },
		readOnly: true,
		onRequest: (r) =>
			console.log(`  ${r.method} ${r.path} -> ${r.status ?? 'no answer'} (${r.ms} ms)`)
	});

	console.log('login');
	try {
		await client.login();
	} catch (e) {
		console.log(e instanceof LoginFailedError ? `LOGIN REFUSED, not retrying: ${e.message}` : e);
		process.exitCode = 1;
		return;
	}
	try {
		console.log('search customer');
		const clients = await client.searchClients(env('SMOKE_CLIENT_SEARCH'));
		console.log(`  ${clients.length} result(s)`);
		if (clients.length !== 1) throw new Error('SMOKE_CLIENT_SEARCH must find exactly one customer');

		console.log('search article');
		const reference = env('SMOKE_ARTICLE_REFERENCE');
		const article = await client.findArticle(reference);
		if (!article) throw new Error(`Article ${reference} not found`);

		const net = Number(env('SMOKE_NET_CENTS', '1000'));
		const spec = {
			reference,
			name: article.name,
			productType: 'product',
			unit: 'Un',
			netUnitPrice: net
		} as const;
		console.log('build document (never saved)');
		const totals = await client.buildDocument({
			documentType: env('SMOKE_DOCUMENT_TYPE', 'Fatura-Recibo'),
			client: clients[0],
			lines: [
				{ article: { ...spec, taxType: 'intermediate' }, quantity: 1, discountPercent: 20 },
				{ article: { ...spec, taxType: 'normal' }, quantity: 2, discountPercent: 0 }
			],
			paymentMethod: env('SMOKE_PAYMENT_METHOD'),
			comments: 'Smoke test, never saved',
			referenceDate: new Date()
		});
		console.log('  totals (cents):', JSON.stringify(totals));
	} finally {
		console.log('logout');
		await client.logout();
	}
}

main().catch((e) => {
	console.log(`SMOKE FAILED: ${e instanceof Error ? `${e.name}: ${e.message}` : e}`);
	process.exitCode = 1;
});
