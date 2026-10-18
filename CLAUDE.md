# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Overview

Vendure plugin that issues invoice-receipts in IT4Billing (Portuguese certified invoicing) for
orders, by replaying the requests of the IT4Billing web application (ASP.NET WebForms), and stores
the PDF for customers. Published as `vendure-plugin-it4billing`.

## Hard rules

- **This repository is public.** Never commit anything that ties it to a real IT4Billing account or
  business: no account ids, NIFs, company or store names, customer data, captures of the web
  application, HAR files or credentials. Tests use placeholders (`000000000`) and NIFs computed in
  the test from arbitrary prefixes.
- **Tests never contact IT4Billing.** The HTTP client is tested against a local fake server.
- **Nothing is ever saved in IT4Billing during development.** Saving a document issues a certified
  tax document that cannot be deleted. `dry-run` is the default mode and stays the default.
- **A failed login is never retried**, and the save request is never retried automatically.

## Commands

```bash
pnpm install
pnpm lint        # Prettier check + ESLint
pnpm format      # Prettier write + ESLint fix
pnpm typecheck   # tsc over src and tests
pnpm test        # Vitest (unit + e2e with @vendure/testing and sql.js)
pnpm build       # dist/
```

Run a single test: `pnpm vitest run -t "substring"`.

## Structure

- `src/plugin.ts`: `It4BillingPlugin` and `init(options)`; options are injected with the
  `IT4BILLING_PLUGIN_OPTIONS` token.
- `src/types.ts`: the documented options and the strategy types (`BillingDetails`, `ArticleSpec`,
  `InvoiceLineSpec`).
- `src/options.ts`: defaults merge and validation. Validation runs at `init`, so a misconfigured
  plugin stops the server at startup. Error messages must never contain credentials.
- `src/nif.ts`: Portuguese NIF normalization and check digit.
- `src/test/`: e2e tests; `src/test/__data__/` is generated and ignored.

## Code style

Tabs, single quotes, 100 columns, no trailing commas (`.prettierrc`). Unused arguments start
with `_`. Money is in integer cents.
