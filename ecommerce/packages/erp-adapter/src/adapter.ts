/**
 * Isolated ERP integration adapter.
 *
 * Only verified endpoints (see contract.ts) are callable. Every write carries a
 * deterministic idempotency key so a retry after a timeout cannot duplicate an
 * ERP document or payment. There is no ERP database access here, by design.
 */
import type {
  ErpAttachment,
  ErpBinary,
  ErpCustomer,
  ErpInventoryRow,
  ErpMetadata,
  ErpPage,
  ErpProduct,
  ErpSaleSummary,
  ErpTransport,
} from "./types.ts";
import { ErpError, unsupported } from "./errors.ts";
import { ERP_CAPABILITIES, type ErpCapability } from "./contract.ts";

export interface ErpAdapterOptions {
  defaultBranchId?: string;
  defaultWarehouseId?: string;
  /** Opt-in: also reserve stock inside the ERP via an approved sales_order. */
  reserveOrdersInErp?: boolean;
}

export interface CreateCustomerInput {
  name: string;
  code: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  taxPin?: string | null;
}

export interface SalesOrderDocumentInput {
  branchId: string;
  warehouseId?: string;
  customerId?: string;
  notes?: string;
  lines: Array<{ productId: string; quantity: number | string; unitPrice?: string }>;
}

export interface ErpSaleInput {
  registerId: string;
  customerId?: string;
  lines: Array<{ productId: string; quantity: number | string; unitPrice?: string }>;
  payments: Array<{ methodId: string; amount: string; reference?: string }>;
  notes?: string;
}

export interface SettlementInput {
  customerId: string;
  methodId: string;
  amount: string;
  reference?: string;
  allocations?: Array<{ saleId: string; amount: string }>;
}

export function erpIdempotencyKey(operation: string, localId: string | number): string {
  const safe = String(localId).replace(/[^A-Za-z0-9._:-]/g, "-");
  return `ecommerce:${operation}:${safe}`.slice(0, 150);
}

/**
 * The ERP's `endpoint()` wrapper accepts only owner-permitted fields; these
 * helpers convert adapter input to the exact wire shapes verified in the ERP.
 */
function orderLine(line: { productId: string; quantity: number | string }): Record<string, unknown> {
  return { product_id: line.productId, quantity: String(line.quantity) };
}

export class ErpAdapter {
  constructor(
    private readonly transport: ErpTransport,
    private readonly options: ErpAdapterOptions = {},
  ) {}

  capabilities(): ErpCapability[] {
    return ERP_CAPABILITIES;
  }

  /** Verified-but-optional probe: health, identity and granted permissions. */
  async probe() {
    const health = await this.transport.health();
    let identity: { id: string; email: string; permissions: string[] } | null = null;
    let error: string | null = null;
    try {
      const me = await this.transport.request<{ actor: { id: string; email: string; permissions?: string[] } }>({
        method: "GET",
        path: "/api/v1/auth/me",
      });
      identity = {
        id: me.data.actor.id,
        email: me.data.actor.email,
        permissions: me.data.actor.permissions ?? [],
      };
    } catch (caught) {
      error = caught instanceof ErpError ? `${caught.code}: ${caught.message}` : String(caught);
    }
    return { health, identity, error };
  }

  async metadata(): Promise<ErpMetadata> {
    const response = await this.transport.request<ErpMetadata>({ method: "GET", path: "/api/v1/metadata" });
    if (!response.data?.company?.id) {
      throw new ErpError("ERP_PROTOCOL", "ERP metadata response did not include a company");
    }
    return response.data;
  }

  async listProducts(input: {
    page?: number;
    limit?: number;
    q?: string;
    active?: "true" | "all";
    categoryId?: string;
    warehouseId?: string;
  } = {}): Promise<ErpPage<ErpProduct>> {
    const response = await this.transport.request<ErpPage<ErpProduct>>({
      method: "GET",
      path: "/api/v1/products",
      query: {
        page: Math.max(1, input.page ?? 1),
        limit: Math.min(100, Math.max(1, input.limit ?? 100)),
        q: input.q,
        active: input.active,
        category_id: input.categoryId,
        warehouse_id: input.warehouseId ?? this.options.defaultWarehouseId,
      },
    });
    const page = response.data;
    if (!page || !Array.isArray(page.items)) {
      throw new ErpError("ERP_PROTOCOL", "ERP products response was not paginated as documented");
    }
    for (const item of page.items) {
      if (!item.id || !item.sku) {
        throw new ErpError("ERP_PROTOCOL", "ERP product row missing id/sku; refusing to map it");
      }
    }
    return page;
  }

  /**
   * The image attachments the ERP holds for one product.
   *
   * `GET /api/v1/products/:id/attachments` is `catalog.read` and returns
   * metadata only; the bytes come from `downloadAttachment`.
   */
  async listProductAttachments(productId: string): Promise<ErpAttachment[]> {
    const response = await this.transport.request<{ items: ErpAttachment[] }>({
      method: "GET",
      path: `/api/v1/products/${encodeURIComponent(productId)}/attachments`,
    });
    const items = response.data?.items;
    if (!Array.isArray(items)) {
      throw new ErpError("ERP_PROTOCOL", "ERP product attachments response was not a list");
    }
    return items.filter((item) => typeof item?.id === "string");
  }

  /**
   * One attachment's bytes. A transport without binary support reports the
   * capability as unsupported rather than pretending an empty image is an image.
   */
  async downloadAttachment(attachmentId: string): Promise<ErpBinary> {
    if (typeof this.transport.download !== "function") {
      throw unsupported("binary attachment download", "GET /api/v1/attachments/:id", "G10");
    }
    const binary = await this.transport.download(`/api/v1/attachments/${encodeURIComponent(attachmentId)}`);
    if (!binary?.bytes?.length) {
      throw new ErpError("ERP_PROTOCOL", "ERP returned an empty attachment body");
    }
    return binary;
  }

  /** Walks the whole catalogue using only page/limit (no updated_since exists: gap G11). */
  async *iterateProducts(limit = 100): AsyncGenerator<ErpProduct> {
    let page = 1;
    for (;;) {
      const result = await this.listProducts({ page, limit });
      for (const item of result.items) yield item;
      if (page * result.limit >= result.total || result.items.length === 0) return;
      page += 1;
      if (page > 10_000) throw new ErpError("ERP_PROTOCOL", "ERP catalogue pagination did not terminate");
    }
  }

  async listInventory(input: { page?: number; limit?: number; q?: string; warehouseId?: string } = {}) {
    const response = await this.transport.request<ErpPage<ErpInventoryRow>>({
      method: "GET",
      path: "/api/v1/inventory/balances",
      query: {
        page: Math.max(1, input.page ?? 1),
        limit: Math.min(100, Math.max(1, input.limit ?? 100)),
        q: input.q,
        warehouse_id: input.warehouseId ?? this.options.defaultWarehouseId,
      },
    });
    if (!response.data || !Array.isArray(response.data.items)) {
      throw new ErpError("ERP_PROTOCOL", "ERP inventory response was not paginated as documented");
    }
    return response.data;
  }

  async *iterateInventory(limit = 100, warehouseId?: string): AsyncGenerator<ErpInventoryRow> {
    let page = 1;
    for (;;) {
      const result = await this.listInventory({ page, limit, warehouseId });
      for (const item of result.items) yield item;
      if (page * result.limit >= result.total || result.items.length === 0) return;
      page += 1;
      if (page > 10_000) throw new ErpError("ERP_PROTOCOL", "ERP inventory pagination did not terminate");
    }
  }

  async searchCustomers(query: string): Promise<ErpCustomer[]> {
    const response = await this.transport.request<ErpPage<ErpCustomer>>({
      method: "GET",
      path: "/api/v1/customers",
      query: { q: query, limit: 25 },
    });
    return response.data?.items ?? [];
  }

  async createCustomer(input: CreateCustomerInput, idempotencyKey?: string): Promise<ErpCustomer> {
    const response = await this.transport.request<ErpCustomer>({
      method: "POST",
      path: "/api/v1/customers",
      body: {
        name: input.name,
        code: input.code,
        email: input.email ?? "",
        phone: input.phone ?? "",
        address: input.address ?? "",
        tax_pin: input.taxPin ?? "",
        credit_limit: "0",
        credit_days: 0,
        discount_percent: "0",
        active: true,
      },
      idempotencyKey: idempotencyKey ?? erpIdempotencyKey("customer", input.code),
    });
    if (!response.data?.id) throw new ErpError("ERP_PROTOCOL", "ERP customer create returned no id");
    return response.data;
  }

  async updateCustomer(id: string, input: Partial<CreateCustomerInput>, idempotencyKey?: string): Promise<ErpCustomer> {
    const response = await this.transport.request<ErpCustomer>({
      method: "PUT",
      path: `/api/v1/customers/${id}`,
      body: {
        name: input.name,
        code: input.code,
        email: input.email ?? "",
        phone: input.phone ?? "",
        address: input.address ?? "",
        tax_pin: input.taxPin ?? "",
        credit_limit: "0",
        credit_days: 0,
        discount_percent: "0",
        active: true,
      },
      idempotencyKey: idempotencyKey ?? erpIdempotencyKey("customer-update", id),
    });
    return response.data;
  }

  /** Creates a sales_order document. Does not reserve stock until approved. */
  async createSalesOrderDocument(input: SalesOrderDocumentInput, idempotencyKey?: string) {
    const response = await this.transport.request<{ id: string; number: string; status: string }>({
      method: "POST",
      path: "/api/v1/documents",
      body: {
        kind: "sales_order",
        branch_id: input.branchId,
        warehouse_id: input.warehouseId ?? this.options.defaultWarehouseId,
        customer_id: input.customerId,
        notes: input.notes,
        lines: input.lines.map(orderLine),
      },
      idempotencyKey: idempotencyKey ?? erpIdempotencyKey("sales-order", input.customerId ?? "guest"),
    });
    if (!response.data?.id) throw new ErpError("ERP_PROTOCOL", "ERP document create returned no id");
    return response.data;
  }

  async transitionDocument(
    id: string,
    status: "approved" | "cancelled" | "submitted" | "rejected",
    reason: string,
    idempotencyKey?: string,
  ) {
    const response = await this.transport.request<{ id: string; status: string }>({
      method: "POST",
      path: `/api/v1/documents/${id}/transition`,
      body: { status, reason },
      idempotencyKey: idempotencyKey ?? erpIdempotencyKey(`document-${status}`, id),
    });
    return response.data;
  }

  async postSale(input: ErpSaleInput, idempotencyKey: string) {
    const response = await this.transport.request<{ id: string; number: string; total: string }>({
      method: "POST",
      path: "/api/v1/sales",
      body: {
        register_id: input.registerId,
        customer_id: input.customerId,
        lines: input.lines.map(orderLine),
        payments: input.payments.map((payment) => ({
          method_id: payment.methodId,
          amount: payment.amount,
          ...(payment.reference ? { reference: payment.reference } : {}),
        })),
        customer_credit: "0",
        notes: input.notes,
      },
      idempotencyKey,
    });
    if (!response.data?.id) throw new ErpError("ERP_PROTOCOL", "ERP sale POST returned no id");
    return response.data;
  }

  async getSale(id: string): Promise<ErpSaleSummary> {
    const response = await this.transport.request<ErpSaleSummary>({ method: "GET", path: `/api/v1/sales/${id}` });
    return response.data;
  }

  async settleCustomer(input: SettlementInput, idempotencyKey: string) {
    const response = await this.transport.request<{ id?: string; receipt_id?: string }>({
      method: "POST",
      path: "/api/v1/customers/settlements",
      body: {
        payment: {
          method_id: input.methodId,
          amount: input.amount,
          ...(input.reference ? { reference: input.reference } : {}),
        },
        allocations: input.allocations?.map((allocation) => ({
          document_id: allocation.saleId,
          document_type: "invoice",
          amount: allocation.amount,
        })),
      },
      idempotencyKey,
    });
    return response.data;
  }

  async createReturn(
    input: {
      saleId: string;
      reasonLanguage: string;
      lines: Array<{ saleLineId: string; quantity: number; restock: boolean }>;
      refundAmount?: string;
      methodId?: string;
    },
    idempotencyKey: string,
  ) {
    const response = await this.transport.request<{ id: string; number: string }>({
      method: "POST",
      path: "/api/v1/sales/returns",
      body: {
        sale_id: input.saleId,
        reason: input.reasonLanguage,
        lines: input.lines.map((line) => ({
          sale_line_id: line.saleLineId,
          quantity: line.quantity,
          restock: line.restock,
        })),
        ...(input.refundAmount && input.methodId
          ? { payment: { method_id: input.methodId, amount: input.refundAmount } }
          : {}),
      },
      idempotencyKey,
    });
    return response.data;
  }

  // -------------------------------------------------------------------------
  // Capabilities the ERP does not provide. Explicit failures, never fake work.
  // -------------------------------------------------------------------------
  async reserveInventory(): Promise<never> {
    throw unsupported("TTL stock reservations", "POST /api/v1/inventory/reservations", "G3");
  }

  async createChannelOrder(): Promise<never> {
    throw unsupported("channel orders without an open cashier shift", "POST /api/v1/integration/orders", "G4");
  }

  async postPaymentByReference(): Promise<never> {
    throw unsupported("payment posting by external reference", "POST /api/v1/integration/payments", "G5");
  }

  async createRefundByReference(): Promise<never> {
    throw unsupported("refunds by external reference", "POST /api/v1/integration/refunds", "G6");
  }

  async createShipment(): Promise<never> {
    throw unsupported("shipment records with tracking", "POST /api/v1/integration/shipments", "G7");
  }

  async subscribeEvents(): Promise<never> {
    throw unsupported("outbound ERP webhooks", "POST /api/v1/integration/subscriptions", "G8");
  }
}
