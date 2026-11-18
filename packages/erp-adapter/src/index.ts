export { ErpAdapter, erpIdempotencyKey } from "./adapter.ts";
export type {
  ErpAdapterOptions,
  CreateCustomerInput,
  ErpSaleInput,
  SettlementInput,
  SalesOrderDocumentInput,
} from "./adapter.ts";
export { HttpErpTransport, totpCode } from "./http-transport.ts";
export type { HttpTransportOptions } from "./http-transport.ts";
export { ErpError, unsupported } from "./errors.ts";
export type { ErpErrorCode } from "./errors.ts";
export {
  ERP_CAPABILITIES,
  VERIFIED_CAPABILITIES,
  MISSING_CAPABILITIES,
  capability,
} from "./contract.ts";
export type { ErpCapability, CapabilitySupport } from "./contract.ts";
export type {
  ErpTransport,
  ErpRequest,
  ErpResponse,
  ErpProduct,
  ErpPage,
  ErpInventoryRow,
  ErpCustomer,
  ErpMetadata,
  ErpSaleSummary,
} from "./types.ts";
