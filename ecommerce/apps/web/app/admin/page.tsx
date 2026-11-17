"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { ActivityTab } from "@/components/admin/ActivityTab";
import { CatalogueTab } from "@/components/admin/CatalogueTab";
import { CustomersTab } from "@/components/admin/CustomersTab";
import { LoginScreen } from "@/components/admin/LoginScreen";
import { OrderSheet } from "@/components/admin/OrderSheet";
import { OrdersTab } from "@/components/admin/OrdersTab";
import { SettingsTab } from "@/components/admin/SettingsTab";
import { SyncTab } from "@/components/admin/SyncTab";
import { useToast } from "@/components/ui/Toast";
import { api, ApiError, loadIdentity } from "@/lib/api-client";
import type { OrderDetail, OrderRow, Tab } from "@/components/admin/types";

/**
 * Store desk. The page owns three things — who is signed in, which tab is
 * showing, and the single order sheet that any tab can open. Everything else
 * belongs to the tab that renders it, so each section loads only its own data.
 */
export default function AdminPage() {
  const { toast } = useToast();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [tab, setTab] = useState<Tab>("orders");
  const [refreshToken, setRefreshToken] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(true);

  const [selected, setSelected] = useState<OrderDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    try {
      const data = await api<{ items: OrderRow[] }>("/admin/orders?limit=25");
      setOrders(data.items);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        setSignedIn(false);
        return;
      }
      toast({
        title: "Could not load orders",
        description: caught instanceof ApiError ? caught.message : undefined,
        variant: "error",
      });
    } finally {
      setOrdersLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void (async () => {
      const identity = await loadIdentity();
      const isAdmin = identity?.kind === "admin";
      setSignedIn(isAdmin);
      if (isAdmin) {
        setEmail(identity?.admin?.email ?? "");
        await loadOrders();
      }
    })();
  }, [loadOrders]);

  const openOrder = useCallback(
    async (orderId: number) => {
      try {
        setSelected(await api<OrderDetail>(`/admin/orders/${orderId}`));
        setDetailOpen(true);
      } catch (caught) {
        toast({
          title: "Could not open the order",
          description: caught instanceof ApiError ? caught.message : undefined,
          variant: "error",
        });
      }
    },
    [toast],
  );

  async function reloadAfterMutation() {
    if (selected) {
      try {
        setSelected(
          await api<OrderDetail>(`/admin/orders/${selected.order_id}`),
        );
      } catch {
        /* the sheet keeps the previous view; the list refresh below still runs */
      }
    }
    await loadOrders();
  }

  async function refresh() {
    setRefreshing(true);
    setRefreshToken((token) => token + 1);
    await loadOrders();
    setRefreshing(false);
  }

  if (signedIn === null) {
    return (
      <div className="login-layout">
        <div className="login-form-panel">
          <div className="login-form-wrap">
            <div
              className="skeleton"
              style={{ width: "45%", marginBottom: 14 }}
            />
            <div className="skeleton tall" style={{ height: "5rem" }} />
          </div>
        </div>
      </div>
    );
  }

  if (!signedIn) {
    return (
      <LoginScreen
        onSignedIn={async (nextEmail) => {
          setEmail(nextEmail);
          setSignedIn(true);
          await loadOrders();
        }}
      />
    );
  }

  return (
    <>
      <AdminShell
        tab={tab}
        onTab={setTab}
        onSignOut={() => {
          void api("/auth/logout", { method: "POST" }).catch(() => {});
          setSignedIn(false);
          setSelected(null);
          setDetailOpen(false);
        }}
        onRefresh={() => void refresh()}
        refreshing={refreshing}
        email={email}
      >
        {tab === "orders" ? (
          <OrdersTab
            orders={orders}
            loading={ordersLoading}
            onOpen={(id) => void openOrder(id)}
          />
        ) : null}
        {tab === "catalogue" ? (
          <CatalogueTab refreshToken={refreshToken} />
        ) : null}
        {tab === "customers" ? (
          <CustomersTab refreshToken={refreshToken} />
        ) : null}
        {tab === "sync" ? <SyncTab refreshToken={refreshToken} /> : null}
        {tab === "activity" ? (
          <ActivityTab refreshToken={refreshToken} />
        ) : null}
        {tab === "settings" ? (
          <SettingsTab refreshToken={refreshToken} />
        ) : null}
      </AdminShell>

      {detailOpen ? (
        <OrderSheet
          order={selected}
          onClose={() => {
            setDetailOpen(false);
            setSelected(null);
          }}
          onChanged={reloadAfterMutation}
        />
      ) : null}
    </>
  );
}
