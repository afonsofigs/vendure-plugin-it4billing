/**
 * A local fake of the IT4Billing web application, for tests. The HTML is synthetic and minimal: it
 * only reproduces the field names and the postback behaviour the client relies on. It is strict on
 * purpose (stale view state, wrong ScriptManager panel, unknown articles) so client mistakes show up
 * as failures, as they would against the real application.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_ACCOUNT = '000000000';

const PANEL = 'ctl00$Content$UpdatePanel1';
const SM = 'ctl00$ScriptManager';
const ROW = (i: number) => `ctl00$Content$GridView1$ctl${String(i).padStart(2, '0')}$`;
const TAX_RATES: Record<string, number> = { '1': 23, '2': 6, '3': 13, '4': 0 };
const TAX_OPTIONS: [string, string][] = [
	['4', '0,00'],
	['2', '6,00'],
	['3', '13,00'],
	['1', '23,00']
];
const DOC_TYPES: [string, string][] = [
	['0', ''],
	['1', 'Fatura'],
	['2', 'Fatura-Recibo'],
	['4', 'Nota de Crédito']
];
const PAYMENTS = ['Card', 'Cash', 'Transfer'];
const COUNTRIES: [string, string][] = [
	['182', 'Portugal'],
	['70', 'Spain']
];
export const FAKE_PDF = Buffer.from('%PDF-1.4\n% fake document\n%%EOF\n', 'latin1');

export interface FakeClient {
	id: string;
	name: string;
	fiscalName: string;
	nif: string;
	address: string;
	postalCode: string;
	city: string;
	country: string;
}

export interface FakeArticle {
	reference: string;
	name: string;
	productType: string;
	unit: string;
	taxId: string;
	/** Price excluding VAT, in thousandths of a euro. */
	priceMilli: number;
}

interface FakeLine {
	reference: string;
	description: string;
	unit: string;
	quantity: number;
	priceMilli: number;
	discount: number;
	taxId: string;
}

interface Draft {
	type: string;
	payment: string;
	comments: string;
	referralDate: string;
	clientId?: string;
	lines: FakeLine[];
	footer: Record<string, string>;
	message?: string;
}

export interface FakeDocument {
	number: string;
	type: string;
	clientId: string;
	lines: FakeLine[];
	payment: string;
	comments: string;
	referralDate: string;
	total: number;
}

interface Session {
	loggedIn: boolean;
	viewState: string;
	createMode?: 'client' | 'article';
	articleDraft?: { taxId: string; rows: { taxId: string; priceMilli: number }[]; message?: string };
	draft?: Draft;
	viewing?: FakeDocument;
	pdfName?: string;
}

export interface Failure {
	/** Matches the posted control (event target or button) or the request path. */
	match: string;
	status?: number;
	/** Close the connection without an answer, like a lost response. */
	drop?: boolean;
}

export class FakeIt4Billing {
	readonly clients: FakeClient[] = [];
	readonly articles: FakeArticle[] = [];
	readonly documents: FakeDocument[] = [];
	readonly requests: { method: string; path: string; control?: string }[] = [];
	saves = 0;
	prints = 0;
	logins = 0;
	lastUserAgent?: string;
	username = 'integration-user';
	password = 'not-a-real-password';
	private sessions = new Map<string, Session>();
	private failures: Failure[] = [];
	private server?: Server;
	private seq = 0;

	get baseUrl(): string {
		const { port } = this.server!.address() as AddressInfo;
		return `http://127.0.0.1:${port}`;
	}

	get accountUrl(): string {
		return `${this.baseUrl}/${FAKE_ACCOUNT}/`;
	}

	async start(): Promise<void> {
		this.server = createServer((req, res) => {
			this.handle(req, res).catch((e) => {
				res.statusCode = 500;
				res.end(`fake error: ${String(e)}`);
			});
		});
		await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
	}

	async stop(): Promise<void> {
		await new Promise<void>((r) => this.server?.close(() => r()));
	}

	failOnce(failure: Failure) {
		this.failures.push(failure);
	}

	expireSessions() {
		for (const s of this.sessions.values()) s.loggedIn = false;
	}

	// ---- Routing -----------------------------------------------------------------------------

	private async handle(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? '/', this.baseUrl);
		const prefix = `/${FAKE_ACCOUNT}/`;
		if (!url.pathname.startsWith(prefix)) return this.send(res, 404, 'not found');
		const path = url.pathname.slice(prefix.length);
		const body = req.method === 'POST' ? new URLSearchParams(await readBody(req)) : undefined;
		const control = body ? controlOf(body) : undefined;
		this.requests.push({ method: req.method ?? 'GET', path, control });

		const failure = this.failures.find((f) => f.match === control || f.match === path);
		if (failure) {
			this.failures.splice(this.failures.indexOf(failure), 1);
			if (failure.drop) return req.socket.destroy();
			return this.send(res, failure.status ?? 500, 'injected failure');
		}

		this.lastUserAgent = req.headers['user-agent'];
		const session = this.session(req, res);
		if (path === 'Login') return this.login(session, res, body);
		if (/\/Login$/.test(path)) {
			// Relative redirects from sub-folders end up outside the account, as in the real app.
			return this.redirect(res, 'http://public.invalid/account-not-found/');
		}
		if (!session.loggedIn) return this.redirect(res, 'Login');

		if (body && body.get('__VIEWSTATE') !== session.viewState) {
			return this.send(res, 500, 'invalid view state');
		}
		if (body?.get('__EVENTTARGET') === 'ctl00$Logout') {
			session.loggedIn = false;
			return this.redirect(res, `/${FAKE_ACCOUNT}/Login`);
		}
		if (body?.get('__ASYNCPOST') === 'true' && !this.validAsync(body, control)) {
			return this.send(res, 500, 'invalid script manager value');
		}

		if (path === 'Search_Clients.ashx') return this.searchClients(res, url);
		if (path === 'Search_Product.ashx') return this.searchProducts(res, url);
		if (path === 'PdfPreview.ashx') return this.pdf(session, res, url);
		if (path === 'EntityDocuments' || path === 'Clients/List' || path === 'Articles/List') {
			return this.list(session, res, path, body, control);
		}
		if (path === 'Client') return this.clientForm(session, res, body, control);
		if (path === 'Article') return this.articleForm(session, res, body, control);
		if (path === 'Documents') return this.documentForm(session, res, body, control);
		return this.send(res, 404, 'not found');
	}

	/** Buttons inside the panel use the panel; registered async triggers use the ScriptManager. */
	private validAsync(body: URLSearchParams, control?: string): boolean {
		const value = body.get(SM) ?? '';
		const [panel, target] = value.split('|');
		if (target !== control) return false;
		const trigger = /lnkInsertFooter$|SaveClient$|SaveArticle$|PrintDocument$/.test(control ?? '');
		return panel === (trigger ? SM : PANEL);
	}

	// ---- Login -------------------------------------------------------------------------------

	private login(session: Session, res: ServerResponse, body?: URLSearchParams) {
		if (!body) return this.page(res, session, 'Login', loginPanel(), 'ScriptMgr', 'upnl');
		if (body.get('ScriptMgr') !== 'upnl|B_ok' || body.get('__ASYNCPOST') !== 'true') {
			return this.send(res, 500, 'invalid login postback');
		}
		this.logins++;
		if (body.get('T_username') === this.username && body.get('T_password') === this.password) {
			session.loggedIn = true;
			return this.delta(res, [
				['pageRedirect', '', `/${FAKE_ACCOUNT}/EntityDocuments?Entity=Client`]
			]);
		}
		session.viewState = token();
		return this.delta(res, [
			['updatePanel', 'upnl', loginPanel('Utilizador ou palavra passe inválidos')],
			['hiddenField', '__VIEWSTATE', session.viewState]
		]);
	}

	// ---- Searches ------------------------------------------------------------------------------

	private searchClients(res: ServerResponse, url: URL) {
		const term = (url.searchParams.get('term') ?? '').toLowerCase();
		const found = this.clients
			.filter((c) => c.nif.includes(term) || c.name.toLowerCase().includes(term))
			.map((c) => `${c.id} | ${c.name} | ${c.fiscalName} | ${c.nif}`);
		return this.json(res, { suggestions: ['< Criar Cliente >', ...found] });
	}

	private searchProducts(res: ServerResponse, url: URL) {
		const term = (url.searchParams.get('term') ?? '').toLowerCase();
		const found = this.articles
			.filter(
				(a) => a.reference.toLowerCase().includes(term) || a.name.toLowerCase().includes(term)
			)
			.map((a) => `${a.reference} | ${a.name}`);
		return this.json(res, { suggestions: ['< Criar Artigo >', ...found] });
	}

	// ---- Lists and create forms ----------------------------------------------------------------

	private list(
		session: Session,
		res: ServerResponse,
		path: string,
		body?: URLSearchParams,
		control?: string
	) {
		if (body && control === 'ctl00$Content$bcreate') {
			session.createMode = path === 'Clients/List' ? 'client' : 'article';
			session.articleDraft = { taxId: '1', rows: [] };
			const target = path === 'Clients/List' ? 'Client' : 'Article';
			return this.delta(res, [['pageRedirect', '', `/${FAKE_ACCOUNT}/${target}`]]);
		}
		const panel = `<a id="Content_bcreate" href="javascript:__doPostBack('ctl00$Content$bcreate','')">Criar</a>`;
		return this.page(res, session, path, panel);
	}

	private clientForm(
		session: Session,
		res: ServerResponse,
		body?: URLSearchParams,
		control?: string
	) {
		if (session.createMode !== 'client') return this.send(res, 500, 'no create mode');
		if (!body) return this.page(res, session, 'Client', clientPanel());
		if (control !== 'ctl00$Content$SaveClient') return this.send(res, 500, 'unknown control');
		const v = (n: string) => (body.get(`ctl00$Content$${n}`) ?? '').trim();
		const required = ['Fiscalnumber', 'Fiscalname', 'Name', 'Address', 'Postalcode', 'City'];
		if (required.some((n) => !v(n))) {
			return this.panel(res, session, clientPanel('Preencha os campos obrigatórios.'));
		}
		const country = COUNTRIES.find(([id]) => id === v('Ddlcountries'))?.[1] ?? '';
		this.clients.push({
			id: String(this.clients.length + 100),
			nif: v('Fiscalnumber'),
			fiscalName: v('Fiscalname'),
			name: v('Name'),
			address: v('Address'),
			postalCode: v('Postalcode'),
			city: v('City'),
			country
		});
		session.createMode = undefined;
		return this.delta(res, [['pageRedirect', '', `/${FAKE_ACCOUNT}/Clients/List`]]);
	}

	private articleForm(
		session: Session,
		res: ServerResponse,
		body?: URLSearchParams,
		control?: string
	) {
		const draft = session.articleDraft;
		if (session.createMode !== 'article' || !draft) return this.send(res, 500, 'no create mode');
		const fields = (b?: URLSearchParams) => ({
			reference: b?.get('ctl00$Content$Internalcode') ?? String(this.articles.length + 1),
			name: b?.get('ctl00$Content$Name') ?? '',
			productType: b?.get('ctl00$Content$ProductType') ?? '1',
			unit: b?.get('ctl00$Content$DdlMeasures') ?? '1'
		});
		if (!body) return this.page(res, session, 'Article', articlePanel(fields(), draft));
		const row = ROW(3 + draft.rows.length);
		draft.message = undefined;
		if (control === 'ctl00$Content$GridViewTaxRowFooterBtn') {
			draft.taxId = body.get(`${row}DdlTaxTypesNew`) ?? draft.taxId;
		} else if (control === `${row}lnkInsertFooter`) {
			const price = parseMilli(body.get(`${row}PriceNew`) ?? '');
			if (price === undefined) draft.message = 'Preço inválido.';
			else
				draft.rows.push({
					taxId: body.get(`${row}DdlTaxTypesNew`) ?? draft.taxId,
					priceMilli: price
				});
		} else if (control === 'ctl00$Content$SaveArticle') {
			const f = fields(body);
			if (!f.name || !draft.rows.length) draft.message = 'Preencha os campos obrigatórios.';
			else {
				this.articles.push({
					reference: f.reference,
					name: f.name,
					productType: f.productType,
					unit: f.unit === '1' ? 'Un' : f.unit === '2' ? 'Kg' : 'Lt',
					taxId: draft.rows[0].taxId,
					priceMilli: draft.rows[0].priceMilli
				});
				session.createMode = undefined;
				return this.delta(res, [['pageRedirect', '', `/${FAKE_ACCOUNT}/Articles/List`]]);
			}
		} else return this.send(res, 500, 'unknown control');
		return this.panel(res, session, articlePanel(fields(body), draft));
	}

	// ---- Documents -----------------------------------------------------------------------------

	private documentForm(
		session: Session,
		res: ServerResponse,
		body?: URLSearchParams,
		control?: string
	) {
		if (!body) {
			session.viewing = undefined;
			session.draft = {
				type: '1',
				payment: '',
				comments: '',
				referralDate: today(),
				lines: [],
				footer: {}
			};
			return this.page(res, session, 'Documents?Entity=Client', this.documentPanel(session.draft));
		}
		if (session.viewing) return this.viewPostback(session, res, control);
		const d = session.draft;
		if (!d) return this.send(res, 500, 'no document');
		const row = ROW(3 + d.lines.length);
		const get = (n: string) => body.get(`ctl00$Content$${n}`) ?? '';
		d.message = undefined;
		d.type = get('DocumentSerie') || d.type;
		d.payment = get('tpaymentmethod');
		d.comments = get('Comments');
		d.referralDate = get('ReferralDate') || d.referralDate;
		for (const k of [
			'ArticleNew',
			'DescriptionNew',
			'UnitNew',
			'QuantityNew',
			'PriceNew',
			'DiscountNew',
			'TaxNew'
		]) {
			d.footer[k] = body.get(`${row}${k}`) ?? '';
		}

		if (control === 'ctl00$Content$SaveDocumentBtn') return this.save(session, res, d);
		if (control === 'ctl00$Content$DocumentSeriesChangeBtn') {
			if (d.type === '2' && !d.payment) d.payment = PAYMENTS[0];
		} else if (control === 'ctl00$Content$DocumentEntityBtn') {
			const id = get('Entity').split(' | ')[0];
			const client = this.clients.find((c) => c.id === id);
			d.clientId = client?.id;
		} else if (control === 'ctl00$Content$DocumentNewArticleDataBtn') {
			const reference = d.footer.ArticleNew.split(' | ')[0];
			const a = this.articles.find((x) => x.reference === reference);
			d.footer = a
				? {
						ArticleNew: a.reference,
						DescriptionNew: a.name,
						UnitNew: a.unit,
						QuantityNew: '1,00',
						PriceNew: `${formatMilli(a.priceMilli)} €`,
						DiscountNew: '0,00',
						TaxNew: a.taxId
					}
				: {};
		} else if (control === 'ctl00$Content$GridViewTotalRowFooterBtn') {
			// Values were already taken from the post; the panel re-renders with the line total.
		} else if (control === `${row}lnkInsertFooter`) {
			const a = this.articles.find((x) => x.reference === d.footer.ArticleNew);
			if (!a) d.message = 'O Artigo não Existe.';
			else {
				d.lines.push({
					reference: a.reference,
					description: d.footer.DescriptionNew || a.name,
					unit: d.footer.UnitNew || a.unit,
					quantity: parseDecimal(d.footer.QuantityNew) ?? 1,
					priceMilli: parseMilli(d.footer.PriceNew) ?? a.priceMilli,
					discount: parseDecimal(d.footer.DiscountNew) ?? 0,
					taxId: d.footer.TaxNew || a.taxId
				});
				d.footer = {};
			}
		} else if (control === 'ctl00$Content$VerifyDateBtn') {
			if (!/^\d{2}-\d{2}-\d{4}$/.test(d.referralDate)) d.message = 'Data inválida.';
		} else return this.send(res, 500, 'unknown control');
		return this.panel(res, session, this.documentPanel(d));
	}

	private save(session: Session, res: ServerResponse, d: Draft) {
		if (!d.clientId || !d.lines.length || (d.type === '2' && !d.payment)) {
			d.message = 'Documento incompleto.';
			return this.page(res, session, 'Documents?Entity=Client', this.documentPanel(d));
		}
		this.saves++;
		const prefix = d.type === '2' ? 'FR' : 'FT';
		const doc: FakeDocument = {
			number: `${prefix} ${prefix}/${++this.seq}`,
			type: d.type,
			clientId: d.clientId,
			lines: d.lines,
			payment: d.payment,
			comments: d.comments,
			referralDate: d.referralDate,
			total: totals(d.lines).total
		};
		this.documents.push(doc);
		session.draft = undefined;
		session.viewing = doc;
		return this.page(res, session, 'Documents?Entity=Client', this.documentPanel(d, doc));
	}

	private viewPostback(session: Session, res: ServerResponse, control?: string) {
		if (control !== 'ctl00$Content$PrintDocument') return this.send(res, 500, 'unknown control');
		this.prints++;
		session.pdfName = `DB${FAKE_ACCOUNT}_${session.viewing!.number.replace(/[ /]/g, '-')}.Pdf`;
		return this.delta(res, [
			['updatePanel', 'Content_UpdatePanel1', 'printed'],
			['scriptStartupBlock', 'ScriptContentNoTags', `PrintPreviewDocument('${session.pdfName}');`]
		]);
	}

	private pdf(session: Session, res: ServerResponse, url: URL) {
		if (!session.pdfName || url.searchParams.get('Document') !== session.pdfName) {
			return this.send(res, 404, 'no such file');
		}
		res.setHeader('content-type', 'application/force-download');
		res.setHeader('content-disposition', `inline; filename=${session.pdfName}`);
		res.end(FAKE_PDF);
	}

	private documentPanel(d: Draft, saved?: FakeDocument): string {
		const client = this.clients.find((c) => c.id === d.clientId);
		const disabled = saved ? ' disabled="disabled"' : '';
		const payments = d.type === '2' ? PAYMENTS : ['', ...PAYMENTS];
		const t = totals(d.lines);
		const row = ROW(3 + d.lines.length);
		const lines = d.lines
			.map((l, i) => {
				const r = ROW(3 + i);
				return `<tr>${input(`${r}Article`, l.reference, ' disabled="disabled"')}${input(`${r}Description`, l.description, ' disabled="disabled"')}<input name="${r}Total" id="Total" value="${formatMilli(lineNetMilli(l))} €" disabled="disabled" /></tr>`;
			})
			.join('');
		const footer = saved
			? ''
			: `<tr>${input(`${row}ArticleNew`, d.footer.ArticleNew ?? '', ' maxlength="20"')}${input(`${row}DescriptionNew`, d.footer.DescriptionNew ?? '', ' maxlength="150"')}${input(`${row}UnitNew`, d.footer.UnitNew ?? '')}${input(`${row}QuantityNew`, d.footer.QuantityNew ?? '')}${input(`${row}PriceNew`, d.footer.PriceNew ?? '')}${input(`${row}DiscountNew`, d.footer.DiscountNew ?? '')}${select(`${row}TaxNew`, TAX_OPTIONS, d.footer.TaxNew ?? '4')}<a href="javascript:__doPostBack('${row}lnkInsertFooter','')">+</a></tr>`;
		const actions = saved
			? `<a id="PrintDocument" href="javascript:__doPostBack('ctl00$Content$PrintDocument','')">Imprimir</a>`
			: `<a id="SaveDocument" href="javascript:__doPostBack('ctl00$Content$SaveDocument','')">Gravar</a>
				<input type="submit" name="ctl00$Content$SaveDocumentBtn" value="" />
				<input type="submit" name="ctl00$Content$DocumentSeriesChangeBtn" value="" />
				<input type="submit" name="ctl00$Content$DocumentEntityBtn" value="" />
				<input type="submit" name="ctl00$Content$DocumentNewArticleDataBtn" value="" />
				<input type="submit" name="ctl00$Content$GridViewTotalRowFooterBtn" value="" />
				<input type="submit" name="ctl00$Content$VerifyDateBtn" value="" />`;
		return `${message(d.message)}${actions}
			<input name="ctl00$Content$DocumentNumber" readonly="readonly" id="DocumentNumber" value="${esc(saved?.number ?? '')}"${disabled} />
			${select('ctl00$Content$DocumentSerie', DOC_TYPES, d.type, disabled)}
			${input('ctl00$Content$DocumentDate', today(), disabled)}
			${input('ctl00$Content$ReferralDate', d.referralDate, disabled)}
			${input('ctl00$Content$DueDate', today(), d.type === '2' ? ' disabled="disabled"' : disabled)}
			${select(
				'ctl00$Content$tpaymentmethod',
				payments.map((p) => [p, p]),
				d.payment,
				disabled
			)}
			${input('ctl00$Content$Comments', d.comments, ` maxlength="50"${disabled}`)}
			${input('ctl00$Content$EntityId', client?.id ?? '', disabled)}
			${input('ctl00$Content$Nif', client?.nif ?? '', disabled)}
			${input('ctl00$Content$Entity', client?.name ?? '', ` maxlength="255"${disabled}`)}
			<table>${lines}${footer}</table>
			<span id="TotalGrossAmmount">${formatMilli(t.gross * 10)} €</span>
			<span id="TotalDiscount">${formatMilli(t.discount * 10)} €</span>
			<span id="TotalNetAmmount">${formatMilli(t.net * 10)} €</span>
			<span id="TotalRetention">0,00 €</span>
			<span id="TotalVat">${formatMilli(t.vat * 10)} €</span>
			<span id="Total">${formatMilli(t.total * 10)} €</span>`;
	}

	// ---- Responses -----------------------------------------------------------------------------

	private session(req: IncomingMessage, res: ServerResponse): Session {
		const id = /ASP\.NET_SessionId=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
		const existing = id && this.sessions.get(id);
		if (existing) return existing;
		const newId = token();
		const session: Session = { loggedIn: false, viewState: token() };
		this.sessions.set(newId, session);
		res.setHeader('set-cookie', `ASP.NET_SessionId=${newId}; path=/; HttpOnly; SameSite=Lax`);
		return session;
	}

	private page(
		res: ServerResponse,
		session: Session,
		path: string,
		panel: string,
		sm = SM,
		panelId = 'Content_UpdatePanel1'
	) {
		session.viewState = token();
		const action = `./${path}`;
		// ASP.NET serves a reduced page, without partial postbacks, to agents it does not recognise.
		const capable = (this.lastUserAgent ?? '').startsWith('Mozilla/5.0');
		this.send(
			res,
			200,
			`<!DOCTYPE html><html><body><form method="post" action="${esc(action)}" id="form2">
<input type="hidden" name="__EVENTTARGET" id="__EVENTTARGET" value="" />
<input type="hidden" name="__EVENTARGUMENT" id="__EVENTARGUMENT" value="" />
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="${session.viewState}" />
<input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="0000AAAA" />
<input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="${token()}" />
${capable ? `<script type="text/javascript">Sys.WebForms.PageRequestManager._initialize('${sm}', 'form2', ['t${panelId}','${panelId}'], [], [], 90, '');</script>` : ''}
<a href="javascript:WebForm_DoPostBackWithOptions(new WebForm_PostBackOptions(&quot;ctl00$Logout&quot;, &quot;&quot;, true, &quot;&quot;, &quot;&quot;, false, true))">Sair</a>
<div id="${panelId}">${panel}</div>
</form></body></html>`,
			'text/html; charset=utf-8'
		);
	}

	private panel(res: ServerResponse, session: Session, html: string) {
		session.viewState = token();
		return this.delta(res, [
			['updatePanel', 'Content_UpdatePanel1', html],
			['hiddenField', '__EVENTTARGET', ''],
			['hiddenField', '__VIEWSTATE', session.viewState],
			['hiddenField', '__EVENTVALIDATION', token()]
		]);
	}

	private delta(res: ServerResponse, records: [string, string, string][]) {
		const body = records
			.map(([type, id, content]) => {
				const value = type === 'pageRedirect' ? encodeURIComponent(content) : content;
				return `${value.length}|${type}|${id}|${value}|`;
			})
			.join('');
		this.send(res, 200, body, 'text/plain; charset=utf-8');
	}

	private json(res: ServerResponse, data: unknown) {
		this.send(res, 200, JSON.stringify(data), 'application/json; charset=utf-8');
	}

	private redirect(res: ServerResponse, location: string) {
		res.statusCode = 302;
		res.setHeader('location', location);
		res.end();
	}

	private send(res: ServerResponse, status: number, body: string, type = 'text/plain') {
		res.statusCode = status;
		res.setHeader('content-type', type);
		res.end(body);
	}
}

// ---- HTML helpers ------------------------------------------------------------------------------

function loginPanel(error?: string) {
	return `${message(error)}<input name="T_username" type="text" id="T_username" value="" />
<input name="T_password" type="password" id="T_password" value="" />
<a id="B_ok" href="javascript:__doPostBack('B_ok','')">Entrar</a>`;
}

function clientPanel(error?: string) {
	return `${message(error)}
${input('ctl00$Content$Fiscalnumber', '999999990', ' maxlength="25"')}
${select('ctl00$Content$Ddlcountries', COUNTRIES, '182')}
${input('ctl00$Content$Fiscalname', '', ' maxlength="150"')}
${input('ctl00$Content$Name', '', ' maxlength="150"')}
${input('ctl00$Content$Address', 'N/D', ' maxlength="54"')}
${input('ctl00$Content$Postalcode', '0000-000', ' maxlength="25"')}
${input('ctl00$Content$City', 'N/D', ' maxlength="75"')}
<input type="checkbox" name="ctl00$Content$Published" checked="checked" />
<input type="file" name="ctl00$Content$Photo$FileUploadEdit" />
<a href="javascript:__doPostBack('ctl00$Content$SaveClient','')">Gravar</a>`;
}

function articlePanel(
	f: { reference: string; name: string; productType: string; unit: string },
	draft: { taxId: string; rows: { taxId: string; priceMilli: number }[]; message?: string }
) {
	const rows = draft.rows
		.map((r, i) => {
			const row = ROW(3 + i);
			return `${select(`${row}DdlTaxTypes`, TAX_OPTIONS, r.taxId, ' disabled="disabled"')}${input(`${row}Price`, `${formatMilli(r.priceMilli)} €`, ' disabled="disabled"')}`;
		})
		.join('');
	const row = ROW(3 + draft.rows.length);
	return `${message(draft.message)}
${input('ctl00$Content$Internalcode', f.reference, ' maxlength="20"')}
${input('ctl00$Content$Name', f.name, ' maxlength="150"')}
${select(
	'ctl00$Content$ProductType',
	[
		['1', 'Produto'],
		['2', 'Serviço'],
		['3', 'Outro']
	],
	f.productType
)}
${select(
	'ctl00$Content$DdlMeasures',
	[
		['1', 'Un'],
		['2', 'Kg'],
		['3', 'Lt']
	],
	f.unit
)}
<input type="submit" name="ctl00$Content$GridViewTaxRowFooterBtn" value="" />
${rows}
${select(
	`${row}DdlTaxTypesNew`,
	[
		['1', 'Taxa Normal'],
		['2', 'Taxa Reduzida'],
		['3', 'Taxa Intermédia'],
		['4', 'Isenta']
	],
	draft.taxId
)}
${input(`${row}PriceNew`, '')}
<a href="javascript:__doPostBack('${row}lnkInsertFooter','')">+</a>
<a href="javascript:__doPostBack('ctl00$Content$SaveArticle','')">Gravar</a>`;
}

function message(text?: string) {
	return text
		? `<div id="Content_validations"><span id="Content_ValMsg">${esc(text)}</span></div>`
		: '';
}

function input(name: string, value: string, extra = '') {
	return `<input name="${name}" type="text" value="${esc(value)}"${extra} />`;
}

function select(name: string, options: [string, string][], selected: string, extra = '') {
	const opts = options
		.map(
			([v, t]) =>
				`<option value="${esc(v)}"${v === selected ? ' selected="selected"' : ''}>${esc(t)}</option>`
		)
		.join('');
	return `<select name="${name}"${extra}>${opts}</select>`;
}

function esc(s: string) {
	return s
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function token() {
	return randomBytes(12).toString('hex');
}

function today() {
	const d = new Date();
	return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

function controlOf(body: URLSearchParams): string | undefined {
	const target = body.get('__EVENTTARGET');
	if (target) return target;
	return [...body.keys()].find((k) => /Btn$/.test(k));
}

function parseMilli(text: string): number | undefined {
	const clean = text.replace(/[€\s]/g, '').replace(/\./g, '');
	if (!/^\d+(,\d{1,3})?$/.test(clean)) return undefined;
	const [int, dec = ''] = clean.split(',');
	return Number(int) * 1000 + Number(`${dec}000`.slice(0, 3));
}

function parseDecimal(text: string): number | undefined {
	const clean = text.replace(/[%\s]/g, '').replace(',', '.');
	return clean && !Number.isNaN(Number(clean)) ? Number(clean) : undefined;
}

function formatMilli(milli: number): string {
	const cents = Math.round(milli / 10);
	return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
}

function lineNetMilli(l: FakeLine) {
	return Math.round((l.quantity * l.priceMilli * (1 - l.discount / 100)) / 10) * 10;
}

/** Totals in cents: line totals rounded first, then VAT per rate on the rounded bases. */
function totals(lines: FakeLine[]) {
	let gross = 0;
	let net = 0;
	const byRate = new Map<string, number>();
	for (const l of lines) {
		const lineNet = lineNetMilli(l) / 10;
		gross += Math.round((l.quantity * l.priceMilli) / 10);
		net += lineNet;
		byRate.set(l.taxId, (byRate.get(l.taxId) ?? 0) + lineNet);
	}
	let vat = 0;
	for (const [taxId, base] of byRate) vat += Math.round((base * TAX_RATES[taxId]) / 100);
	return { gross, discount: gross - net, net, vat, total: net + vat };
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString('utf8');
}
