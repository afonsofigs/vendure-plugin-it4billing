import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// The e2e suite boots a full Vendure server; give it room on slow CI runners.
		testTimeout: 30000,
		hookTimeout: 120000,
		coverage: {
			provider: 'istanbul',
			reporter: ['text-summary', 'html']
		}
	}
});
