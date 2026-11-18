import { ManualPaymentProvider } from "./manual.ts";
import { MpesaPaymentProvider } from "./mpesa.ts";
import { FakePaymentProvider } from "./fake.ts";
import { ErpErrorLike } from "./errors.ts";
import type { PaymentProvider } from "./types.ts";

export {
  ManualPaymentProvider,
  MpesaPaymentProvider,
  FakePaymentProvider,
  ErpErrorLike,
};
export type * from "./types.ts";

export interface PaymentRegistryConfig {
  mode: "manual" | "disabled" | "mpesa" | "fake";
  captureEnabled: boolean;
  mpesa: {
    mode: "disabled" | "sandbox" | "live";
    baseUrl: string;
    consumerKey: string;
    consumerSecret: string;
    shortcode: string;
    passkey: string;
    callbackSecret: string;
    callbackBaseUrl: string;
  };
}

/** Resolve the active provider. `disabled` throws instead of silently degrading. */
export function createPaymentProvider(
  config: PaymentRegistryConfig,
): PaymentProvider {
  switch (config.mode) {
    case "manual":
      return new ManualPaymentProvider();
    case "mpesa": {
      if (!config.captureEnabled) {
        throw new ErpErrorLike(
          "PAYMENTS_DISABLED",
          "PAYMENT_CAPTURE_ENABLED must be true before M-Pesa capture is used",
        );
      }
      if (config.mpesa.mode === "disabled") {
        throw new ErpErrorLike("PAYMENTS_DISABLED", "MPESA_MODE is disabled");
      }
      return new MpesaPaymentProvider({
        mode: config.mpesa.mode,
        baseUrl: config.mpesa.baseUrl,
        consumerKey: config.mpesa.consumerKey,
        consumerSecret: config.mpesa.consumerSecret,
        shortcode: config.mpesa.shortcode,
        passkey: config.mpesa.passkey,
        callbackSecret: config.mpesa.callbackSecret,
        callbackBaseUrl: config.mpesa.callbackBaseUrl,
      });
    }
    case "fake":
      if (process.env.NODE_ENV === "production") {
        throw new ErpErrorLike(
          "PAYMENTS_DISABLED",
          "The fake provider cannot run in production",
        );
      }
      return new FakePaymentProvider();
    case "disabled":
    default:
      throw new ErpErrorLike(
        "PAYMENTS_DISABLED",
        "Payment processing is disabled",
      );
  }
}
