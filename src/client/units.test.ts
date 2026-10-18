import { describe, expect, test } from 'vitest';
import { isDelta, parseDelta } from './delta';
import { WebForm } from './form';
import { formatCents, formatDate, formatDecimal, parseAmount } from './money';

describe('money', () => {
	test.each([
		['78,76 €', 7876],
		['1.234,56 €', 123456],
		['0,00', 0],
		['13,00%', 1300],
		['30,885 €', 3089],
		['30,884', 3088],
		['-15,75 €', -1575]
	])('parses %s', (text, cents) => {
		expect(parseAmount(text)).toBe(cents);
	});

	test('an empty amount is undefined, garbage throws', () => {
		expect(parseAmount(' € ')).toBeUndefined();
		expect(() => parseAmount('abc')).toThrow();
	});

	test('formats cents, decimals and dates the IT4Billing way', () => {
		expect(formatCents(7876)).toBe('78,76');
		expect(formatCents(5)).toBe('0,05');
		expect(() => formatCents(1.5)).toThrow();
		expect(formatDecimal(20)).toBe('20,00');
		expect(formatDecimal(1)).toBe('1,00');
		expect(formatDate(new Date(2026, 8, 11))).toBe('11-09-2026');
	});
});

describe('delta', () => {
	test('parses records, including content with pipes and accents', () => {
		const record = (type: string, id: string, c: string) => `${c.length}|${type}|${id}|${c}|`;
		const content = 'a|b é';
		const body =
			record('updatePanel', 'P1', content) +
			record('hiddenField', '__VIEWSTATE', 'xyz') +
			record('pageRedirect', '', encodeURIComponent('/acc/Client?x=1'));
		expect(isDelta(body)).toBe(true);
		const delta = parseDelta(body);
		expect(delta.updatePanels.get('P1')).toBe(content);
		expect(delta.hiddenFields.get('__VIEWSTATE')).toBe('xyz');
		expect(delta.redirect).toBe('/acc/Client?x=1');
	});

	test('rejects a truncated response', () => {
		expect(() => parseDelta('10|updatePanel|P1|short|')).toThrow(/Malformed/);
	});

	test('an HTML page is not a delta', () => {
		expect(isDelta('<!DOCTYPE html>')).toBe(false);
	});
});

describe('WebForm', () => {
	const html = `<html><body><form>
		<input type="hidden" name="__VIEWSTATE" value="v1" />
		<input name="A" value="Intermédia &amp; Co" />
		<input name="B" value="x" disabled="disabled" />
		<input type="checkbox" name="C" checked="checked" />
		<input type="checkbox" name="D" />
		<input type="submit" name="E" value="" />
		<input type="file" name="F" />
		<select name="S"><option value="1">Um</option><option value="2" selected="selected">Dois</option></select>
		<textarea name="T">texto</textarea>
		<div id="P"><input name="row$ctl03$ArticleNew" value="" /></div>
		<script>Sys.WebForms.PageRequestManager._initialize('ctl00$ScriptManager', 'form2', [], [], [], 90, '');</script>
	</form></body></html>`;

	test('submits what a browser would', () => {
		const f = new WebForm(html);
		expect(f.fields()).toEqual([
			['__VIEWSTATE', 'v1'],
			['A', 'Intermédia & Co'],
			['C', 'on'],
			['S', '2'],
			['T', 'texto'],
			['row$ctl03$ArticleNew', '']
		]);
	});

	test('sets values and selects by text', () => {
		const f = new WebForm(html);
		f.set('A', 'novo "valor"');
		expect(f.selectByText('S', 'Um')).toBe('1');
		expect(f.value('A')).toBe('novo "valor"');
		expect(f.value('S')).toBe('1');
		expect(() => f.selectByText('S', 'Três')).toThrow();
	});

	test('applies a delta to a panel and to hidden fields', () => {
		const f = new WebForm(html);
		f.applyDelta(
			parseDelta(
				`${'<input name="row$ctl04$ArticleNew" value="" />'.length}|updatePanel|P|<input name="row$ctl04$ArticleNew" value="" />|2|hiddenField|__VIEWSTATE|v2|`
			)
		);
		expect(f.findName('$ArticleNew')).toBe('row$ctl04$ArticleNew');
		expect(f.value('__VIEWSTATE')).toBe('v2');
	});

	test('reads the ScriptManager id', () => {
		expect(new WebForm(html).scriptManagerId()).toBe('ctl00$ScriptManager');
	});
});
