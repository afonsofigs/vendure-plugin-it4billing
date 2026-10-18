import gql from 'graphql-tag';

export const shopSchema = gql`
	enum It4BillingCustomerInvoiceStatus {
		"The order can be invoiced and has not been yet"
		NONE
		"The default billing address has no valid NIF"
		MISSING_NIF
		"The invoice is being issued, or is waiting for someone to check it"
		PREPARING
		ISSUED
		NOT_ELIGIBLE
	}

	type It4BillingCustomerInvoice {
		status: It4BillingCustomerInvoiceStatus!
		documentNumber: String
		issuedAt: DateTime
		"Relative path of the PDF download, for the order's customer"
		downloadPath: String
	}

	extend type Order {
		it4billingInvoice: It4BillingCustomerInvoice!
	}

	extend type Mutation {
		"Asks for the invoice of one of the active customer's orders. Safe to call more than once."
		requestOrderInvoice(orderCode: String!): It4BillingCustomerInvoice!
	}
`;

export const adminSchema = gql`
	type It4BillingInvoiceRecord {
		id: ID!
		createdAt: DateTime!
		updatedAt: DateTime!
		orderId: ID!
		orderCode: String!
		status: String!
		dryRun: Boolean!
		attempts: Int!
		nextAttemptAt: DateTime
		documentNumber: String
		total: Int
		issuedAt: DateTime
		hasCustomerPdf: Boolean!
		failureReason: String
		lastError: String
		dryRunReport: String
	}

	type It4BillingQueueStatus {
		paused: Boolean!
		pausedReason: String
		pausedAt: DateTime
	}

	extend type Query {
		it4billingInvoices(status: String): [It4BillingInvoiceRecord!]!
		it4billingQueueStatus: It4BillingQueueStatus!
	}

	extend type Mutation {
		"Queues a failed invoice or a dry run again. needs_review only with confirmNotIssued."
		retryIt4billingInvoice(id: ID!, confirmNotIssued: Boolean): It4BillingInvoiceRecord!
		"Resumes the queue after a refused login was fixed."
		resumeIt4billingQueue: It4BillingQueueStatus!
		"Records an invoice issued outside the plugin, with its PDF, so the order is never invoiced again."
		importIt4billingInvoice(
			orderCode: String!
			documentNumber: String!
			pdfBase64: String!
		): It4BillingInvoiceRecord!
	}
`;
