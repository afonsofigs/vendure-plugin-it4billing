# vendure-plugin-it4billing

[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![vendure version](https://img.shields.io/badge/vendure-%3E%3D3.0.0-blue.svg)](https://www.vendure.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)

Vendure plugin that issues certified invoice-receipts (_fatura-recibo_) in
[IT4Billing](https://www.it4billing.com) for your orders, straight from the server and without a
browser, and keeps the PDF so your customers can download it whenever they want.

> [!WARNING]
> **Work in progress.** This version contains the plugin skeleton and its options only. It does
> not issue documents yet. See the [roadmap](#roadmap).

> [!IMPORTANT]
> This is an unofficial project, not affiliated with or endorsed by IT4Billing. IT4Billing has no
> public API: the plugin uses the same requests as the IT4Billing web application. A change in that
> application can break it until the plugin is updated. Read the IT4Billing terms of service before
> using it, and use it at your own risk.

## How it works

1. The customer asks for the invoice of a paid order (for example, with a button in their account).
2. The plugin records the request and queues it. One emission runs at a time.
3. The worker logs in to IT4Billing with a dedicated user, finds or creates the customer (by NIF)
   and the articles (by reference), and builds the invoice-receipt.
4. Before saving, it checks that the document total matches the order total. If it does not, it
   stops.
5. It saves the document, prints it once, stores the PDF and logs out.
6. From then on, the customer downloads the stored PDF. IT4Billing is never asked for it again.

## Safety first

Issued tax documents cannot be deleted, only cancelled, and a cancellation stays in the SAF-T (PT)
file. So the plugin is built around a few rules:

- **One invoice per order.** The order is unique in the plugin's table, so two clicks or two
  browser tabs lead to the same invoice.
- **No blind retries.** Failures before the save step can be retried. Once the save request has
  been sent, the plugin never retries on its own: an emission with an unknown result is set aside
  for review and reconciled by the order code in the document comments.
- **`dry-run` by default.** In `dry-run` the plugin builds the whole document and checks it, then
  logs out without saving anything. Only `mode: 'live'` issues documents, and `liveOrderCodes`
  can limit it to the orders you choose for a supervised first run.
- **No lockouts.** A failed login is never retried. The queue pauses until an administrator
  resumes it.
- **The pace of a person.** Requests are spaced by `minRequestIntervalMs` (at least 500 ms).
- **Credentials stay out of the code.** Pass them from environment variables or a secret store.
  Validation errors never print them.

## Installation

```bash
pnpm add vendure-plugin-it4billing
```

## Setup

Create a dedicated IT4Billing user for the integration, then add the plugin to your Vendure config:

```typescript
import { It4BillingPlugin, InvoiceLineSpec } from 'vendure-plugin-it4billing';

export const config: VendureConfig = {
	plugins: [
		It4BillingPlugin.init({
			// The account segment of https://app.it4billing.com/<accountId>/
			accountId: process.env.IT4BILLING_ACCOUNT_ID!,
			credentials: {
				username: process.env.IT4BILLING_USER!,
				password: process.env.IT4BILLING_PASSWORD!
			},
			// Must match a payment method of your IT4Billing account.
			paymentMethod: 'Card',
			// Map each order line to an IT4Billing article.
			invoiceLines: (ctx, order) =>
				order.lines.map(
					(line): InvoiceLineSpec => ({
						article: {
							reference: line.productVariant.sku,
							name: line.productVariant.name,
							productType: 'product',
							unit: 'Un',
							taxType: 'normal',
							netUnitPrice: line.unitPrice
						},
						quantity: line.quantity,
						discountPercent: 0
					})
				),
			// Start with 'dry-run' and switch to 'live' once a dry run looks right.
			mode: 'dry-run'
		})
	]
};
```

## Options

| Option                 | Default                                                 | Description                                                                            |
| ---------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `accountId`            | required                                                | The account segment of the IT4Billing URL, normally the company's NIF.                 |
| `credentials`          | required                                                | `{ username, password }` of a dedicated IT4Billing user.                               |
| `paymentMethod`        | required                                                | Payment method name, exactly as listed in IT4Billing.                                  |
| `invoiceLines`         | required                                                | `(ctx, order, injector) => InvoiceLineSpec[]`: articles, tax types and line discounts. |
| `mode`                 | `'dry-run'`                                             | `'dry-run'` never saves; `'live'` issues documents.                                    |
| `liveOrderCodes`       | all orders                                              | In `live` mode, only these orders can be invoiced.                                     |
| `billingDetails`       | default billing address                                 | `(ctx, order, injector) => BillingDetails \| undefined`. No valid NIF, no invoice.     |
| `nifCustomField`       | `'nif'`                                                 | Address custom field read by the default `billingDetails`.                             |
| `isEligible`           | payment settled                                         | `(ctx, order, injector) => boolean`: which orders can have an invoice.                 |
| `comments`             | `(order) => order.code`                                 | Document comments (max 50 characters). Keep the order code in it.                      |
| `customerPdf`          | `'original-page'`                                       | The customer gets only the "Original" page; the full PDF is kept as the archive copy.  |
| `taxTypeIds`           | `{ normal: 1, reduced: 2, intermediate: 3, exempt: 4 }` | Ids of the IT4Billing tax types.                                                       |
| `minRequestIntervalMs` | `1500`                                                  | Minimum time between requests to IT4Billing (at least 500).                            |
| `requestTimeoutMs`     | `30000`                                                 | Timeout of each request.                                                               |
| `maxAutomaticRetries`  | `2`                                                     | Automatic retries, only for failures before the save step.                             |
| `retryDelayMs`         | `900000`                                                | Delay between automatic retries (15 minutes).                                          |

The plugin also exports `isValidNif()` and `normalizeNif()`, to validate a Portuguese NIF in your
own forms before it ever reaches IT4Billing.

## Roadmap

- [x] Plugin skeleton, options and NIF validation
- [ ] IT4Billing HTTP client (login, customers, articles, documents, PDF), tested against a local
      fake IT4Billing server
- [ ] Invoice records, emission queue, Shop and Admin API, PDF storage and `dry-run`
- [ ] Documentation of the full setup and a storefront example

## Testing

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

The tests never contact IT4Billing. They run against an in-memory Vendure server and, for the
HTTP client, a local fake of the IT4Billing web application.

## Requirements

- Vendure 3.x
- Node.js 20 or later
- An IT4Billing account with a user for the integration

## License

[MIT](./LICENSE)
