/** Central error type and stable machine-readable codes. */
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "INVALID_CREDENTIALS"
  | "EMAIL_TAKEN"
  | "FORBIDDEN"
  | "CSRF_INVALID"
  | "ORIGIN_DENIED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "IDEMPOTENCY_REQUIRED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "INSUFFICIENT_STOCK"
  | "EMPTY_CART"
  | "CART_RESERVATION_EXPIRED"
  | "INVALID_STATE_TRANSITION"
  | "PAYMENTS_DISABLED"
  | "PROVIDER_UNAVAILABLE"
  | "ERP_UNAVAILABLE"
  | "ERP_CONTRACT_UNSUPPORTED"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_JSON"
  | "DEPENDENCY_NOT_READY"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function fail(
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
): never {
  throw new AppError(status, code, message, details);
}

export function isRetryableDatabaseError(error: any): boolean {
  return ["40001", "40P01"].includes(error?.code);
}
