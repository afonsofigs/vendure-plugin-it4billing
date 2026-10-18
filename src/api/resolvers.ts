import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, ID, Order, Permission, RequestContext } from '@vendure/core';
import type { It4BillingInvoice } from '../entities/invoice.entity';
import { It4BillingService } from '../service/invoice.service';

@Resolver('Order')
export class ShopOrderInvoiceResolver {
	constructor(private readonly service: It4BillingService) {}

	@ResolveField()
	it4billingInvoice(@Ctx() ctx: RequestContext, @Parent() order: Order) {
		return this.service.customerView(ctx, order.id);
	}
}

@Resolver()
export class ShopInvoiceResolver {
	constructor(private readonly service: It4BillingService) {}

	@Mutation()
	@Allow(Permission.Owner)
	requestOrderInvoice(@Ctx() ctx: RequestContext, @Args() args: { orderCode: string }) {
		return this.service.requestForCustomer(ctx, args.orderCode);
	}
}

const record = (i: It4BillingInvoice) => ({ ...i, hasCustomerPdf: !!i.customerPdfKey });

@Resolver()
export class AdminInvoiceResolver {
	constructor(private readonly service: It4BillingService) {}

	@Query()
	@Allow(Permission.ReadOrder)
	async it4billingInvoices(@Ctx() ctx: RequestContext, @Args() args: { status?: string }) {
		return (await this.service.list(ctx, args.status)).map(record);
	}

	@Query()
	@Allow(Permission.ReadOrder)
	it4billingQueueStatus(@Ctx() ctx: RequestContext) {
		return this.service.queueState(ctx);
	}

	@Mutation()
	@Allow(Permission.UpdateOrder)
	async retryIt4billingInvoice(
		@Ctx() ctx: RequestContext,
		@Args() args: { id: ID; confirmNotIssued?: boolean }
	) {
		return record(await this.service.retry(ctx, args.id, args.confirmNotIssued ?? false));
	}

	@Mutation()
	@Allow(Permission.UpdateOrder)
	resumeIt4billingQueue(@Ctx() ctx: RequestContext) {
		return this.service.resume(ctx);
	}

	@Mutation()
	@Allow(Permission.UpdateOrder)
	async importIt4billingInvoice(
		@Ctx() ctx: RequestContext,
		@Args() args: { orderCode: string; documentNumber: string; pdfBase64: string }
	) {
		const pdf = Buffer.from(args.pdfBase64, 'base64');
		return record(await this.service.importIssued(ctx, args.orderCode, args.documentNumber, pdf));
	}
}
