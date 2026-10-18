import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { InvoiceStorageStrategy } from './types';

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertSafeKey(key: string): void {
	if (!SAFE_KEY.test(key)) throw new Error(`Unsafe storage key: ${JSON.stringify(key)}`);
}

/**
 * @description
 * Keeps the PDFs as files in a local directory, readable only by the server user. It suits a single
 * server with a persistent disk. With several instances or ephemeral containers, write a strategy for
 * shared storage instead (for example S3).
 */
export class LocalInvoiceStorageStrategy implements InvoiceStorageStrategy {
	private readonly dir: string;

	constructor(dir: string) {
		this.dir = resolve(dir);
	}

	async save(key: string, data: Buffer): Promise<void> {
		assertSafeKey(key);
		await mkdir(this.dir, { recursive: true, mode: 0o700 });
		await writeFile(join(this.dir, key), data, { mode: 0o600 });
	}

	async read(key: string): Promise<Buffer | undefined> {
		assertSafeKey(key);
		try {
			return await readFile(join(this.dir, key));
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
			throw e;
		}
	}
}
