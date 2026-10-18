/**
 * Parser for the "delta" responses of ASP.NET AJAX partial postbacks (UpdatePanel). The body is a
 * sequence of `length|type|id|content|` records.
 */

export interface DeltaRecord {
	type: string;
	id: string;
	content: string;
}

export interface Delta {
	records: DeltaRecord[];
	updatePanels: Map<string, string>;
	hiddenFields: Map<string, string>;
	/** Decoded target of a `pageRedirect` record, if any. */
	redirect?: string;
	/** Content of `error` records. */
	errors: string[];
	/** Content of `scriptStartupBlock` and `scriptBlock` records. */
	scripts: string[];
}

export function isDelta(body: string): boolean {
	return /^\d+\|[^|]*\|[^|]*\|/.test(body);
}

export function parseDelta(body: string): Delta {
	const records: DeltaRecord[] = [];
	let pos = 0;
	while (pos < body.length) {
		const lengthEnd = body.indexOf('|', pos);
		const typeEnd = body.indexOf('|', lengthEnd + 1);
		const idEnd = body.indexOf('|', typeEnd + 1);
		if (lengthEnd < 0 || typeEnd < 0 || idEnd < 0) {
			throw new Error(`Malformed delta response at position ${pos}`);
		}
		const length = Number(body.slice(pos, lengthEnd));
		if (!Number.isInteger(length) || length < 0) {
			throw new Error(`Malformed delta length at position ${pos}`);
		}
		const content = body.slice(idEnd + 1, idEnd + 1 + length);
		if (body[idEnd + 1 + length] !== '|') {
			throw new Error(`Malformed delta record end at position ${idEnd + 1 + length}`);
		}
		records.push({
			type: body.slice(lengthEnd + 1, typeEnd),
			id: body.slice(typeEnd + 1, idEnd),
			content
		});
		pos = idEnd + 1 + length + 1;
	}

	const delta: Delta = {
		records,
		updatePanels: new Map(),
		hiddenFields: new Map(),
		errors: [],
		scripts: []
	};
	for (const r of records) {
		if (r.type === 'updatePanel') delta.updatePanels.set(r.id, r.content);
		else if (r.type === 'hiddenField') delta.hiddenFields.set(r.id, r.content);
		else if (r.type === 'pageRedirect') delta.redirect = safeDecode(r.content);
		else if (r.type === 'error') delta.errors.push(r.content);
		else if (r.type === 'scriptStartupBlock' || r.type === 'scriptBlock')
			delta.scripts.push(r.content);
	}
	return delta;
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
