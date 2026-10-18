import { HTMLElement, parse } from 'node-html-parser';
import type { Delta } from './delta';
import { UnexpectedPageError } from './errors';

export interface SelectOption {
	value: string;
	text: string;
}

const cssName = (name: string) => `[name="${name.replace(/"/g, '\\"')}"]`;

/**
 * @description
 * A WebForms page held as a DOM, so it behaves like the page in a browser: fields keep the values
 * set on them, UpdatePanel deltas replace their panels, and `fields()` returns exactly what a
 * browser would submit.
 */
export class WebForm {
	readonly root: HTMLElement;

	constructor(html: string) {
		this.root = parse(html, { blockTextElements: { script: true, style: true, textarea: true } });
		if (!this.root.querySelector('form')) {
			throw new UnexpectedPageError('The page has no form');
		}
	}

	private element(name: string): HTMLElement | null {
		return this.root.querySelector(cssName(name));
	}

	private require(name: string): HTMLElement {
		const el = this.element(name);
		if (!el) throw new UnexpectedPageError(`The page has no field ${name}`);
		return el;
	}

	has(name: string): boolean {
		return !!this.element(name);
	}

	/** The name of the first field whose name ends with `suffix`, for positional grid fields. */
	findName(suffix: string): string | undefined {
		const el = this.root
			.querySelectorAll('input, select, textarea')
			.find((e) => (e.getAttribute('name') ?? '').endsWith(suffix));
		return el?.getAttribute('name');
	}

	isDisabled(name: string): boolean {
		return this.require(name).hasAttribute('disabled');
	}

	value(name: string): string {
		const el = this.require(name);
		const tag = el.tagName.toLowerCase();
		if (tag === 'select') return this.selected(el)?.value ?? '';
		if (tag === 'textarea') return el.textContent;
		return el.getAttribute('value') ?? '';
	}

	options(name: string): SelectOption[] {
		return this.require(name)
			.querySelectorAll('option')
			.map((o) => ({
				value: o.getAttribute('value') ?? o.textContent,
				text: o.textContent.trim()
			}));
	}

	set(name: string, value: string): void {
		const el = this.require(name);
		const tag = el.tagName.toLowerCase();
		if (tag === 'select') {
			const options = el.querySelectorAll('option');
			const target = options.find((o) => (o.getAttribute('value') ?? o.textContent) === value);
			if (!target) throw new UnexpectedPageError(`Field ${name} has no option ${value}`);
			options.forEach((o) => o.removeAttribute('selected'));
			target.setAttribute('selected', 'selected');
		} else if (tag === 'textarea') {
			el.set_content(value);
		} else {
			el.setAttribute('value', value);
		}
	}

	/** Selects the option whose visible text is `text`, and returns its value. */
	selectByText(name: string, text: string): string {
		const option = this.options(name).find((o) => o.text === text);
		if (!option) throw new UnexpectedPageError(`Field ${name} has no option "${text}"`);
		this.set(name, option.value);
		return option.value;
	}

	/**
	 * Text content of the element with this id, trimmed; `undefined` if it does not exist. IT4Billing
	 * uses static ids, so the same id can appear on several elements: pass `tag` to pick one.
	 */
	textById(id: string, tag = ''): string | undefined {
		return this.root.querySelector(`${tag}#${id}`)?.textContent.trim();
	}

	/** The ScriptManager id declared by the page, needed for partial postbacks. */
	scriptManagerId(): string {
		const match = this.root.toString().match(/PageRequestManager\._initialize\('([^']+)'/);
		if (!match) throw new UnexpectedPageError('The page has no ScriptManager');
		return match[1];
	}

	/** The validation message IT4Billing shows when it refuses an action, if any. */
	validationMessage(): string | undefined {
		const text = this.textById('Content_ValMsg');
		return text ? text : undefined;
	}

	/** Applies a partial postback response: replaces the updated panels and hidden fields. */
	applyDelta(delta: Delta): void {
		for (const [id, html] of delta.updatePanels) {
			const panel = this.root.querySelector(`#${id}`);
			if (!panel) throw new UnexpectedPageError(`The page has no update panel ${id}`);
			panel.set_content(html);
		}
		for (const [name, value] of delta.hiddenFields) {
			const el = this.element(name);
			if (el) el.setAttribute('value', value);
			else this.root.querySelector('form')?.appendChild(hiddenInput(name, value));
		}
	}

	/** The fields a browser would submit, in document order, without any submit button. */
	fields(): [string, string][] {
		const out: [string, string][] = [];
		for (const el of this.root.querySelectorAll('form input, form select, form textarea')) {
			const name = el.getAttribute('name');
			if (!name || el.hasAttribute('disabled')) continue;
			const tag = el.tagName.toLowerCase();
			const type = (el.getAttribute('type') ?? 'text').toLowerCase();
			if (tag === 'input') {
				if (['submit', 'button', 'image', 'reset', 'file'].includes(type)) continue;
				if (type === 'checkbox' || type === 'radio') {
					if (el.hasAttribute('checked')) out.push([name, el.getAttribute('value') ?? 'on']);
					continue;
				}
				out.push([name, el.getAttribute('value') ?? '']);
			} else if (tag === 'select') {
				out.push([name, this.selected(el)?.value ?? '']);
			} else {
				out.push([name, el.textContent]);
			}
		}
		return out;
	}

	private selected(select: HTMLElement): SelectOption | undefined {
		const options = select.querySelectorAll('option');
		const chosen = options.find((o) => o.hasAttribute('selected')) ?? options[0];
		return chosen
			? {
					value: chosen.getAttribute('value') ?? chosen.textContent,
					text: chosen.textContent.trim()
				}
			: undefined;
	}
}

function hiddenInput(name: string, value: string): HTMLElement {
	const escaped = value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
	return parse(`<input type="hidden" name="${name}" id="${name}" value="${escaped}" />`)
		.firstChild as HTMLElement;
}
