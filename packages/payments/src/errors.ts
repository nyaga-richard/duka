/** Small error type so the payment package has no dependency on the API's HTTP layer. */
export class ErpErrorLike extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }
}
