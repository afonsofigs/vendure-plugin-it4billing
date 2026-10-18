# vendure-plugin-it4billing

[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![vendure version](https://img.shields.io/badge/vendure-%3E%3D3.0.0-blue.svg)](https://www.vendure.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)

Vendure plugin that issues certified invoice-receipts (_fatura-recibo_) in
[IT4Billing](https://www.it4billing.com) for your orders, straight from the server and without a
browser, and keeps the PDF so your customers can download it whenever they want.

> [!WARNING]
> **Pre-release.** The plugin issues invoices end to end, but it has only been tested against a
> local fake of IT4Billing and a read-only smoke test. Start in `dry-run` mode. See the
> [roadmap](#roadmap).

> [!IMPORTANT]
> This is an unofficial project, not affiliated with or endorsed by IT4Billing. IT4Billing has no
> public API: the plugin uses the same requests as the IT4Billing web application. A change in that
> application can break it until the plugin is updated. Read the IT4Billing terms of service before
> using it, and use it at your own risk.

## How it works

1. The customer asks for the invoice of a paid order (for example, with a button in their account)
   through the Shop API mutation `requestOrderInvoice`.
2. The plugin records the request and queues it. One emission runs at a time, across processes and
   servers.
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
  Validation errors and request logs never print them, nor request bodies or search terms.
- **An honest User-Agent by default.** Requests identify themselves as
  `Mozilla/5.0 (compatible; vendure-plugin-it4billing/<version>)`. IT4Billing needs the
  `Mozilla/5.0` token to serve its full pages; the rest names the plugin. You can set your own with
  the `userAgent` option; it is validated at startup.

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

| Option                   | Default                                                         | Description                                                                            |
| ------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `accountId`              | required                                                        | The account segment of the IT4Billing URL, normally the company's NIF.                 |
| `credentials`            | required                                                        | `{ username, password }` of a dedicated IT4Billing user.                               |
| `paymentMethod`          | required                                                        | Payment method name, exactly as listed in IT4Billing.                                  |
| `invoiceLines`           | required                                                        | `(ctx, order, injector) => InvoiceLineSpec[]`: articles, tax types and line discounts. |
| `mode`                   | `'dry-run'`                                                     | `'dry-run'` never saves; `'live'` issues documents.                                    |
| `liveOrderCodes`         | all orders                                                      | In `live` mode, only these orders can be invoiced.                                     |
| `billingDetails`         | default billing address                                         | `(ctx, order, injector) => BillingDetails \| undefined`. No valid NIF, no invoice.     |
| `nifCustomField`         | `'nif'`                                                         | Address custom field read by the default `billingDetails`.                             |
| `isEligible`             | payment settled                                                 | `(ctx, order, injector) => boolean`: which orders can have an invoice.                 |
| `comments`               | `(order) => order.code`                                         | Document comments (max 50 characters). Keep the order code in it.                      |
| `customerPdf`            | `'original-page'`                                               | The customer gets only the "Original" page; the full PDF is kept as the archive copy.  |
| `taxTypeIds`             | `{ normal: 1, reduced: 2, intermediate: 3, exempt: 4 }`         | Ids of the IT4Billing tax types.                                                       |
| `minRequestIntervalMs`   | `1500`                                                          | Minimum time between requests to IT4Billing (at least 500).                            |
| `requestTimeoutMs`       | `30000`                                                         | Timeout of each request.                                                               |
| `userAgent`              | `Mozilla/5.0 (compatible; vendure-plugin-it4billing/<version>)` | User-Agent sent to IT4Billing. Must start with `Mozilla/5.0`.                          |
| `documentType`           | `'Fatura-Recibo'`                                               | Document type as listed in IT4Billing; the series comes with it.                       |
| `referenceDate`          | order placed date                                               | `(ctx, order, injector) => Date`: the document's reference date.                       |
| `storage`                | `LocalInvoiceStorageStrategy('./it4billing-invoices')`          | Where the archive and customer PDFs are kept.                                          |
| `orderRelations`         | none                                                            | Extra order relations to load for your strategies.                                     |
| `dryRunCustomerSearch`   | none                                                            | Existing test customer used by a dry run when the real one does not exist yet.         |
| `dryRunArticleReference` | none                                                            | Existing test article used by a dry run when an article does not exist yet.            |
| `maxAutomaticRetries`    | `2`                                                             | Automatic retries, only for failures before the save step.                             |
| `retryDelayMs`           | `900000`                                                        | Delay between automatic retries (15 minutes).                                          |

The plugin also exports `isValidNif()` and `normalizeNif()`, to validate a Portuguese NIF in your
own forms before it ever reaches IT4Billing.

## Storefront API

```graphql
# On every order of the active customer
order { it4billingInvoice { status documentNumber issuedAt downloadPath } }

# Asks for the invoice. Safe to call more than once: every call ends on the same invoice.
mutation { requestOrderInvoice(orderCode: "ABC123") { status } }
```

| `status`       | Meaning                                                                   |
| -------------- | ------------------------------------------------------------------------- |
| `NONE`         | Can be invoiced and has not been yet                                      |
| `MISSING_NIF`  | The default billing address has no valid NIF: ask the customer for one    |
| `PREPARING`    | Being issued, or waiting for someone to check it. Never a technical error |
| `ISSUED`       | Issued; download it from `downloadPath`                                   |
| `NOT_ELIGIBLE` | Not paid, cancelled, or excluded by `isEligible` or `liveOrderCodes`      |

`GET /it4billing/invoices/:orderCode/pdf` returns the stored PDF, only to the order's own customer
(send the same session token or cookie as the Shop API). IT4Billing is never asked for it again.

## Admin API

- `it4billingInvoices(status)` and `it4billingQueueStatus`
- `retryIt4billingInvoice(id, confirmNotIssued)`: queues a failed invoice or a dry run again. An
  invoice in `needs_review` may already exist in IT4Billing: retry it only after checking there,
  with `confirmNotIssued: true`
- `resumeIt4billingQueue`: after a refused login has been fixed
- `importIt4billingInvoice(orderCode, documentNumber, pdfBase64)`: records an invoice issued
  outside the plugin (or a `needs_review` one found in IT4Billing), so the order is never
  invoiced again

## Events

`It4BillingInvoiceEvent` is published with a `type`: `issued`, `dry_run`, and the ones someone
should hear about: `failed` (stopped before saving, nothing issued), `needs_review` (the save may
have happened), `pdf_missing` (issued, PDF not stored) and `queue_paused` (login refused). Subscribe
to it, for example with an `EmailEventListener`, to alert the team.

## Storage, database and scheduler

- **PDFs** go through an `InvoiceStorageStrategy` (`save` and `read`). The default,
  `LocalInvoiceStorageStrategy`, writes files to a local directory; with several instances or
  ephemeral containers, implement the interface on shared storage (for example S3).
- **Tables:** `It4BillingInvoice` (one per order, the order id is unique) and
  `It4BillingQueueState`. Generate a migration after adding the plugin, or rely on `synchronize`.
- **Scheduler:** retries and recovery after a crash run in the scheduled task
  `it4billing-process-due`, every 5 minutes. Add a scheduler plugin such as
  `DefaultSchedulerPlugin`.

## Roadmap

- [x] Plugin skeleton, options and NIF validation
- [x] IT4Billing HTTP client (login, customers, articles, documents, PDF), tested against a local
      fake IT4Billing server and smoke-tested read-only against a real account
- [x] Invoice records, emission queue, Shop and Admin API, PDF storage and `dry-run`
- [ ] Automatic reconciliation of `needs_review` invoices (today: check IT4Billing and import)
- [ ] Credit notes and cancellations (today: by hand in IT4Billing)
- [ ] Documentation of the full setup and a storefront example

## Testing

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

The tests never contact IT4Billing. They run against an in-memory Vendure server and, for the
HTTP client, a local fake of the IT4Billing web application (`src/test/fake-it4billing.ts`).

### Smoke test against a real account

`scripts/smoke.ts` checks the client against a real IT4Billing account without writing anything:
one login, a customer and an article search, a two-line document built in the session up to the
point before saving, and logout. The client runs read-only, so it cannot create, save or print.
Use an existing test customer and test article, and keep the credentials in a file outside the
repository:

```bash
IT4BILLING_ACCOUNT_ID=... SMOKE_CLIENT_SEARCH=... SMOKE_ARTICLE_REFERENCE=... \
SMOKE_PAYMENT_METHOD=... node --env-file=/outside/the/repo/it4billing.env --import tsx scripts/smoke.ts
```

A refused login is reported and never retried.

## Requirements

- Vendure 3.x
- Node.js 20 or later
- An IT4Billing account with a user for the integration

## License

[MIT](./LICENSE)
