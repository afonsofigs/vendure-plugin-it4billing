import {
	createTestEnvironment,
	registerInitializer,
	SqljsInitializer,
	testConfig
} from '@vendure/testing';
import path from 'path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { IT4BILLING_PLUGIN_OPTIONS } from '../constants';
import { It4BillingPlugin } from '../plugin';
import type { It4BillingPluginOptions } from '../types';
import { initialData } from './fixtures/initial-data';

registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__data__')));

describe('It4BillingPlugin', () => {
	const { server } = createTestEnvironment({
		...testConfig,
		// Its own port: the e2e files run in parallel.
		apiOptions: { ...testConfig.apiOptions, port: 3051 },
		plugins: [
			It4BillingPlugin.init({
				// The account and credentials are placeholders: this suite never talks to IT4Billing.
				accountId: '000000000',
				credentials: { username: 'integration-user', password: 'not-a-real-password' },
				paymentMethod: 'Card',
				invoiceLines: () => []
			})
		]
	});

	beforeAll(async () => {
		await server.init({ initialData, customerCount: 1 });
	});

	afterAll(async () => {
		await server.destroy();
	});

	test('boots inside Vendure and exposes the resolved options', () => {
		const options = server.app.get<It4BillingPluginOptions>(IT4BILLING_PLUGIN_OPTIONS);
		expect(options.accountId).toBe('000000000');
		expect(options.mode).toBe('dry-run');
		expect(options.minRequestIntervalMs).toBe(1500);
		expect(options.userAgent).toMatch(/^Mozilla\/5\.0 \(compatible; vendure-plugin-it4billing\//);
	});
});
