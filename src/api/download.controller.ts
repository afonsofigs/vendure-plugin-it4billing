import { Controller, Get, Param, Res } from '@nestjs/common';
import { Allow, Ctx, Permission, RequestContext } from '@vendure/core';
import { It4BillingService } from '../service/invoice.service';

interface PdfResponse {
	status(code: number): PdfResponse;
	setHeader(name: string, value: string): void;
	end(body?: Buffer | string): void;
}

/**
 * GET /it4billing/invoices/:orderCode/pdf: the stored PDF, only for the order's own customer.
 * It never asks IT4Billing for anything.
 */
@Controller('it4billing')
export class InvoiceDownloadController {
	constructor(private readonly service: It4BillingService) {}

	@Get('invoices/:orderCode/pdf')
	@Allow(Permission.Owner)
	async download(
		@Ctx() ctx: RequestContext,
		@Param('orderCode') orderCode: string,
		@Res() res: PdfResponse
	) {
		const pdf = await this.service.customerPdf(ctx, orderCode);
		if (!pdf) {
			res.status(404).end('Not found');
			return;
		}
		res.setHeader('content-type', 'application/pdf');
		res.setHeader('content-disposition', `attachment; filename="${pdf.fileName}"`);
		res.setHeader('cache-control', 'private, no-store');
		res.end(pdf.data);
	}
}
