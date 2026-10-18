import { PDFDocument } from 'pdf-lib';

/**
 * @description
 * IT4Billing prints the original and its copies (duplicate, triplicate) in one PDF, one per page.
 * This keeps only the first page, the original, for the customer.
 */
export async function originalPage(pdf: Buffer): Promise<Buffer> {
	const source = await PDFDocument.load(pdf);
	if (source.getPageCount() < 1) throw new Error('The PDF has no pages');
	const out = await PDFDocument.create();
	const [first] = await out.copyPages(source, [0]);
	out.addPage(first);
	return Buffer.from(await out.save());
}

export async function pageCount(pdf: Buffer): Promise<number> {
	return (await PDFDocument.load(pdf)).getPageCount();
}
