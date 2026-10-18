import type {
	ArticleSpec,
	BillingDetails,
	It4BillingCredentials,
	It4BillingTaxType,
	InvoiceLineSpec
} from '../types';
import { isDelta, parseDelta, type Delta } from './delta';
import {
	It4BillingError,
	LoginFailedError,
	ReadOnlyViolationError,
	SessionExpiredError,
	UnexpectedPageError,
	ValidationMessageError
} from './errors';
import { WebForm } from './form';
import { HttpSession, isLoginUrl, type RequestLog } from './http';
import { formatCents, formatDate, formatDecimal, parseAmount } from './money';
import { DEFAULT_USER_AGENT } from '../constants';

export interface It4BillingClientOptions {
	baseUrl: string;
	accountId: string;
	credentials: It4BillingCredentials;
	minRequestIntervalMs: number;
	requestTimeoutMs: number;
	taxTypeIds: Record<It4BillingTaxType, number>;
	/** Defaults to {@link DEFAULT_USER_AGENT}, which names the plugin. */
	userAgent?: string;
	/** Refuse every write: creating customers or articles, saving or printing documents. */
	readOnly?: boolean;
	onRequest?: (log: RequestLog) => void;
	/** Injected in tests to replace the clock. */
	sleep?: (ms: number) => Promise<void>;
}

/** A customer as returned by the IT4Billing customer search. */
export interface ClientRecord {
	id: string;
	name: string;
	fiscalName: string;
	nif: string;
	/** The suggestion exactly as IT4Billing returned it; the document form expects it verbatim. */
	suggestion: string;
}

/** An article as returned by the IT4Billing product search. */
export interface ArticleRecord {
	reference: string;
	name: string;
	suggestion: string;
}

/** Document totals, in cents, as shown by IT4Billing before saving. */
export interface DocumentTotals {
	gross: number;
	discount: number;
	net: number;
	retention: number;
	vat: number;
	total: number;
}

export interface DocumentInput {
	/** Document type exactly as listed in IT4Billing, for example `Fatura-Recibo`. */
	documentType: string;
	client: ClientRecord;
	lines: InvoiceLineSpec[];
	paymentMethod: string;
	comments: string;
	/** Optional reference date (for example the payment date). The document date is always today. */
	referenceDate?: Date;
}

interface Page {
	path: string;
	form: WebForm;
}

const PANEL = 'ctl00$Content$UpdatePanel1';
const DOCUMENTS = 'Documents?Entity=Client';
const PRODUCT_TYPE_VALUES = { product: '1', service: '2', other: '3' } as const;

/**
 * @description
 * Replays the requests of the IT4Billing web application. One instance is one session: log in,
 * do the work, log out. The class never retries anything on its own.
 */
export class It4BillingClient {
	private readonly http: HttpSession;
	private page?: Page;
	private loggedIn = false;

	constructor(private readonly options: It4BillingClientOptions) {
		const base = options.baseUrl.replace(/\/+$/, '');
		this.http = new HttpSession({
			accountUrl: `${base}/${options.accountId}/`,
			minRequestIntervalMs: options.minRequestIntervalMs,
			requestTimeoutMs: options.requestTimeoutMs,
			userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
			onRequest: options.onRequest,
			sleep: options.sleep
		});
	}

	// ---- Session ---------------------------------------------------------------------------

	/** Logs in once. Throws `LoginFailedError` if IT4Billing refuses; never retry that. */
	async login(): Promise<void> {
		const page = await this.open('Login');
		if (!page.form.has('T_username') || !page.form.has('T_password')) {
			throw new UnexpectedPageError('The login page has no username or password field');
		}
		if (/captcha|recaptcha|hcaptcha|turnstile/i.test(page.form.root.toString())) {
			throw new LoginFailedError('The login page asks for a captcha');
		}
		page.form.set('T_username', this.options.credentials.username);
		page.form.set('T_password', this.options.credentials.password);
		let delta: Delta;
		try {
			delta = await this.asyncPostback(page, 'upnl', { eventTarget: 'B_ok' }, { login: true });
		} finally {
			// Do not keep the password in the page held in memory.
			if (page.form.has('T_password')) page.form.set('T_password', '');
		}
		if (!delta.redirect || isLoginUrl(this.http.url(delta.redirect))) {
			const message = page.form.validationMessage();
			throw new LoginFailedError(`IT4Billing refused the login${message ? `: ${message}` : ''}`);
		}
		await this.open(delta.redirect);
		this.loggedIn = true;
	}

	/** Logs out from the current page. Safe to call when the session already ended. */
	async logout(): Promise<void> {
		if (!this.loggedIn) return;
		this.loggedIn = false;
		const page = this.page ?? (await this.open(DOCUMENTS));
		const fields = this.withEventTarget(page.form.fields(), 'ctl00$Logout');
		await this.http.post(page.path, fields, {}, { expectLogin: true });
		this.page = undefined;
	}

	// ---- Searches (read only) --------------------------------------------------------------

	async searchClients(term: string): Promise<ClientRecord[]> {
		return (await this.suggestions('Search_Clients.ashx', term)).flatMap((suggestion) => {
			const [id, name, fiscalName, nif] = suggestion.split(' | ').map((s) => s.trim());
			return id && nif !== undefined ? [{ id, name, fiscalName, nif, suggestion }] : [];
		});
	}

	/** The customer with exactly this NIF, if there is one. */
	async findClientByNif(nif: string): Promise<ClientRecord | undefined> {
		const matches = (await this.searchClients(nif)).filter((c) => c.nif === nif);
		if (matches.length > 1) {
			throw new UnexpectedPageError(`IT4Billing has ${matches.length} customers with that NIF`);
		}
		return matches[0];
	}

	async searchArticles(term: string): Promise<ArticleRecord[]> {
		return (await this.suggestions('Search_Product.ashx', term)).flatMap((suggestion) => {
			const sep = suggestion.indexOf(' | ');
			if (sep < 0) return [];
			return [{ reference: suggestion.slice(0, sep), name: suggestion.slice(sep + 3), suggestion }];
		});
	}

	/** The article with exactly this reference, if there is one. */
	async findArticle(reference: string): Promise<ArticleRecord | undefined> {
		return (await this.searchArticles(reference)).find((a) => a.reference === reference);
	}

	// ---- Writes ----------------------------------------------------------------------------

	/** Creates a customer and returns it as found by its NIF afterwards. */
	async createClient(details: BillingDetails): Promise<ClientRecord> {
		this.assertWritable('create a customer');
		const form = await this.openCreateForm('Clients/List', 'Client');
		this.fill(form.form, 'ctl00$Content$Fiscalnumber', details.nif);
		form.form.selectByText('ctl00$Content$Ddlcountries', countryName(details.countryCode));
		this.fill(form.form, 'ctl00$Content$Fiscalname', details.name);
		this.fill(form.form, 'ctl00$Content$Name', details.name);
		this.fill(form.form, 'ctl00$Content$Address', details.streetLine);
		this.fill(form.form, 'ctl00$Content$Postalcode', details.postalCode);
		this.fill(form.form, 'ctl00$Content$City', details.city);
		await this.saveForm(form, 'ctl00$Content$SaveClient');
		const created = await this.findClientByNif(details.nif);
		if (!created) throw new UnexpectedPageError('The new customer was not found after saving it');
		return created;
	}

	/** Creates an article with one price line for the main store, and returns it. */
	async createArticle(spec: ArticleSpec): Promise<ArticleRecord> {
		this.assertWritable('create an article');
		if (spec.taxType === 'exempt') {
			throw new It4BillingError('Creating exempt articles is not supported yet');
		}
		const page = await this.openCreateForm('Articles/List', 'Article');
		const f = page.form;
		this.fill(f, 'ctl00$Content$Internalcode', spec.reference);
		this.fill(f, 'ctl00$Content$Name', spec.name);
		f.set('ctl00$Content$ProductType', PRODUCT_TYPE_VALUES[spec.productType]);
		f.selectByText('ctl00$Content$DdlMeasures', spec.unit);

		const taxField = this.requireName(f, '$DdlTaxTypesNew');
		const row = taxField.slice(0, -'DdlTaxTypesNew'.length);
		f.set(taxField, String(this.options.taxTypeIds[spec.taxType]));
		await this.asyncPostback(page, PANEL, { button: 'ctl00$Content$GridViewTaxRowFooterBtn' });
		f.set(`${row}PriceNew`, formatCents(spec.netUnitPrice));
		await this.asyncPostback(page, 'ctl00$ScriptManager', { eventTarget: `${row}lnkInsertFooter` });
		this.assertNoValidationMessage(f);
		const price = f.findName('$Price');
		if (!price || parseAmount(f.value(price)) !== spec.netUnitPrice) {
			throw new UnexpectedPageError('The article price line was not added as expected');
		}
		await this.saveForm(page, 'ctl00$Content$SaveArticle');
		const created = await this.findArticle(spec.reference);
		if (!created) throw new UnexpectedPageError('The new article was not found after saving it');
		return created;
	}

	// ---- Documents -------------------------------------------------------------------------

	/**
	 * Builds a document in the session, up to the point right before saving, and returns the totals
	 * IT4Billing computed. Nothing is written to the account: the document only lives in the session.
	 */
	async buildDocument(input: DocumentInput): Promise<DocumentTotals> {
		const page = await this.open(DOCUMENTS);
		const f = page.form;

		f.selectByText('ctl00$Content$DocumentSerie', input.documentType);
		await this.asyncPostback(page, PANEL, { button: 'ctl00$Content$DocumentSeriesChangeBtn' });

		f.set('ctl00$Content$Entity', input.client.suggestion);
		await this.asyncPostback(page, PANEL, { button: 'ctl00$Content$DocumentEntityBtn' });
		if (f.value('ctl00$Content$EntityId') !== input.client.id) {
			throw new UnexpectedPageError('The document did not take the customer');
		}

		for (const line of input.lines) await this.addLine(page, line);

		f.selectByText('ctl00$Content$tpaymentmethod', input.paymentMethod);
		this.fill(f, 'ctl00$Content$Comments', input.comments);
		if (input.referenceDate) {
			f.set('ctl00$Content$ReferralDate', formatDate(input.referenceDate));
			await this.asyncPostback(page, PANEL, { button: 'ctl00$Content$VerifyDateBtn' });
			this.assertNoValidationMessage(f);
		}
		return this.totals(f);
	}

	/**
	 * Saves the document built by `buildDocument`. **This issues a certified tax document that can
	 * never be deleted.** Returns the number IT4Billing assigned. If this throws after the request
	 * was sent, the outcome is unknown: never call it again for the same order without reconciling.
	 */
	async saveDocument(): Promise<string> {
		this.assertWritable('save a document');
		const page = this.page;
		if (!page || page.path !== DOCUMENTS || !page.form.has('ctl00$Content$SaveDocumentBtn')) {
			throw new It4BillingError('There is no document ready to save in this session');
		}
		const fields = this.withEventTarget(page.form.fields(), '');
		fields.push(['ctl00$Content$SaveDocumentBtn', '']);
		const res = await this.http.post(page.path, fields);
		const form = new WebForm(res.text());
		this.page = { path: DOCUMENTS, form };
		this.assertNoValidationMessage(form);
		const number = form.has('ctl00$Content$DocumentNumber')
			? form.value('ctl00$Content$DocumentNumber').trim()
			: '';
		if (!number) throw new UnexpectedPageError('The save response has no document number');
		return number;
	}

	/** Prints the document just saved and returns the PDF IT4Billing generated. */
	async printDocument(): Promise<Buffer> {
		this.assertWritable('print a document');
		const page = this.page;
		if (!page || !page.form.has('ctl00$Content$DocumentNumber')) {
			throw new It4BillingError('There is no saved document open in this session');
		}
		const delta = await this.asyncPostback(page, 'ctl00$ScriptManager', {
			eventTarget: 'ctl00$Content$PrintDocument'
		});
		const name = delta.scripts
			.map((s) => s.match(/PrintPreviewDocument\('([^']+)'\)/)?.[1])
			.find(Boolean);
		if (!name) throw new UnexpectedPageError('The print response has no PDF');
		const res = await this.http.get(`PdfPreview.ashx?Document=${encodeURIComponent(name)}`);
		if (res.body.subarray(0, 5).toString('latin1') !== '%PDF-') {
			throw new UnexpectedPageError('The print download is not a PDF');
		}
		return res.body;
	}

	// ---- Internals -------------------------------------------------------------------------

	private async addLine(page: Page, line: InvoiceLineSpec) {
		const f = page.form;
		const articleField = this.requireName(f, '$ArticleNew');
		const row = articleField.slice(0, -'ArticleNew'.length);
		const article = await this.findArticle(line.article.reference);
		if (!article) {
			throw new It4BillingError(`Article ${line.article.reference} does not exist in IT4Billing`);
		}
		f.set(articleField, article.suggestion);
		await this.asyncPostback(page, PANEL, { button: 'ctl00$Content$DocumentNewArticleDataBtn' });
		if (!f.value(`${row}DescriptionNew`)) {
			throw new UnexpectedPageError(`The line did not take article ${line.article.reference}`);
		}
		if (line.description) this.fill(f, `${row}DescriptionNew`, line.description);
		f.set(`${row}QuantityNew`, formatDecimal(line.quantity));
		f.set(`${row}PriceNew`, formatCents(line.article.netUnitPrice));
		f.set(`${row}DiscountNew`, formatDecimal(line.discountPercent));
		f.set(`${row}TaxNew`, String(this.options.taxTypeIds[line.article.taxType]));
		await this.asyncPostback(page, PANEL, { button: 'ctl00$Content$GridViewTotalRowFooterBtn' });
		await this.asyncPostback(page, 'ctl00$ScriptManager', { eventTarget: `${row}lnkInsertFooter` });
		this.assertNoValidationMessage(f);
		if (f.findName('$ArticleNew') === articleField) {
			throw new UnexpectedPageError(`The line for ${line.article.reference} was not added`);
		}
	}

	private totals(f: WebForm): DocumentTotals {
		const read = (id: string) => {
			const text = f.textById(id, 'span');
			const cents = text === undefined ? undefined : parseAmount(text);
			if (cents === undefined) throw new UnexpectedPageError(`The document has no ${id}`);
			return cents;
		};
		return {
			gross: read('TotalGrossAmmount'),
			discount: read('TotalDiscount'),
			net: read('TotalNetAmmount'),
			retention: read('TotalRetention'),
			vat: read('TotalVat'),
			total: read('Total')
		};
	}

	/** "Criar" on a list page, then the empty form it leads to. */
	private async openCreateForm(listPath: string, formPath: string): Promise<Page> {
		const list = await this.open(listPath);
		const delta = await this.asyncPostback(list, PANEL, { eventTarget: 'ctl00$Content$bcreate' });
		if (!delta.redirect)
			throw new UnexpectedPageError(`"Create" on ${listPath} did not open a form`);
		const page = await this.open(delta.redirect);
		if (!new URL(this.http.url(delta.redirect)).pathname.endsWith(`/${formPath}`)) {
			throw new UnexpectedPageError(`"Create" on ${listPath} opened an unexpected page`);
		}
		return page;
	}

	/** Saves a create form; IT4Billing answers with a redirect back to the list. */
	private async saveForm(page: Page, target: string) {
		const delta = await this.asyncPostback(page, 'ctl00$ScriptManager', { eventTarget: target });
		this.assertNoValidationMessage(page.form);
		if (!delta.redirect) throw new UnexpectedPageError(`${target} did not complete`);
	}

	private async open(path: string): Promise<Page> {
		const res = await this.http.get(path);
		const relative = new URL(res.url).pathname.replace(/^\/[^/]+\//, '') + new URL(res.url).search;
		const page = { path: relative, form: new WebForm(res.text()) };
		this.page = page;
		return page;
	}

	private async suggestions(handler: string, term: string): Promise<string[]> {
		const res = await this.http.get(`${handler}?term=${encodeURIComponent(term)}`);
		let json: unknown;
		try {
			json = JSON.parse(res.text());
		} catch {
			throw new UnexpectedPageError(`${handler} did not answer JSON`);
		}
		const list = (json as { suggestions?: unknown }).suggestions;
		if (!Array.isArray(list)) throw new UnexpectedPageError(`${handler} has no suggestions list`);
		// The first suggestion is the "< Create ... >" shortcut of the web application.
		return list.filter((s): s is string => typeof s === 'string' && !s.startsWith('<'));
	}

	private async asyncPostback(
		page: Page,
		updatePanel: string,
		target: { eventTarget?: string; button?: string },
		opts: { login?: boolean } = {}
	): Promise<Delta> {
		const scriptManager = page.form.scriptManagerId();
		const control = target.eventTarget ?? target.button ?? '';
		const fields = this.withEventTarget(page.form.fields(), target.eventTarget ?? '');
		if (target.button) fields.push([target.button, '']);
		fields.unshift([scriptManager, `${updatePanel}|${control}`]);
		fields.push(['__ASYNCPOST', 'true']);
		const res = await this.http.post(page.path, fields, {
			'x-microsoftajax': 'Delta=true',
			'x-requested-with': 'XMLHttpRequest'
		});
		const body = res.text();
		if (!isDelta(body)) throw new UnexpectedPageError(`${control} did not answer a partial update`);
		const delta = parseDelta(body);
		if (delta.errors.length) throw new It4BillingError(`IT4Billing failed on ${control}`);
		if (delta.redirect && isLoginUrl(this.http.url(delta.redirect)) && !opts.login) {
			throw new SessionExpiredError(`IT4Billing sent ${control} back to the login page`);
		}
		page.form.applyDelta(delta);
		return delta;
	}

	private withEventTarget(fields: [string, string][], eventTarget: string): [string, string][] {
		const out = fields.map(([k, v]): [string, string] =>
			k === '__EVENTTARGET' ? [k, eventTarget] : k === '__EVENTARGUMENT' ? [k, ''] : [k, v]
		);
		if (!out.some(([k]) => k === '__EVENTTARGET')) {
			out.unshift(['__EVENTTARGET', eventTarget], ['__EVENTARGUMENT', '']);
		}
		return out;
	}

	/** Sets a text field, refusing values longer than the field accepts. */
	private fill(f: WebForm, name: string, value: string) {
		const max = Number(f.root.querySelector(`[name="${name}"]`)?.getAttribute('maxlength'));
		if (max > 0 && value.length > max) {
			throw new It4BillingError(`${name.split('$').pop()} accepts at most ${max} characters`);
		}
		f.set(name, value);
	}

	private requireName(f: WebForm, suffix: string): string {
		const name = f.findName(suffix);
		if (!name) throw new UnexpectedPageError(`The page has no field ending in ${suffix}`);
		return name;
	}

	private assertNoValidationMessage(f: WebForm) {
		const message = f.validationMessage();
		if (message) throw new ValidationMessageError(message);
	}

	private assertWritable(action: string) {
		if (this.options.readOnly)
			throw new ReadOnlyViolationError(`Read-only client: cannot ${action}`);
	}
}

/** English country name, as listed in the IT4Billing country selectors. */
export function countryName(code: string): string {
	const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase());
	if (!name || name === code.toUpperCase()) throw new It4BillingError(`Unknown country ${code}`);
	return name;
}
