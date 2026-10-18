/**
 * Errors raised by the IT4Billing client. Messages never contain credentials or request bodies.
 */
export class It4BillingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/** The login was refused. It must never be retried automatically: the user could be locked out. */
export class LoginFailedError extends It4BillingError {}

/** IT4Billing sent the session back to the login page. */
export class SessionExpiredError extends It4BillingError {}

/** A page did not have the structure the client expects: IT4Billing may have changed. */
export class UnexpectedPageError extends It4BillingError {}

/** IT4Billing refused an action and showed a validation message, for example a missing article. */
export class ValidationMessageError extends It4BillingError {
	constructor(readonly serverMessage: string) {
		super(`IT4Billing refused the action: ${serverMessage}`);
	}
}

/** A network error, a timeout or an HTTP error status. */
export class TransportError extends It4BillingError {
	constructor(
		message: string,
		readonly status?: number
	) {
		super(message);
	}
}

/** A write was attempted on a client created with `readOnly: true`. */
export class ReadOnlyViolationError extends It4BillingError {}
