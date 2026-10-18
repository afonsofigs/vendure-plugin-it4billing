import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import ts from 'typescript-eslint';

export default defineConfig([
	{
		ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'src/test/__data__/**']
	},
	js.configs.recommended,
	...ts.configs.recommended,
	prettier,
	{
		rules: {
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
		}
	}
]);
