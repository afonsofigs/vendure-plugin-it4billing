import { SessionExpiredError, TransportError } from './errors';

export interface HttpResponse {
	status: number;
	url: string;
	headers: Headers;
	body: Buffer;
	text(): string;
}

export interface RequestLog {
	method: string;
	/** Path relative to the account, without the query string values of searches. */
	path: string;
	status?: number;
	ms: number;
}

export interface HttpSessionOptions {
	/** `https://host/<accountId>/`, with the trailing slash. */
	accountUrl: string;
	minRequestIntervalMs: number;
	requestTimeoutMs: number;
	userAgent: string;
	/** Called after each request, with no bodies, headers or credentials. */
	onRequest?: (log: RequestLog) => void;
	/** Injected in tests to replace the clock. */
	sleep?: (ms: number) => Promise<void>;
}

const MAX_REDIRECTS = 5;

/**
 * @description
 * One IT4Billing session: a cookie jar, a minimum interval between requests (the pace of a person),
 * a timeout per request and manually followed redirects, so a bounce to the login page is noticed.
 */
export class HttpSession {
	private cookies = new Map<string, string>();
	private lastRequestAt = 0;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(private readonly options: HttpSessionOptions) {
		this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	}

	url(path: string): string {
		return new URL(path, this.options.accountUrl).toString();
	}

	get(path: string): Promise<HttpResponse> {
		return this.request('GET', this.url(path));
	}

	/** `expectLogin` accepts a redirect to the login page, which is what logging out does. */
	post(
		path: string,
		fields: [string, string][],
		extraHeaders: Record<string, string> = {},
		opts: { expectLogin?: boolean } = {}
	): Promise<HttpResponse> {
		const body = new URLSearchParams(fields).toString();
		const headers = {
			'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
			...extraHeaders
		};
		return this.request('POST', this.url(path), body, headers, 0, opts.expectLogin);
	}

	private async request(
		method: string,
		url: string,
		body?: string,
		headers: Record<string, string> = {},
		redirects = 0,
		expectLogin = false
	): Promise<HttpResponse> {
		const wait = this.lastRequestAt + this.options.minRequestIntervalMs - Date.now();
		if (wait > 0) await this.sleep(wait);
		this.lastRequestAt = Date.now();

		const started = Date.now();
		let res: Response;
		try {
			res = await fetch(url, {
				method,
				body,
				redirect: 'manual',
				headers: {
					'user-agent': this.options.userAgent,
					...headers,
					...(this.cookies.size ? { cookie: this.cookieHeader() } : {})
				},
				signal: AbortSignal.timeout(this.options.requestTimeoutMs)
			});
		} catch (e) {
			this.log(method, url, undefined, started);
			const reason = e instanceof Error && e.name === 'TimeoutError' ? 'timed out' : 'failed';
			throw new TransportError(`${method} ${this.path(url)} ${reason}`);
		}
		this.storeCookies(res.headers);
		this.log(method, url, res.status, started);

		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get('location');
			if (!location) throw new TransportError(`Redirect without location from ${this.path(url)}`);
			const target = new URL(location, url).toString();
			if (!target.startsWith(this.options.accountUrl)) {
				// For example the "account not found" page of the public site, after a relative
				// redirect to the login page from a sub-folder.
				throw new SessionExpiredError(`IT4Billing redirected ${this.path(url)} out of the account`);
			}
			if (isLoginUrl(target) && !isLoginUrl(url) && !expectLogin) {
				throw new SessionExpiredError(`IT4Billing redirected ${this.path(url)} to the login page`);
			}
			if (redirects >= MAX_REDIRECTS) throw new TransportError('Too many redirects');
			return this.request('GET', target, undefined, {}, redirects + 1, expectLogin);
		}
		if (res.status >= 400) {
			throw new TransportError(`${method} ${this.path(url)} answered ${res.status}`, res.status);
		}
		const buffer = Buffer.from(await res.arrayBuffer());
		return {
			status: res.status,
			url,
			headers: res.headers,
			body: buffer,
			text: () => buffer.toString('utf8')
		};
	}

	private storeCookies(headers: Headers) {
		for (const line of headers.getSetCookie()) {
			const [pair] = line.split(';');
			const eq = pair.indexOf('=');
			if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
		}
	}

	private cookieHeader(): string {
		return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
	}

	private path(url: string): string {
		const u = new URL(url);
		const base = new URL(this.options.accountUrl).pathname;
		const path = u.pathname.startsWith(base) ? u.pathname.slice(base.length) : u.pathname;
		// Search terms may be a NIF or a name: keep them out of logs and error messages.
		return /\.ashx$/i.test(path) ? path : `${path}${u.search}`;
	}

	private log(method: string, url: string, status: number | undefined, started: number) {
		this.options.onRequest?.({ method, path: this.path(url), status, ms: Date.now() - started });
	}
}

export function isLoginUrl(url: string): boolean {
	return /\/Login$/i.test(new URL(url).pathname);
}
