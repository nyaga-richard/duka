/** Errors surfaced by the ERP adapter. Codes map to API error responses. */
export type ErpErrorCode =
  | "ERP_UNAVAILABLE"
  | "ERP_AUTH_FAILED"
  | "ERP_FORBIDDEN"
  | "ERP_NOT_FOUND"
  | "ERP_CONFLICT"
  | "ERP_VALIDATION"
  | "ERP_RATE_LIMITED"
  | "ERP_CONTRACT_UNSUPPORTED"
  | "ERP_TIMEOUT"
  | "ERP_PROTOCOL";

export class ErpError extends Error {
  constructor(
    public readonly code: ErpErrorCode,
    message: string,
    public readonly status?: number,
    public readonly erpCode?: string,
    public readonly retryable = false,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ErpError";
  }
}

export function unsupported(
  capability: string,
  endpoint: string,
  contract: string,
): ErpError {
  return new ErpError(
    "ERP_CONTRACT_UNSUPPORTED",
    `The ERP does not expose ${capability} (${endpoint}). Requested contract: ${contract}. ` +
      "See docs/ERP_INTEGRATION_CONTRACT.md. No request was sent and no local state was changed.",
    undefined,
    "UNSUPPORTED_CAPABILITY",
    false,
    { capability, endpoint, contract },
  );
}
