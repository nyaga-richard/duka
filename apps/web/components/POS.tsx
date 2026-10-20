"use client";
import React, { useState, useEffect, useRef, useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ShoppingBasket,
  Search,
  ScanBarcode,
  Plus,
  Minus,
  Trash2,
  Pause,
  RotateCcw,
  ArrowRight,
  Check,
  Printer,
  ArrowDownToLine,
  Clock3,
  Wallet,
  Smartphone,
  CreditCard,
  Settings2,
  Package,
  WifiOff,
  X,
  LockKeyhole,
  LoaderCircle,
  Save,
  ChevronDown,
  UserRound,
} from "lucide-react";
import { calculateLine, checkoutSchema } from "@duka/shared";
import {
  api,
  useWorkspace,
  useQuery,
  useDebounce,
  currency,
  number,
  D,
  draftDecimal as V,
  money,
  privateStore,
  updatePrivateStore,
  download,
  ApiError,
} from "./lib";
import {
  Button,
  Badge,
  Dialog,
  ErrorCard,
  SearchSelect,
  ProductAvatar,
  FormField,
  Fields,
} from "./ui";
function safeLine(l: any, td = "0") {
  try {
    return calculateLine({
      quantity: l.quantity,
      price: l.unit_price ?? l.product.price,
      lineDiscount: l.discount_percent ?? 0,
      transactionDiscount: td,
      taxRate: l.product.tax_rate ?? 0,
      inclusive: l.product.tax_inclusive,
    });
  } catch {
    return { net: "0.00", tax: "0.00", total: "0.00", discount: "0.00" };
  }
}
export default function POS() {
  const { meta, actor, branch, notify, online } = useWorkspace(),
    params = useSearchParams();
  const registers = meta.registers.filter(
    (r: any) => !branch || r.branch_id === branch,
  );
  const [registerId, setRegisterId] = useState(registers[0]?.id ?? "");
  const register = meta.registers.find((r: any) => r.id === registerId);
  const warehouse = register?.warehouse_id;
  const [search, setSearch] = useState(""),
    [category, setCategory] = useState(""),
    [lines, setLines] = useState<any[]>([]),
    [customer, setCustomer] = useState<any>(null),
    [discount, setDiscount] = useState("0"),
    [reason, setReason] = useState(""),
    [priceList, setPriceList] = useState(""),
    [paymentOpen, setPaymentOpen] = useState(false),
    [shiftOpen, setShiftOpen] = useState(false),
    [float, setFloat] = useState("5000"),
    [savedOpen, setSavedOpen] = useState(false),
    [pricingOpen, setPricingOpen] = useState(false),
    [receipt, setReceipt] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<any>(null),
    [quote, setQuote] = useState<any>(null),
    [quoting, setQuoting] = useState(false),
    [tenders, setTenders] = useState<any[]>([]),
    [credit, setCredit] = useState("0"),
    [cashReceived, setCashReceived] = useState(""),
    [phone, setPhone] = useState(""),
    [pending, setPending] = useState<any>(null),
    [cached, setCached] = useState<any[]>([]),
    [tracked, setTracked] = useState<any>(null),
    [batchId, setBatchId] = useState(""),
    [serials, setSerials] = useState(""),
    [activeDevice, setActiveDevice] = useState<any>(null),
    [sourceOrder, setSourceOrder] = useState<any>(null),
    [trackedIndex, setTrackedIndex] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null),
    cartLoaded = useRef(false),
    lastShift = useRef<any>(null),
    loadedOrder = useRef<string | null>(null);
  const debounced = useDebounce(search, 130);
  const query = new URLSearchParams({
    limit: "60",
    q: debounced,
    ...(warehouse ? { warehouse_id: warehouse } : {}),
    ...(category ? { category_id: category } : {}),
  });
  const products = useQuery<any>(online ? "/products?" + query : null);
  const shifts = useQuery<any>(online ? "/shifts?limit=30" : null);
  const saved = useQuery<any>(savedOpen && online ? "/pos/suspended" : null);
  const availability = useQuery<any>(
    tracked && warehouse
      ? `/pos/products/${tracked.id}/availability?warehouse_id=${warehouse}`
      : null,
  );
  const keyPrefix = `duka:cart:${actor.company_id}:${actor.id}`;
  const pendingKey = `duka:pending:${actor.company_id}:${actor.id}`;
  const shift =
    shifts.data?.items?.find(
      (s: any) =>
        s.register_id === registerId &&
        s.cashier_id === actor.id &&
        ["open", "rejected"].includes(s.status),
    ) ??
    (!online && lastShift.current?.register_id === registerId
      ? lastShift.current
      : null);
  if (shift) lastShift.current = shift;
  const localTotals = useMemo(
    () =>
      lines.reduce(
        (t, l) => {
          const c = safeLine(l, discount);
          return {
            subtotal: money(D(t.subtotal).plus(c.net)),
            tax: money(D(t.tax).plus(c.tax)),
            total: money(D(t.total).plus(c.total)),
            discount: money(D(t.discount).plus(c.discount)),
          };
        },
        { subtotal: "0.00", tax: "0.00", total: "0.00", discount: "0.00" },
      ),
    [lines, discount],
  );
  const totals = online && quote ? quote : localTotals;
  const payload = () => ({
    register_id: registerId,
    ...(sourceOrder ? { order_id: sourceOrder.id } : {}),
    ...(customer ? { customer_id: customer.id } : {}),
    ...(priceList ? { price_list_id: priceList } : {}),
    lines: lines.map((l) => ({
      product_id: l.product_id,
      quantity: l.quantity,
      ...(l.unit_id ? { unit_id: l.unit_id } : {}),
      ...(l.unit_price !== undefined ? { unit_price: l.unit_price } : {}),
      ...(V(l.discount_percent ?? 0).gt(0)
        ? { discount_percent: l.discount_percent }
        : {}),
      ...(l.batch_id ? { batch_id: l.batch_id } : {}),
      serials: l.serials ?? [],
    })),
    discount_percent: discount || "0",
    payments: [],
    ...(reason ? { override_reason: reason } : {}),
  });
  useEffect(() => {
    try {
      const old = JSON.parse(localStorage.getItem(keyPrefix) ?? "null");
      if (old) {
        setLines(old.lines ?? []);
        setCustomer(old.customer ?? null);
        setDiscount(old.discount ?? "0");
        setSourceOrder(old.sourceOrder ?? null);
        if (meta.registers.some((r: any) => r.id === old.registerId))
          setRegisterId(old.registerId);
      }
      const p = JSON.parse(localStorage.getItem(pendingKey) ?? "null");
      if (p) setPending(p);
    } catch {}
    cartLoaded.current = true;
    privateStore<any[]>("catalog:" + actor.id).then((v) => setCached(v ?? []));
    privateStore("device:" + actor.id).then(setActiveDevice);
    searchRef.current?.focus();
  }, [actor.id]);
  useEffect(() => {
    if (cartLoaded.current)
      localStorage.setItem(
        keyPrefix,
        JSON.stringify({ lines, customer, discount, registerId, sourceOrder }),
      );
  }, [lines, customer, discount, registerId, sourceOrder]);
  useEffect(() => {
    if (
      registers.length &&
      !registers.some((r: any) => r.id === registerId) &&
      !lines.length
    )
      setRegisterId(registers[0].id);
  }, [branch]);
  const quoteBody = JSON.stringify(payload());
  useEffect(() => {
    if (!lines.length) {
      setQuote(null);
      return;
    }
    if (!online) return;
    const controller = new AbortController();
    setQuoting(true);
    const timer = setTimeout(() => {
      api("/pos/price", {
        method: "POST",
        body: JSON.parse(quoteBody),
        signal: controller.signal,
      })
        .then((r: any) => {
          setQuote({ ...r, signature: quoteBody });
          setError(null);
        })
        .catch((e) => {
          if (e.name !== "AbortError") {
            setQuote(null);
            setError(e);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setQuoting(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [quoteBody, online]);
  useEffect(() => {
    const id = params.get("order");
    if (!id || !online || loadedOrder.current === id) return;
    loadedOrder.current = id;
    if (pending) {
      notify("Resolve the pending checkout before loading an order.", "error");
      return;
    }
    let existing: any = null;
    try {
      existing = JSON.parse(localStorage.getItem(keyPrefix) ?? "null");
    } catch {}
    if (
      existing?.lines?.length &&
      existing?.sourceOrder?.id !== id &&
      !window.confirm(
        "Replace your unposted cart with this approved order? Save the cart first if you need to keep it.",
      )
    )
      return;
    api("/pos/orders/" + id)
      .then((order: any) => {
        const till = meta.registers.find(
          (r: any) => r.warehouse_id === order.warehouse_id,
        );
        if (!till)
          throw new Error("No assigned register serves the order warehouse.");
        setRegisterId(till.id);
        setSourceOrder({ id: order.id, number: order.number });
        setLines(order.lines);
        setCustomer(order.customer);
        setDiscount("0");
        setPriceList("");
        setReason("");
        setQuote(null);
        setError(null);
        notify(
          "Order loaded. Approved base quantities are fixed; current server pricing and tracking will be revalidated.",
          "info",
        );
      })
      .catch((e: any) => notify(e.message, "error"));
  }, [params.get("order"), online]);
  useEffect(() => {
    const add = params.get("add");
    if (add && online) {
      api("/products/" + add)
        .then((p: any) =>
          api(
            "/products?q=" +
              encodeURIComponent(p.sku) +
              "&warehouse_id=" +
              warehouse,
          ).then((r: any) => {
            if (r.items[0]) addProduct(r.items[0]);
          }),
        )
        .catch((e) => notify(e.message, "error"));
    }
  }, [params.get("add")]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "F2") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "F8") {
        e.preventDefault();
        if (lines.length && !paymentOpen) beginPayment();
      }
      if (e.key === "F9") {
        e.preventDefault();
        if (lines.length) suspend();
      }
      if (e.key === "F4") {
        e.preventDefault();
        document
          .querySelector<HTMLInputElement>(".cart-customer input")
          ?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [lines, quote, shift, online]);
  useEffect(() => {
    if (
      !paymentOpen ||
      !online ||
      !tenders.some((t) => t.intent_id && t.intent_status === "pending")
    )
      return;
    let stopped = false;
    const poll = setInterval(async () => {
      for (const t of tenders.filter(
        (t) => t.intent_id && t.intent_status === "pending",
      )) {
        try {
          const r: any = await api(
            "/integrations/mpesa/intents/" + t.intent_id,
          );
          if (!stopped && r.status !== "pending")
            setTenders((rows) =>
              rows.map((x) =>
                x.id === t.id
                  ? {
                      ...x,
                      intent_status: r.status,
                      reference: r.receipt_number ?? "",
                    }
                  : x,
              ),
            );
        } catch {}
      }
    }, 2500);
    return () => {
      stopped = true;
      clearInterval(poll);
    };
  }, [paymentOpen, tenders, online]);
  function clear() {
    if (pending) return;
    setLines([]);
    setCustomer(null);
    setDiscount("0");
    setReason("");
    setQuote(null);
    setCredit("0");
    setPriceList("");
    setSourceOrder(null);
    setError(null);
    searchRef.current?.focus();
  }
  function addProduct(p: any, tracking?: any) {
    if (pending) {
      notify("Resolve the pending checkout before changing the cart.", "error");
      return;
    }
    if (sourceOrder) {
      notify(
        "Order quantities are fixed. Clear the order cart to create an unrelated sale.",
        "error",
      );
      return;
    }
    if ((p.batch_tracked || p.serial_tracked) && !tracking) {
      setTrackedIndex(null);
      setTracked(p);
      setBatchId("");
      setSerials("");
      return;
    }
    setLines((rows) => {
      const at = rows.findIndex(
        (l) =>
          l.product_id === p.id &&
          !l.batch_id &&
          !tracking &&
          !p.serial_tracked,
      );
      if (at >= 0)
        return rows.map((l, i) =>
          i === at ? { ...l, quantity: V(l.quantity).plus(1).toString() } : l,
        );
      return [
        ...rows,
        {
          product_id: p.id,
          product: p,
          quantity: "1",
          ...(tracking ?? {}),
          serials: tracking?.serials ?? [],
        },
      ];
    });
    setError(null);
    setSearch("");
    searchRef.current?.focus();
  }
  function updateQuantity(i: number, value: string) {
    if (pending || sourceOrder) return;
    if (value !== "" && !/^\d*(\.\d{0,6})?$/.test(value)) return;
    setLines((rows) =>
      rows.map((l, j) => (j === i ? { ...l, quantity: value } : l)),
    );
  }
  async function scan(e: React.KeyboardEvent) {
    if (e.key !== "Enter" || !search.trim()) return;
    e.preventDefault();
    try {
      const r: any = online
        ? await api(
            "/products?warehouse_id=" +
              warehouse +
              "&q=" +
              encodeURIComponent(search.trim()),
          )
        : {
            items: cached.filter(
              (p) => p.barcode === search || p.sku === search,
            ),
          };
      const exact =
        r.items.find(
          (p: any) => p.barcode === search.trim() || p.sku === search.trim(),
        ) ?? (r.items.length === 1 ? r.items[0] : null);
      if (exact) addProduct(exact);
      else
        notify(
          "No exact barcode found. Select a matching product below.",
          "info",
        );
    } catch (e: any) {
      notify(e.message, "error");
    }
  }
  async function openTill(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/shifts/open", {
        method: "POST",
        body: { register_id: registerId, opening_float: float },
      });
      shifts.refresh();
      setShiftOpen(false);
      notify("Till opened. You’re ready to sell.");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function suspend() {
    if (pending) return;
    try {
      if (online) {
        await api("/pos/suspended", {
          method: "POST",
          body: {
            branch_id: register.branch_id,
            label:
              customer?.name ??
              "Cart " + new Date().toLocaleTimeString("en-KE"),
            cart: payload(),
          },
        });
        notify("Cart saved. No stock or money has been posted.");
        clear();
      } else {
        const old = (await privateStore<any[]>("suspended:" + actor.id)) ?? [];
        await privateStore("suspended:" + actor.id, [
          ...old,
          {
            id: crypto.randomUUID(),
            label: "Local cart",
            snapshot: { lines, customer, discount, registerId },
          },
        ]);
        notify("Saved on this device only.", "info");
        clear();
      }
    } catch (e: any) {
      notify(e.message, "error");
    }
  }
  async function resume(s: any) {
    try {
      if (pending) return;
      const cart = s.cart;
      const loaded = await Promise.all(
        cart.lines.map(async (l: any) => {
          const product: any = await api("/products/" + l.product_id);
          const result: any = await api(
            "/products?q=" +
              encodeURIComponent(product.sku) +
              "&warehouse_id=" +
              warehouse,
          );
          return {
            ...l,
            product:
              result.items.find((p: any) => p.id === l.product_id) ?? product,
          };
        }),
      );
      setLines(loaded);
      setDiscount(cart.discount_percent ?? "0");
      if (cart.customer_id) {
        const c: any = await api("/customers?q=&limit=100");
        setCustomer(
          c.items.find((v: any) => v.id === cart.customer_id) ?? null,
        );
      } else setCustomer(null);
      setRegisterId(cart.register_id);
      setSourceOrder(
        cart.order_id ? { id: cart.order_id, number: "Approved order" } : null,
      );
      setSavedOpen(false);
      await api("/pos/suspended/" + s.id, { method: "DELETE" });
      notify("Saved cart resumed and repriced.");
    } catch (e: any) {
      notify(e.message, "error");
    }
  }
  function beginPayment() {
    setError(null);
    if (!lines.length) return;
    if (lines.some((l) => !l.quantity || !V(l.quantity).gt(0))) {
      notify("Every quantity must be greater than zero.", "error");
      return;
    }
    if (!shift) {
      setShiftOpen(true);
      return;
    }
    if (online && (quoting || !quote || quote.signature !== quoteBody)) {
      notify("Please wait for server pricing.", "info");
      return;
    }
    const cash = meta.payment_methods.find(
      (m: any) => m.kind === "cash" && m.active,
    );
    setTenders([
      {
        id: crypto.randomUUID(),
        method_id: cash?.id ?? meta.payment_methods[0]?.id,
        amount: totals.total,
        reference: "",
      },
    ]);
    setCashReceived(totals.total);
    setCredit("0");
    setPaymentOpen(true);
  }
  const tenderTotal = tenders.reduce(
    (n, t) => {
      try {
        return n.plus(t.amount || 0);
      } catch {
        return n;
      }
    },
    V(credit || 0),
  );
  const remaining = D(totals.total).minus(tenderTotal);
  const cashApplied = tenders
    .filter(
      (t) =>
        meta.payment_methods.find((m: any) => m.id === t.method_id)?.kind ===
        "cash",
    )
    .reduce((n, t) => {
      try {
        return n.plus(t.amount || 0);
      } catch {
        return n;
      }
    }, D(0));
  let change = D(0);
  try {
    change = V(cashReceived || 0).minus(cashApplied);
  } catch {}
  async function initiate(t: any) {
    setBusy(true);
    setError(null);
    try {
      const result: any = await api("/integrations/mpesa/intents", {
        method: "POST",
        body: { branch_id: register.branch_id, amount: t.amount, phone },
      });
      setTenders((rows) =>
        rows.map((x) =>
          x.id === t.id
            ? { ...x, intent_id: result.id, intent_status: "pending" }
            : x,
        ),
      );
      notify("STK prompt requested. Awaiting provider confirmation.", "info");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function confirmMock(t: any) {
    setBusy(true);
    try {
      await api(`/integrations/mpesa/intents/${t.intent_id}/mock`, {
        method: "POST",
        body: { status: "successful" },
      });
      const r: any = await api("/integrations/mpesa/intents/" + t.intent_id);
      setTenders((rows) =>
        rows.map((x) =>
          x.id === t.id
            ? { ...x, intent_status: r.status, reference: r.receipt_number }
            : x,
        ),
      );
    } catch (e: any) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  function clearPending() {
    setPending(null);
    try {
      localStorage.removeItem(pendingKey);
    } catch {}
  }
  async function finishPosted(result: any) {
    clearPending();
    setPaymentOpen(false);
    setLines([]);
    setCustomer(null);
    setDiscount("0");
    setSourceOrder(null);
    setQuote(null);
    setCredit("0");
    setReceipt({ ...result, fiscal: { status: "unknown" } });
    products.refresh();
    shifts.refresh();
    notify("Sale posted. Stock, payments and books are connected.");
    try {
      setReceipt(await api("/sales/" + result.id));
    } catch {
      notify(
        "Sale is confirmed as " +
          result.number +
          ". Detailed receipt is temporarily unavailable; retrieve it from Sales & invoices. Do not post it again.",
        "info",
      );
    }
  }
  async function recoverOrCancel() {
    if (
      !pending ||
      !online ||
      !window.confirm(
        "Recover an already posted sale, or permanently cancel ONLY this unposted intention? No posted sale is deleted, and no bank/M-Pesa transfer is refunded. Reconcile any money already received with a manager.",
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const result: any = await api("/sales/recovery/cancel", {
        method: "POST",
        body: {
          key: pending.key,
          reason:
            "Operator requested authoritative recovery or cancellation of this uncertain checkout",
        },
      });
      if (result.status === "posted") await finishPosted(result.sale);
      else {
        clearPending();
        setPaymentOpen(false);
        notify(
          "Unposted checkout cancelled permanently. Draft retained; reconcile any received funds before creating a new intention.",
          "info",
        );
      }
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  async function pay(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    setBusy(true);
    const recovering = !!pending;
    let submitted = false;
    let submission = pending;
    try {
      if (!online && recovering)
        throw new ApiError(
          "UNCERTAIN_ONLINE",
          "An unconfirmed online checkout cannot become an offline capture. Reconnect and recover the original result.",
        );
      if (!submission) {
        const p: any = {
          ...payload(),
          customer_credit: credit || "0",
          payments: tenders
            .filter((t) => V(t.amount || 0).gt(0))
            .map((t) => ({
              method_id: t.method_id,
              amount: t.amount,
              ...(t.reference ? { reference: t.reference } : {}),
              ...(t.intent_id ? { intent_id: t.intent_id } : {}),
            })),
        };
        const validated = checkoutSchema.safeParse(p);
        if (!validated.success)
          throw new ApiError(
            "VALIDATION_ERROR",
            "Review the quantities, prices, discounts and payment amounts before submitting.",
            validated.error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          );
        if (!/^\d+(\.\d{1,2})?$/.test(cashReceived || "0") || change.lt(0))
          throw new Error(
            "Cash received must be a valid amount covering the cash tender.",
          );
        submission = { key: crypto.randomUUID(), payload: validated.data };
      }
      if (!online) {
        if (!shift)
          throw new Error(
            "Cache an open cashier shift before capturing offline cash",
          );
        if (!activeDevice)
          throw new Error(
            "This device is not authorized for offline capture. Save the cart until connected.",
          );
        if (
          customer ||
          tenders.some(
            (t) =>
              meta.payment_methods.find((m: any) => m.id === t.method_id)
                ?.kind !== "cash",
          )
        )
          throw new Error(
            "Offline capture permits walk-in cash only. Payments and fiscalization are not confirmed.",
          );
        if (
          activeDevice.device.register_id !== registerId ||
          !activeDevice.device.active
        )
          throw new Error(
            "The cached device authorization does not cover this register.",
          );
        const p = submission.payload;
        if (
          p.order_id ||
          p.price_list_id ||
          V(p.customer_credit).gt(0) ||
          V(p.discount_percent).gt(0) ||
          p.lines.some(
            (l: any) =>
              l.unit_price !== undefined || V(l.discount_percent).gt(0),
          )
        )
          throw new Error(
            "Offline capture permits only standard retail prices: no orders, credit, overrides, price lists or discounts.",
          );
        if (V(totals.total).gt(activeDevice.device.max_sale_amount))
          throw new Error(
            "This sale exceeds the device's authorized offline limit.",
          );
        const captured = {
          client_id: submission.key,
          device_id: activeDevice.device.id,
          catalog_version: activeDevice.version,
          captured_at: new Date().toISOString(),
          captured_shift_id: shift?.id,
          accept_changes: false,
          sale: submission.payload,
          status: "local",
        };
        await updatePrivateStore<any[]>("queue:" + actor.id, (old) => [
          ...(old ?? []).filter((q) => q.client_id !== captured.client_id),
          captured,
        ]);
        setPaymentOpen(false);
        notify(
          "Saved locally — NOT a confirmed sale. Review synchronization when connected.",
          "info",
        );
        clear();
        return;
      }
      setPending(submission);
      try {
        localStorage.setItem(pendingKey, JSON.stringify(submission));
      } catch {
        throw new Error(
          recovering
            ? "Cannot persist recovery on this device. The original result remains unconfirmed; use authoritative recovery before starting a replacement."
            : "Cannot save checkout recovery on this device. No sale was submitted; free storage or use a supported browser profile.",
        );
      }
      submitted = true;
      const result: any = await api("/sales", {
        method: "POST",
        body: submission.payload,
        key: submission.key,
      });
      await finishPosted(result);
    } catch (e: any) {
      setError(e);
      const definitelyRejected =
        e instanceof ApiError &&
        e.status !== undefined &&
        e.status >= 400 &&
        e.status < 500 &&
        ![401, 429].includes(e.status) &&
        !["TRANSACTION_BUSY", "IDEMPOTENCY_SCOPE_CHANGED"].includes(e.code);
      if (
        e?.code === "COMMAND_CANCELLED" ||
        (!recovering && (!submitted || definitelyRejected))
      )
        clearPending();
      // Never clear a previously ambiguous intention after a later denial/429.
    } finally {
      setBusy(false);
    }
  }
  const shownProducts = online
    ? (products.data?.items ?? [])
    : cached.filter(
        (p) =>
          (!category || p.category_id === category) &&
          (!search ||
            [p.name, p.sku, p.barcode].some((v) =>
              v?.toLowerCase().includes(search.toLowerCase()),
            )),
      );
  return (
    <div className="pos-workspace">
      <section className="pos-catalog">
        <div className="pos-title-row">
          <div>
            <span className="eyebrow">YOUR CHECKOUT WORKSPACE</span>
            <h1>Point of sale</h1>
          </div>
          <div className="pos-register">
            <Clock3 size={16} />
            <select
              aria-label="Active register"
              value={registerId}
              disabled={!!lines.length || !!pending}
              onChange={(e) => setRegisterId(e.target.value)}
            >
              {registers.map((r: any) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <Badge status={shift ? "open" : "submitted"}>
              {shift ? "Shift open" : "Closed"}
            </Badge>
          </div>
        </div>
        {pending && (
          <div className="pending-checkout">
            <LockKeyhole size={18} />
            <span>
              A checkout is awaiting a confirmed response. Your cart is locked
              to prevent duplicate sales.
            </span>
            <Button
              variant="secondary"
              onClick={() => {
                setPaymentOpen(true);
              }}
            >
              Review & retry
            </Button>
            <Button
              variant="secondary"
              busy={busy}
              disabled={!online}
              onClick={recoverOrCancel}
            >
              Recover or cancel unposted
            </Button>
          </div>
        )}
        {!shift && online && (
          <div className="till-banner">
            <Wallet size={19} />
            <div>
              <strong>Ready for your first sale?</strong>
              <span>Open a till and record your opening float.</span>
            </div>
            <Button
              variant="secondary"
              onClick={() => {
                setError(null);
                setShiftOpen(true);
              }}
            >
              Open till <ArrowRight size={15} />
            </Button>
          </div>
        )}
        <div className="pos-search">
          <ScanBarcode size={22} />
          <input
            ref={searchRef}
            aria-label="Scan barcode or search products"
            placeholder="Scan a barcode or search by name, SKU…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={scan}
            autoComplete="off"
          />
          <kbd>F2</kbd>
          {search && (
            <button
              className="icon-btn"
              aria-label="Clear search"
              onClick={() => setSearch("")}
            >
              <X size={16} />
            </button>
          )}
        </div>
        <div
          className="category-tabs"
          role="tablist"
          aria-label="Product category"
        >
          <button
            role="tab"
            aria-selected={!category}
            className={!category ? "active" : ""}
            onClick={() => setCategory("")}
          >
            All products
          </button>
          {meta.categories.map((c: any) => (
            <button
              role="tab"
              aria-selected={category === c.id}
              key={c.id}
              className={category === c.id ? "active" : ""}
              onClick={() => setCategory(c.id)}
            >
              {c.name}
            </button>
          ))}
        </div>
        <div className="pos-product-heading">
          <span>
            {online ? (products.data?.total ?? 0) : shownProducts.length}{" "}
            products
          </span>
          <span>
            {online ? "Live inventory" : "Cached catalog · stock unverified"}
          </span>
        </div>
        {products.error && (
          <ErrorCard error={products.error} retry={products.refresh} />
        )}
        <div className="product-grid">
          {products.loading && online ? (
            Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="product-tile skeleton-tile">
                <span className="skeleton" />
                <span className="skeleton" />
              </div>
            ))
          ) : shownProducts.length ? (
            shownProducts.map((p: any) => (
              <button
                key={p.id}
                className="product-tile"
                onClick={() => addProduct(p)}
                disabled={!!pending}
              >
                <div className="product-tile-art">
                  <ProductAvatar name={p.name} />
                  <span className="add-product">
                    <Plus size={17} />
                  </span>
                  {p.kind === "stock" &&
                    D(p.stock ?? 0).lte(p.reorder_level) && (
                      <span className="low-product-label">Low stock</span>
                    )}
                </div>
                <div className="product-tile-copy">
                  <small>{p.category ?? "PRODUCT"}</small>
                  <strong>{p.name}</strong>
                  <span className="tile-sku">{p.sku}</span>
                  <div>
                    <b>{currency(p.price, meta.company.currency)}</b>
                    <span>
                      {p.kind === "service"
                        ? "Service"
                        : `${number(p.stock)} ${p.unit ?? "in stock"}`}
                    </span>
                  </div>
                </div>
              </button>
            ))
          ) : (
            <div className="empty products-empty">
              <Package size={36} />
              <h3>No matching products</h3>
              <p>Try another barcode, name, SKU or category.</p>
            </div>
          )}
        </div>
        <div className="pos-shortcuts">
          <span>
            <kbd>F2</kbd> Search / scan
          </span>
          <span>
            <kbd>F4</kbd> Customer
          </span>
          <span>
            <kbd>F8</kbd> Payment
          </span>
          <span>
            <kbd>F9</kbd> Save cart
          </span>
          <button
            onClick={() => {
              saved.refresh();
              setSavedOpen(true);
            }}
          >
            <RotateCcw size={14} /> Saved carts
          </button>
        </div>
      </section>
      <aside className="cart-panel">
        <div className="cart-heading">
          <div>
            <h2>
              Current sale <span>{lines.length}</span>
            </h2>
            <p>Every great day starts with a sale.</p>
          </div>
          <button
            className="icon-btn"
            title="Clear cart"
            aria-label="Clear current cart"
            disabled={!!pending || !lines.length}
            onClick={() => {
              if (window.confirm("Clear this unposted cart?")) clear();
            }}
          >
            <Trash2 size={17} />
          </button>
        </div>
        {sourceOrder && (
          <div className="warning-box" style={{ margin: "15px 18px 0" }}>
            <Package size={17} />
            <p>
              Fulfilling {sourceOrder.number}. Approved quantities are fixed.
              Current prices are checked again.
            </p>
          </div>
        )}
        <div className="cart-customer">
          <SearchSelect
            endpoint="/customers"
            label="CUSTOMER"
            placeholder="Walk-in customer"
            value={customer}
            onChange={(c) => {
              if (!pending && !sourceOrder) setCustomer(c);
            }}
          />
        </div>
        {customer && (
          <div className="credit-info">
            Credit limit{" "}
            {currency(customer.credit_limit, meta.company.currency)} · Balance{" "}
            {currency(customer.balance, meta.company.currency)}
          </div>
        )}
        <div className="cart-lines">
          {lines.length ? (
            lines.map((l, i) => (
              <div className="cart-line" key={i}>
                <ProductAvatar name={l.product.name} small />
                <div className="cart-line-info">
                  <strong>{l.product.name}</strong>
                  <small>
                    {currency(
                      V(l.unit_price ?? l.product.price),
                      meta.company.currency,
                    )}{" "}
                    / {l.product.unit ?? "unit"}{" "}
                    {l.batch_id ? "· batch selected" : ""}
                  </small>
                  {(l.product.batch_tracked || l.product.serial_tracked) && (
                    <Button
                      variant="ghost"
                      disabled={!!pending}
                      onClick={() => {
                        setTracked(l.product);
                        setTrackedIndex(i);
                        setBatchId(l.batch_id ?? "");
                        setSerials((l.serials ?? []).join("\n"));
                      }}
                    >
                      {l.batch_id || l.serials?.length
                        ? "Change tracking"
                        : "Select batch / serials"}
                    </Button>
                  )}
                  <div className="quantity-stepper">
                    <button
                      aria-label={"Decrease " + l.product.name}
                      disabled={!!pending || !!sourceOrder}
                      onClick={() => {
                        const q = D(l.quantity || 0).minus(
                          l.product.fractional ? "0.25" : "1",
                        );
                        if (q.gt(0)) updateQuantity(i, q.toString());
                        else setLines((rows) => rows.filter((_, n) => n !== i));
                      }}
                    >
                      <Minus size={12} />
                    </button>
                    <input
                      aria-label={"Cart quantity " + l.product.name}
                      value={l.quantity}
                      inputMode="decimal"
                      disabled={!!pending || !!sourceOrder}
                      onChange={(e) => updateQuantity(i, e.target.value)}
                    />
                    <button
                      aria-label={"Increase " + l.product.name}
                      disabled={!!pending || !!sourceOrder}
                      onClick={() =>
                        updateQuantity(
                          i,
                          D(l.quantity || 0)
                            .plus(l.product.fractional ? "0.25" : "1")
                            .toString(),
                        )
                      }
                    >
                      <Plus size={12} />
                    </button>
                  </div>
                </div>
                <div className="cart-line-end">
                  <strong>
                    {currency(
                      quote?.lines?.[i]?.total ?? safeLine(l, discount).total,
                      meta.company.currency,
                    )}
                  </strong>
                  <button
                    className="icon-btn"
                    aria-label={"Remove " + l.product.name}
                    disabled={!!pending}
                    onClick={() =>
                      setLines((rows) => rows.filter((_, n) => n !== i))
                    }
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="empty cart-empty">
              <div>
                <ShoppingBasket size={33} />
              </div>
              <h3>Your next sale starts here.</h3>
              <p>
                Scan a barcode or choose a product
                <br />
                to add it to the cart.
              </p>
            </div>
          )}
        </div>
        <div className="cart-bottom">
          {error && !paymentOpen && !shiftOpen && <ErrorCard error={error} />}
          <div className="cart-tools">
            <Button
              variant="ghost"
              disabled={!lines.length || !!pending}
              onClick={suspend}
            >
              <Pause size={15} /> Save cart
            </Button>
            {actor.permissions.includes("sales.discount") && (
              <Button
                variant="ghost"
                disabled={!lines.length || !!pending}
                onClick={() => setPricingOpen(true)}
              >
                <Settings2 size={15} /> Pricing
              </Button>
            )}
          </div>
          <div className="totals-row">
            <span>Subtotal</span>
            <strong>{currency(totals.subtotal, meta.company.currency)}</strong>
          </div>
          <div className="totals-row">
            <span>Tax</span>
            <strong>{currency(totals.tax, meta.company.currency)}</strong>
          </div>
          {D(totals.discount ?? 0).gt(0) && (
            <div className="totals-row">
              <span>Discount</span>
              <strong>
                − {currency(totals.discount, meta.company.currency)}
              </strong>
            </div>
          )}
          <div className="cart-grand-total">
            <span>Total to pay</span>
            <strong>{currency(totals.total, meta.company.currency)}</strong>
          </div>
          <Button
            className="checkout-btn"
            onClick={beginPayment}
            disabled={!lines.length || quoting || (!online && !activeDevice)}
          >
            {quoting ? (
              <>
                <LoaderCircle size={18} className="spin" /> Confirming prices…
              </>
            ) : (
              <>
                <Wallet size={18} />
                {pending
                  ? "Review pending checkout"
                  : online
                    ? "Continue to payment"
                    : "Capture locally"}
                <ArrowRight size={18} />
              </>
            )}
          </Button>
          <div className="cart-security">
            <LockKeyhole size={12} />
            {online
              ? "Server-priced. Atomically posted."
              : "Local draft only — not a confirmed sale."}
          </div>
        </div>
      </aside>
      <Dialog
        open={shiftOpen}
        onClose={() => {
          if (!busy) setShiftOpen(false);
        }}
        title="Open your till"
        description="Count the physical cash you’re starting with. Non-cash payments are tracked separately."
      >
        <form onSubmit={openTill}>
          {error && <ErrorCard error={error} />}
          <FormField label="Register">
            <input value={register?.name ?? "No assigned register"} readOnly />
          </FormField>
          <FormField label="Opening float (KES)" required>
            <input
              value={float}
              inputMode="decimal"
              onChange={(e) => setFloat(e.target.value)}
              required
            />
          </FormField>
          <div className="form-actions">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setShiftOpen(false)}
            >
              Cancel
            </Button>
            <Button busy={busy} type="submit">
              Open till <ArrowRight size={16} />
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={paymentOpen}
        onClose={() => {
          if (!busy) setPaymentOpen(false);
        }}
        title="Complete the sale"
        description={
          pending
            ? "A previous submission is awaiting confirmation. Retry the original unchanged command."
            : "Choose one or more tenders. Payment amounts are applied net of cash change."
        }
        wide
      >
        <form onSubmit={pay}>
          {error && <ErrorCard error={error} />}
          <div className="payment-total">
            <span>Total due</span>
            <strong>{currency(totals.total, meta.company.currency)}</strong>
            <small>
              {customer?.name ?? "Walk-in customer"} · {register?.name}
            </small>
          </div>
          {!online && (
            <div className="warning-box">
              <WifiOff size={19} />
              <p>
                This is local cash capture only. Stock, prices, accounting and
                fiscalization will be validated on synchronization. A conflict
                may require manager resolution.
              </p>
            </div>
          )}
          {tenders.map((t, i) => {
            const method = meta.payment_methods.find(
              (m: any) => m.id === t.method_id,
            );
            return (
              <div className="tender-row" key={t.id}>
                <FormField
                  label={i === 0 ? "Payment method" : "Additional method"}
                >
                  <select
                    value={t.method_id}
                    disabled={!!pending || !!t.intent_id}
                    onChange={(e) =>
                      setTenders((rows) =>
                        rows.map((x) =>
                          x.id === t.id
                            ? {
                                ...x,
                                method_id: e.target.value,
                                reference: "",
                                intent_id: undefined,
                                intent_status: undefined,
                              }
                            : x,
                        ),
                      )
                    }
                  >
                    {meta.payment_methods
                      .filter((m: any) => m.active)
                      .map((m: any) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                  </select>
                </FormField>
                <FormField label="Applied amount">
                  <input
                    inputMode="decimal"
                    required
                    value={t.amount}
                    disabled={!!pending || !!t.intent_id}
                    onChange={(e) =>
                      setTenders((rows) =>
                        rows.map((x) =>
                          x.id === t.id ? { ...x, amount: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </FormField>
                {i > 0 && (
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={!!pending || !!t.intent_id}
                    aria-label="Remove tender"
                    onClick={() =>
                      setTenders((rows) => rows.filter((x) => x.id !== t.id))
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                )}
                {method?.requires_reference && method.kind !== "mpesa" && (
                  <FormField label="Confirmed payment reference">
                    <input
                      required
                      value={t.reference ?? ""}
                      disabled={!!pending || !!sourceOrder}
                      onChange={(e) =>
                        setTenders((rows) =>
                          rows.map((x) =>
                            x.id === t.id
                              ? { ...x, reference: e.target.value }
                              : x,
                          ),
                        )
                      }
                    />
                  </FormField>
                )}
                {method?.kind === "mpesa" && (
                  <div className="mpesa-box">
                    <Smartphone size={20} />
                    <div>
                      <strong>M-Pesa Express</strong>
                      <p>
                        {t.intent_status === "successful"
                          ? "Confirmed by provider query and callback."
                          : t.intent_id
                            ? "Waiting for customer and provider confirmation."
                            : "Initiating a prompt does not confirm payment."}
                      </p>
                    </div>
                    {t.intent_status && (
                      <Badge status={t.intent_status}>{t.intent_status}</Badge>
                    )}
                    {!t.intent_id ? (
                      <div className="mpesa-init">
                        <input
                          aria-label="M-Pesa phone"
                          placeholder="2547XXXXXXXX"
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                          inputMode="tel"
                        />
                        <Button
                          type="button"
                          busy={busy}
                          disabled={!online}
                          onClick={() => initiate(t)}
                        >
                          Send prompt
                        </Button>
                      </div>
                    ) : process.env.NEXT_PUBLIC_DEMO_MODE === "true" &&
                      t.intent_status === "pending" ? (
                      <Button
                        type="button"
                        variant="secondary"
                        busy={busy}
                        onClick={() => confirmMock(t)}
                      >
                        Confirm with test provider
                      </Button>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
          <Button
            type="button"
            variant="ghost"
            disabled={!!pending || !online}
            onClick={() =>
              setTenders((rows) => [
                ...rows,
                {
                  id: crypto.randomUUID(),
                  method_id:
                    meta.payment_methods.find((m: any) => m.kind === "bank")
                      ?.id ?? meta.payment_methods[0].id,
                  amount: remaining.gt(0) ? money(remaining) : "0",
                  reference: "",
                },
              ])
            }
          >
            <Plus size={16} /> Split payment
          </Button>
          {customer && online && (
            <FormField
              label="Use customer account credit"
              help="Server checks available unapplied advances; this is not a new credit sale."
            >
              <input
                inputMode="decimal"
                value={credit}
                disabled={!!pending}
                onChange={(e) => setCredit(e.target.value)}
              />
            </FormField>
          )}
          {cashApplied.gt(0) && (
            <div className="cash-change">
              <FormField label="Cash received">
                <input
                  inputMode="decimal"
                  value={cashReceived}
                  onChange={(e) => setCashReceived(e.target.value)}
                />
              </FormField>
              <div>
                <span>Change to give</span>
                <strong>
                  {currency(change.gt(0) ? change : 0, meta.company.currency)}
                </strong>
              </div>
            </div>
          )}
          <div
            className={`payment-balance ${remaining.gt(0) ? "warning" : ""}`}
          >
            <span>
              {remaining.lt(0)
                ? "Over-applied"
                : remaining.gt(0)
                  ? "Remaining on customer account"
                  : "Payment balanced"}
            </span>
            <strong>{currency(remaining.abs(), meta.company.currency)}</strong>
          </div>
          {remaining.gt(0) && (
            <p className="form-note">
              Only a registered customer with authorized credit and sufficient
              credit limit can leave a balance.
            </p>
          )}
          <div className="form-actions">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setPaymentOpen(false)}
              disabled={busy}
            >
              Back to cart
            </Button>
            <Button
              type="submit"
              busy={busy}
              disabled={
                !pending &&
                (remaining.lt(0) ||
                  (remaining.gt(0) &&
                    (!customer ||
                      !actor.permissions.includes("sales.credit"))) ||
                  tenders.some(
                    (t) =>
                      meta.payment_methods.find(
                        (m: any) => m.id === t.method_id,
                      )?.kind === "mpesa" && t.intent_status !== "successful",
                  ) ||
                  change.lt(0))
              }
            >
              {online ? "Confirm & post sale" : "Save local capture"}{" "}
              <Check size={17} />
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={savedOpen}
        onClose={() => setSavedOpen(false)}
        title="Saved carts"
        description="Suspended carts are repriced against current catalog and tax rules when resumed."
      >
        {saved.error && <ErrorCard error={saved.error} />}
        <div className="saved-carts">
          {saved.data?.items?.map((s: any) => (
            <button key={s.id} onClick={() => resume(s)}>
              <Pause size={20} />
              <div>
                <strong>{s.label}</strong>
                <small>
                  {s.cart.lines.length} lines ·{" "}
                  {new Date(s.created_at).toLocaleString("en-KE")}
                </small>
              </div>
              <ArrowRight size={17} />
            </button>
          ))}
          {!saved.data?.items?.length && (
            <div className="empty">
              <ShoppingBasket size={32} />
              <strong>No saved carts yet.</strong>
            </div>
          )}
        </div>
      </Dialog>
      <Dialog
        open={pricingOpen}
        onClose={() => setPricingOpen(false)}
        title="Authorized pricing"
        description="Discounts, minimum prices and below-cost exceptions are checked and audited on the server."
        wide
      >
        <FormField label="Transaction discount (%)">
          <input
            inputMode="decimal"
            value={discount}
            onChange={(e) => setDiscount(e.target.value)}
          />
        </FormField>
        <FormField label="Price list">
          <select
            value={priceList}
            onChange={(e) => setPriceList(e.target.value)}
          >
            <option value="">Standard retail prices</option>
            {meta.price_lists.map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </FormField>
        {lines.map((l, i) => (
          <div className="price-override" key={i}>
            <strong>{l.product.name}</strong>
            <FormField label="Unit price">
              <input
                disabled={!actor.permissions.includes("sales.price_override")}
                value={l.unit_price ?? l.product.price}
                inputMode="decimal"
                onChange={(e) =>
                  setLines((rows) =>
                    rows.map((x, j) =>
                      i === j ? { ...x, unit_price: e.target.value } : x,
                    ),
                  )
                }
              />
            </FormField>
            <FormField label="Line discount (%)">
              <input
                value={l.discount_percent ?? "0"}
                inputMode="decimal"
                onChange={(e) =>
                  setLines((rows) =>
                    rows.map((x, j) =>
                      i === j ? { ...x, discount_percent: e.target.value } : x,
                    ),
                  )
                }
              />
            </FormField>
          </div>
        ))}
        <FormField
          label="Override reason"
          help="Required for price overrides, exceptional discounts and below-cost sales."
        >
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
          />
        </FormField>
        <div className="form-actions">
          <Button onClick={() => setPricingOpen(false)}>Apply pricing</Button>
        </div>
      </Dialog>
      <Dialog
        open={!!tracked}
        onClose={() => setTracked(null)}
        title="Select tracked inventory"
        description={tracked?.name}
      >
        {availability.error && <ErrorCard error={availability.error} />}{" "}
        {tracked?.batch_tracked && (
          <FormField label="Batch">
            <select
              value={batchId}
              onChange={(e) => setBatchId(e.target.value)}
              required
            >
              <option value="">Select an available batch</option>
              {availability.data?.batches
                ?.filter((b: any) => D(b.quantity).gt(0))
                .map((b: any) => (
                  <option key={b.id} value={b.id}>
                    {b.batch_number} · {b.quantity} available{" "}
                    {b.expiry_date ? "· exp " + b.expiry_date.slice(0, 10) : ""}
                  </option>
                ))}
            </select>
          </FormField>
        )}
        {tracked?.serial_tracked && (
          <FormField label="Serial numbers (one per line)">
            <textarea
              value={serials}
              onChange={(e) => setSerials(e.target.value)}
            />
          </FormField>
        )}
        <div className="form-actions">
          <Button
            disabled={
              (tracked?.batch_tracked && !batchId) ||
              (tracked?.serial_tracked && !serials)
            }
            onClick={() => {
              const tracking = {
                batch_id: batchId || undefined,
                serials: serials
                  .split("\n")
                  .map((v) => v.trim())
                  .filter(Boolean),
              };
              if (trackedIndex !== null)
                setLines((rows) =>
                  rows.map((l, i) =>
                    i === trackedIndex ? { ...l, ...tracking } : l,
                  ),
                );
              else addProduct(tracked, tracking);
              setTracked(null);
            }}
          >
            Add tracked item
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={!!receipt}
        onClose={() => setReceipt(null)}
        title="Sale complete"
        description="The sale, stock movements and balanced journal have been posted."
      >
        <div className="receipt-success">
          <span>
            <Check size={30} />
          </span>
          <h3>{currency(receipt?.total, meta.company.currency)}</h3>
          <p>{receipt?.number}</p>
        </div>
        <div className="receipt-preview">
          <h3>{meta.company.name}</h3>
          <p>{meta.company.address}</p>
          <hr />
          {receipt?.lines?.map((l: any) => (
            <div className="receipt-item" key={l.id}>
              <span>
                {l.quantity} × {l.description}
              </span>
              <b>{currency(l.total, meta.company.currency)}</b>
            </div>
          ))}
          <hr />
          <div className="receipt-item">
            <strong>Total</strong>
            <b>{currency(receipt?.total, meta.company.currency)}</b>
          </div>
          <p className="fiscal-notice">
            {receipt?.fiscal?.status === "successful"
              ? `Fiscal reference: ${receipt.fiscal.fiscal_id}`
              : "Not a KRA fiscal invoice. Fiscal status: " +
                (receipt?.fiscal?.status ?? "disabled")}
          </p>
        </div>
        <div className="form-actions">
          <a
            className="btn secondary"
            href={`/api/v1/sales/${receipt?.id}/receipt?thermal=true`}
            target="_blank"
            rel="noreferrer"
          >
            <Printer size={16} /> Print receipt
          </a>
          <Button
            onClick={() => {
              setReceipt(null);
              searchRef.current?.focus();
            }}
          >
            Next sale <ArrowRight size={16} />
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
