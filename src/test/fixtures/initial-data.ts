import { LanguageCode } from '@vendure/common/lib/generated-types';
import type { InitialData } from '@vendure/core';

// Generic store data for the e2e server. Nothing here refers to a real business.
export const initialData: InitialData = {
	defaultLanguage: LanguageCode.en,
	defaultZone: 'Europe',
	taxRates: [
		{ name: 'Normal', percentage: 23 },
		{ name: 'Intermediate', percentage: 13 },
		{ name: 'Reduced', percentage: 6 }
	],
	shippingMethods: [{ name: 'Standard Shipping', price: 0 }],
	paymentMethods: [],
	countries: [
		{ name: 'Portugal', code: 'PT', zone: 'Europe' },
		{ name: 'Spain', code: 'ES', zone: 'Europe' }
	],
	collections: []
};
