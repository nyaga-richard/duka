"use client";
import React, { useState, useEffect } from "react";
import {
  Plus,
  ShieldCheck,
  Users,
  PenLine,
  Check,
  Settings2,
  Building2,
  LockKeyhole,
  KeyRound,
  Smartphone,
  LogOut,
  RefreshCw,
  ScrollText,
  AlertTriangle,
} from "lucide-react";
import { api, useWorkspace, currency, dateText, D, useQuery } from "../lib";
import {
  Button,
  Badge,
  PageHeading,
  DataTable,
  Pagination,
  SearchBox,
  Dialog,
  ErrorCard,
  Fields,
  FormField,
  type FieldDef,
} from "../ui";
import { useList, useAction, clean } from "./common";
export function TeamPage() {
  const { meta, actor, reloadMeta } = useWorkspace(),
    list = useList("/users");
  const [tab, setTab] = useState("users"),
    [mode, setMode] = useState(""),
    [target, setTarget] = useState<any>(null),
    [form, setForm] = useState<any>({}),
    [roleIds, setRoleIds] = useState<string[]>([]),
    [branchIds, setBranchIds] = useState<string[]>([]),
    [warehouseIds, setWarehouseIds] = useState<string[]>([]),
    [perms, setPerms] = useState<string[]>([]);
  const action = useAction(async () => {
    setMode("");
    list.refresh();
    await reloadMeta();
  });
  const toggle = (values: string[], id: string) =>
    values.includes(id) ? values.filter((v) => v !== id) : [...values, id];
  function newUser() {
    setTarget(null);
    setForm({
      name: "",
      email: "",
      password: "",
      status: "active",
      reason: "",
    });
    setRoleIds(
      [meta.roles.find((r: any) => r.name === "Cashier")?.id].filter(Boolean),
    );
    setBranchIds([meta.branches[0]?.id].filter(Boolean));
    setWarehouseIds([meta.warehouses[0]?.id].filter(Boolean));
    action.setError(null);
    setMode("user");
  }
  function editUser(u: any) {
    setTarget(u);
    setForm({ status: u.status, reason: "" });
    setRoleIds(u.role_ids);
    setBranchIds(u.branch_ids);
    setWarehouseIds(u.warehouse_ids);
    action.setError(null);
    setMode("access");
  }
  function editRole(r?: any) {
    setTarget(r ?? null);
    setForm({
      name: r?.name ?? "",
      description: r?.description ?? "",
      approval_limit: r?.approval_limit ?? "0",
    });
    setPerms(r?.permissions ?? []);
    action.setError(null);
    setMode("role");
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await action.run(
      () =>
        mode === "role"
          ? api("/roles" + (target ? "/" + target.id : ""), {
              method: target ? "PUT" : "POST",
              body: { ...form, permissions: perms },
            })
          : mode === "user"
            ? api("/users", {
                method: "POST",
                body: {
                  name: form.name,
                  email: form.email,
                  password: form.password,
                  role_ids: roleIds,
                  branch_ids: branchIds,
                  warehouse_ids: warehouseIds,
                },
              })
            : api("/users/" + target.id + "/access", {
                method: "POST",
                body: {
                  status: form.status,
                  reason: form.reason,
                  role_ids: roleIds,
                  branch_ids: branchIds,
                  warehouse_ids: warehouseIds,
                },
              }),
      "Access configuration saved and audited.",
    );
  }
  return (
    <>
      <PageHeading
        eyebrow="PEOPLE & PERMISSIONS"
        title="Team & access"
        description="The right access, in the right place. Roles are configurable, never just frontend labels."
      >
        <Button variant="secondary" onClick={() => editRole()}>
          <ShieldCheck size={16} /> Create role
        </Button>
        <Button onClick={newUser}>
          <Plus size={17} /> Add team member
        </Button>
      </PageHeading>
      <div className="page-tabs">
        <button
          className={tab === "users" ? "active" : ""}
          onClick={() => setTab("users")}
        >
          Team members
        </button>
        <button
          className={tab === "roles" ? "active" : ""}
          onClick={() => setTab("roles")}
        >
          Roles & permissions
        </button>
      </div>
      <section className="card">
        <div className="table-toolbar">
          <SearchBox value={list.search} onChange={list.setSearch} />
          <span className="muted">
            Permissions are checked on every protected backend operation.
          </span>
        </div>
        {list.error && <ErrorCard error={list.error} />}
        <DataTable
          items={tab === "users" ? list.data?.items : meta.roles}
          loading={tab === "users" && list.loading}
          columns={
            tab === "users"
              ? [
                  {
                    key: "name",
                    title: "Team member",
                    render: (r) => (
                      <div className="customer-cell">
                        <span className="mini-avatar">{r.name[0]}</span>
                        <div>
                          <strong>{r.name}</strong>
                          <small>{r.email}</small>
                        </div>
                      </div>
                    ),
                  },
                  {
                    key: "roles",
                    title: "Roles",
                    render: (r) => r.roles.join(", "),
                  },
                  {
                    key: "branch_ids",
                    title: "Access",
                    render: (r) =>
                      `${r.branch_ids.length} branches · ${r.warehouse_ids.length} warehouses`,
                  },
                  {
                    key: "mfa_enabled",
                    title: "MFA",
                    render: (r) => (
                      <Badge status={r.mfa_enabled ? "active" : "neutral"}>
                        {r.mfa_enabled ? "Enabled" : "Not enabled"}
                      </Badge>
                    ),
                  },
                  {
                    key: "status",
                    title: "State",
                    render: (r) => <Badge status={r.status}>{r.status}</Badge>,
                  },
                  {
                    key: "edit",
                    title: "",
                    render: (r) =>
                      r.id !== actor.id ? (
                        <button
                          className="icon-btn"
                          aria-label={"Edit access for " + r.name}
                          onClick={() => editUser(r)}
                        >
                          <PenLine size={16} />
                        </button>
                      ) : (
                        <small className="muted">You</small>
                      ),
                  },
                ]
              : [
                  { key: "name", title: "Role" },
                  { key: "description", title: "Description" },
                  {
                    key: "approval_limit",
                    title: "Approval limit",
                    align: "right",
                    render: (r) =>
                      currency(r.approval_limit, meta.company.currency),
                  },
                  {
                    key: "permissions",
                    title: "Permissions",
                    render: (r) => r.permissions.length + " permissions",
                  },
                  {
                    key: "edit",
                    title: "",
                    render: (r) => (
                      <Button variant="ghost" onClick={() => editRole(r)}>
                        <PenLine size={15} /> Configure
                      </Button>
                    ),
                  },
                ]
          }
        />
        {tab === "users" && (
          <Pagination
            page={list.page}
            total={list.data?.total ?? 0}
            onChange={list.setPage}
          />
        )}
      </section>
      <Dialog
        open={!!mode}
        onClose={() => setMode("")}
        title={
          mode === "role"
            ? target
              ? "Configure role"
              : "Create role"
            : mode === "access"
              ? "Change team member access"
              : "Add team member"
        }
        description="You cannot delegate permissions or approval limits you do not hold. Role changes take effect on the next server request."
        wide
      >
        <form onSubmit={submit}>
          {action.error && <ErrorCard error={action.error} />}
          <Fields
            fields={
              mode === "role"
                ? [
                    { key: "name", label: "Role name", required: true },
                    {
                      key: "approval_limit",
                      label: "Maximum approval amount",
                      type: "number",
                      required: true,
                    },
                    {
                      key: "description",
                      label: "Description",
                      type: "textarea",
                      full: true,
                    },
                  ]
                : mode === "user"
                  ? [
                      { key: "name", label: "Full name", required: true },
                      {
                        key: "email",
                        label: "Email / login",
                        type: "email",
                        required: true,
                      },
                      {
                        key: "password",
                        label:
                          "Initial password (12+ characters with letters and numbers)",
                        type: "password",
                        required: true,
                        full: true,
                      },
                    ]
                  : [
                      {
                        key: "status",
                        label: "Account state",
                        type: "select",
                        options: ["active", "suspended", "inactive"].map(
                          (id) => ({ id, name: id }),
                        ),
                        required: true,
                      },
                      {
                        key: "reason",
                        label: "Reason for access change",
                        type: "textarea",
                        required: true,
                        full: true,
                      },
                    ]
            }
            value={form}
            onChange={setForm}
          />
          {mode === "role" ? (
            <div className="permission-grid">
              {meta.permissions.map((p: string) => (
                <label className="inline-check" key={p}>
                  <input
                    type="checkbox"
                    checked={perms.includes(p)}
                    onChange={() => setPerms(toggle(perms, p))}
                  />
                  <code>{p}</code>
                </label>
              ))}
            </div>
          ) : (
            <>
              <h3 className="subheading">Assigned roles</h3>
              <div className="permission-grid">
                {meta.roles.map((r: any) => (
                  <label className="inline-check" key={r.id}>
                    <input
                      type="checkbox"
                      checked={roleIds.includes(r.id)}
                      onChange={() => setRoleIds(toggle(roleIds, r.id))}
                    />
                    {r.name}
                  </label>
                ))}
              </div>
              <h3 className="subheading">Branch access</h3>
              <div className="permission-grid">
                {meta.branches.map((b: any) => (
                  <label className="inline-check" key={b.id}>
                    <input
                      type="checkbox"
                      checked={branchIds.includes(b.id)}
                      onChange={() => setBranchIds(toggle(branchIds, b.id))}
                    />
                    {b.name}
                  </label>
                ))}
              </div>
              <h3 className="subheading">Warehouse access</h3>
              <div className="permission-grid">
                {meta.warehouses.map((w: any) => (
                  <label className="inline-check" key={w.id}>
                    <input
                      type="checkbox"
                      checked={warehouseIds.includes(w.id)}
                      onChange={() =>
                        setWarehouseIds(toggle(warehouseIds, w.id))
                      }
                    />
                    {w.name}
                  </label>
                ))}
              </div>
            </>
          )}
          <div className="form-actions">
            <Button
              variant="secondary"
              type="button"
              onClick={() => setMode("")}
            >
              Cancel
            </Button>
            <Button busy={action.busy} type="submit">
              Save access configuration
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
const masterLabels: Record<string, string> = {
  branches: "Branches",
  warehouses: "Warehouses",
  registers: "Registers",
  categories: "Product categories",
  units: "Units of measure",
  "price-lists": "Price lists",
  "tax-rules": "Versioned tax rules",
  "expense-categories": "Expense categories",
  "payment-methods": "Payment methods",
};
export function SettingsPage({
  profileOnly = false,
}: {
  profileOnly?: boolean;
}) {
  const { meta, actor, reloadMeta, notify, signOut } = useWorkspace();
  const [tab, setTab] = useState(profileOnly ? "security" : "business"),
    [company, setCompany] = useState<any>({}),
    [mode, setMode] = useState(""),
    [form, setForm] = useState<any>({}),
    [mfa, setMfa] = useState<any>(null);
  const sessions = useQuery<any>(tab === "security" ? "/auth/sessions" : null);
  const action = useAction(async () => {
    await reloadMeta();
    if (!mode.startsWith("mfa")) setMode("");
    sessions.refresh();
  });
  useEffect(() => {
    const c = meta.company;
    setCompany({
      name: c.name,
      currency: c.currency.trim(),
      timezone: c.timezone,
      tax_pin: c.tax_pin ?? "",
      address: c.address ?? "",
      phone: c.phone ?? "",
      email: c.email ?? "",
      settings: {
        receiptFooter: c.settings.receiptFooter ?? "",
        returnPolicy: c.settings.returnPolicy ?? "",
        receiptWidth: c.settings.receiptWidth ?? 80,
        allowCredit: c.settings.allowCredit ?? true,
        maxDiscountPercent: c.settings.maxDiscountPercent ?? "10",
        overDeliveryPercent: c.settings.overDeliveryPercent ?? "0",
        allowSelfApproval: c.settings.allowSelfApproval ?? false,
        allowBackorders: c.settings.allowBackorders ?? false,
        fiscalRequired: c.settings.fiscalRequired ?? false,
        dateFormat: c.settings.dateFormat ?? "dd/MM/yyyy",
      },
    });
  }, [meta]);
  const masterFields: Record<string, FieldDef[]> = {
    branches: [
      { key: "name", label: "Branch name", required: true },
      { key: "code", label: "Unique code (uppercase)", required: true },
      { key: "address", label: "Address", full: true },
    ],
    warehouses: [
      { key: "name", label: "Warehouse name", required: true },
      { key: "code", label: "Unique code (uppercase)", required: true },
      {
        key: "branch_id",
        label: "Branch",
        type: "select",
        options: meta.branches,
        required: true,
      },
    ],
    registers: [
      { key: "name", label: "Register name", required: true },
      {
        key: "branch_id",
        label: "Branch",
        type: "select",
        options: meta.branches,
        required: true,
      },
      {
        key: "warehouse_id",
        label: "Stock location",
        type: "select",
        options: meta.warehouses,
        required: true,
      },
    ],
    categories: [
      { key: "name", label: "Category name", required: true },
      {
        key: "parent_id",
        label: "Parent category (optional)",
        type: "select",
        options: meta.categories,
      },
    ],
    units: [
      { key: "name", label: "Unit name", required: true },
      { key: "symbol", label: "Symbol", required: true },
      {
        key: "fractional",
        label: "Fractional quantities allowed",
        type: "checkbox",
      },
    ],
    "price-lists": [{ key: "name", label: "Price list name", required: true }],
    "tax-rules": [
      { key: "name", label: "Tax name", required: true },
      { key: "code", label: "Tax code", required: true },
      {
        key: "rate",
        label: "Rate (%)",
        type: "number",
        max: "100",
        step: "0.000001",
        required: true,
      },
      {
        key: "kind",
        label: "Tax treatment",
        type: "select",
        required: true,
        options: ["standard", "zero", "exempt", "non_taxable"].map((id) => ({
          id,
          name: id,
        })),
      },
      {
        key: "version",
        label: "Version number",
        type: "number",
        step: "1",
        min: "1",
        required: true,
      },
      {
        key: "valid_from",
        label: "Effective from",
        type: "date",
        required: true,
      },
      { key: "valid_to", label: "Valid until (optional)", type: "date" },
    ],
    "expense-categories": [
      { key: "name", label: "Category name", required: true },
      {
        key: "account_id",
        label: "Expense account",
        type: "select",
        options: meta.accounts?.filter((a: any) => a.type === "expense"),
        required: true,
      },
    ],
    "payment-methods": [
      { key: "name", label: "Method name", required: true },
      {
        key: "kind",
        label: "Type",
        type: "select",
        options: ["cash", "mpesa", "bank", "card", "cheque", "other"].map(
          (id) => ({ id, name: id }),
        ),
        required: true,
      },
      {
        key: "account_id",
        label: "Settlement account",
        type: "select",
        options: meta.accounts?.filter((a: any) => a.type === "asset"),
        required: true,
      },
      {
        key: "requires_reference",
        label: "Payment reference required",
        type: "checkbox",
      },
    ],
  };
  const masterData: Record<string, any[]> = {
    branches: meta.branches,
    warehouses: meta.warehouses,
    registers: meta.registers,
    categories: meta.categories,
    units: meta.units,
    "price-lists": meta.price_lists,
    "tax-rules": meta.tax_rules,
    "expense-categories": meta.expense_categories,
    "payment-methods": meta.payment_methods,
  };
  async function configure(e: React.FormEvent) {
    e.preventDefault();
    await action.run(
      () =>
        api("/settings/" + mode, {
          method: "POST",
          body: clean({
            ...form,
            ...(mode === "tax-rules" ? { version: Number(form.version) } : {}),
          }),
        }),
      "Configuration added.",
    );
  }
  return (
    <>
      <PageHeading
        eyebrow={profileOnly ? "YOUR ACCOUNT" : "ADMINISTRATION"}
        title={profileOnly ? "Account & security" : "Business settings"}
        description={
          profileOnly
            ? "Manage your password, authenticator and active sessions."
            : "Your organization, catalog rules, tax settings and operating controls."
        }
      />
      <div className="page-tabs">
        {(profileOnly
          ? ["security"]
          : [
              "business",
              "organization",
              "catalog",
              "tax",
              "payments",
              "security",
            ]
        ).map((id) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {id[0].toUpperCase() + id.slice(1)}
          </button>
        ))}
      </div>
      {tab === "business" && (
        <section className="card settings-card">
          <div className="card-heading">
            <div>
              <h2>Business profile & safe operating controls</h2>
              <p>
                Changing controls is audited. Currency cannot change after the
                first ledger posting.
              </p>
            </div>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              action.run(
                () =>
                  api("/settings/company", { method: "PUT", body: company }),
                "Business settings saved.",
              );
            }}
          >
            {action.error && <ErrorCard error={action.error} />}
            <Fields
              fields={[
                {
                  key: "name",
                  label: "Business name",
                  required: true,
                  full: true,
                },
                {
                  key: "currency",
                  label: "Ledger currency (ISO code)",
                  required: true,
                },
                { key: "timezone", label: "IANA timezone", required: true },
                { key: "tax_pin", label: "Tax PIN" },
                { key: "phone", label: "Business phone" },
                { key: "email", label: "Business email", type: "email" },
                {
                  key: "address",
                  label: "Business address",
                  type: "textarea",
                  full: true,
                },
              ]}
              value={company}
              onChange={setCompany}
            />
            <h3 className="subheading">Receipt & invoice presentation</h3>
            <Fields
              fields={[
                {
                  key: "receiptFooter",
                  label: "Receipt footer",
                  type: "textarea",
                  full: true,
                },
                {
                  key: "returnPolicy",
                  label: "Return policy",
                  type: "textarea",
                  full: true,
                },
                {
                  key: "receiptWidth",
                  label: "Thermal width",
                  type: "select",
                  options: [
                    { id: "58", name: "58 mm" },
                    { id: "80", name: "80 mm" },
                  ],
                },
                {
                  key: "dateFormat",
                  label: "Date format",
                  type: "select",
                  options: [
                    { id: "dd/MM/yyyy", name: "Day / month / year" },
                    { id: "yyyy-MM-dd", name: "Year-month-day" },
                  ],
                },
                {
                  key: "maxDiscountPercent",
                  label: "Standard maximum discount (%)",
                  type: "number",
                  max: "100",
                },
                {
                  key: "overDeliveryPercent",
                  label: "Authorized over-delivery tolerance (%)",
                  type: "number",
                  max: "100",
                },
                {
                  key: "allowCredit",
                  label: "Enable customer credit sales",
                  type: "checkbox",
                },
                {
                  key: "allowBackorders",
                  label: "Allow unreserved backorders",
                  type: "checkbox",
                },
                {
                  key: "allowSelfApproval",
                  label: "Allow explicit self-approval (reason required)",
                  type: "checkbox",
                },
                {
                  key: "fiscalRequired",
                  label: "Require configured certified fiscal adapter",
                  type: "checkbox",
                },
              ]}
              value={company.settings ?? {}}
              onChange={(s) =>
                setCompany({
                  ...company,
                  settings: { ...s, receiptWidth: Number(s.receiptWidth) },
                })
              }
            />
            <div className="warning-box">
              <ShieldCheck size={19} />
              <p>
                Physical negative stock is always blocked in this release.
                Below-cost, minimum-price and exceptional discount overrides
                require permissions and a reason. Self-approval is off by
                default; enable it only after assessing segregation-of-duties
                risks.
              </p>
            </div>
            <div className="form-actions">
              <Button busy={action.busy} type="submit">
                Save business settings
              </Button>
            </div>
          </form>
        </section>
      )}
      {["organization", "catalog", "tax", "payments"].includes(tab) && (
        <>
          {tab === "tax" && (
            <div className="warning-box">
              <AlertTriangle size={20} />
              <p>
                Tax rules are versioned and configurable. Demo rates are test
                data, not legal advice. A normal PDF receipt is not a KRA fiscal
                invoice; certified OSCU/VSCU onboarding remains a separate
                requirement.
              </p>
            </div>
          )}
          {(tab === "organization"
            ? ["branches", "warehouses", "registers"]
            : tab === "catalog"
              ? ["categories", "units", "price-lists", "expense-categories"]
              : tab === "tax"
                ? ["tax-rules"]
                : ["payment-methods"]
          ).map((key) => (
            <section className="card master-card" key={key}>
              <div className="card-heading">
                <div>
                  <h2>{masterLabels[key]}</h2>
                  <p>
                    {key === "tax-rules"
                      ? "Create a new version rather than rewriting history. Assign the new tax category to affected products."
                      : key === "price-lists"
                        ? "Set per-product quantity tiers from the Products screen."
                        : "Shared, tenant-isolated configuration."}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setMode(key);
                    action.setError(null);
                    setForm(
                      key === "tax-rules"
                        ? {
                            name: "",
                            code: "",
                            rate: "0",
                            kind: "standard",
                            version: "1",
                            valid_from: new Date().toLocaleDateString("en-CA"),
                          }
                        : key === "units"
                          ? { fractional: false }
                          : key === "payment-methods"
                            ? { kind: "other", requires_reference: true }
                            : {},
                    );
                  }}
                >
                  <Plus size={16} /> Add
                </Button>
              </div>
              <DataTable
                items={masterData[key] ?? []}
                columns={[
                  { key: "name", title: "Name" },
                  ...(key === "tax-rules"
                    ? [
                        { key: "code", title: "Code" },
                        { key: "rate", title: "Rate (%)" },
                        { key: "kind", title: "Treatment" },
                        { key: "version", title: "Version" },
                        {
                          key: "valid_from",
                          title: "Effective",
                          render: (r: any) => dateText(r.valid_from),
                        },
                      ]
                    : key === "payment-methods"
                      ? [
                          { key: "kind", title: "Method type" },
                          {
                            key: "requires_reference",
                            title: "Reference required",
                            render: (r: any) =>
                              r.requires_reference ? "Yes" : "No",
                          },
                        ]
                      : key === "units"
                        ? [
                            { key: "symbol", title: "Symbol" },
                            {
                              key: "fractional",
                              title: "Fractional",
                              render: (r: any) =>
                                r.fractional ? "Allowed" : "Whole only",
                            },
                          ]
                        : [{ key: "code", title: "Code / reference" }]),
                ]}
              />
            </section>
          ))}
        </>
      )}
      {tab === "security" && (
        <>
          <section className="card settings-card">
            <div className="card-heading">
              <div>
                <h2>Keep your account secure</h2>
                <p>
                  Passwords use Argon2id. Session tokens are stored as hashes,
                  never in browser local storage.
                </p>
              </div>
              <LockKeyhole size={22} />
            </div>
            <div className="security-actions">
              <div>
                <KeyRound size={24} />
                <div>
                  <h3>Change password</h3>
                  <p>All existing sessions are revoked after a change.</p>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setMode("password");
                    setForm({ current_password: "", new_password: "" });
                    action.setError(null);
                  }}
                >
                  Change password
                </Button>
              </div>
              <div>
                <Smartphone size={24} />
                <div>
                  <h3>Authenticator-based MFA</h3>
                  <p>
                    Time-based codes with replay protection. Secrets are
                    encrypted at rest.
                  </p>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setMode("mfa-setup");
                    setMfa(null);
                    setForm({ password: "" });
                    action.setError(null);
                  }}
                >
                  Set up MFA
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setMode("mfa-disable");
                    setForm({ password: "", code: "" });
                    action.setError(null);
                  }}
                >
                  Disable
                </Button>
              </div>
            </div>
          </section>
          <section className="card master-card">
            <div className="card-heading">
              <div>
                <h2>Your sessions</h2>
                <p>Revoke sessions you no longer recognize.</p>
              </div>
              <Button variant="ghost" onClick={sessions.refresh}>
                <RefreshCw size={16} /> Refresh
              </Button>
            </div>
            {sessions.error && <ErrorCard error={sessions.error} />}
            <DataTable
              items={sessions.data?.items}
              columns={[
                {
                  key: "created_at",
                  title: "Created",
                  render: (r) => dateText(r.created_at, true),
                },
                {
                  key: "expires_at",
                  title: "Expires",
                  render: (r) => dateText(r.expires_at, true),
                },
                { key: "ip", title: "IP address" },
                { key: "user_agent", title: "Device" },
                {
                  key: "revoked_at",
                  title: "State",
                  render: (r) => (
                    <Badge status={r.revoked_at ? "inactive" : "active"}>
                      {r.revoked_at
                        ? "Revoked"
                        : r.id === actor.session_id
                          ? "This session"
                          : "Active"}
                    </Badge>
                  ),
                },
                {
                  key: "revoke",
                  title: "",
                  render: (r) =>
                    !r.revoked_at && r.id !== actor.session_id ? (
                      <Button
                        variant="ghost"
                        onClick={() =>
                          action.run(
                            () =>
                              api("/auth/sessions/" + r.id + "/revoke", {
                                method: "POST",
                                body: {},
                              }),
                            "Session revoked.",
                          )
                        }
                      >
                        Revoke
                      </Button>
                    ) : null,
                },
              ]}
            />
          </section>
        </>
      )}
      <Dialog
        open={!!mode}
        onClose={() => setMode("")}
        title={
          mode === "password"
            ? "Change your password"
            : mode === "mfa-setup"
              ? "Set up your authenticator"
              : mode === "mfa-disable"
                ? "Disable authenticator MFA"
                : "Add " + (masterLabels[mode] ?? "configuration")
        }
        wide={!!masterLabels[mode]}
      >
        {masterLabels[mode] ? (
          <form onSubmit={configure}>
            {action.error && <ErrorCard error={action.error} />}
            <Fields
              fields={masterFields[mode]}
              value={form}
              onChange={setForm}
            />
            <div className="form-actions">
              <Button busy={action.busy} type="submit">
                Add configuration
              </Button>
            </div>
          </form>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              action.setError(null);
              if (mode === "password") {
                const r = await action.run(
                  () =>
                    api("/auth/change-password", {
                      method: "POST",
                      body: form,
                    }),
                  "Password changed. Sign in again.",
                );
                if (r) signOut();
              } else if (mode === "mfa-setup") {
                if (!mfa) {
                  const r = await action.run(
                    () =>
                      api("/auth/mfa/setup", {
                        method: "POST",
                        body: { password: form.password },
                      }),
                    "Authenticator secret generated.",
                  );
                  if (r) {
                    setMfa(r);
                    setForm({ code: "" });
                  }
                } else {
                  const r = await action.run(
                    () =>
                      api("/auth/mfa/enable", {
                        method: "POST",
                        body: { code: form.code },
                      }),
                    "MFA enabled.",
                  );
                  if (r) setMode("");
                }
              } else {
                const r = await action.run(
                  () =>
                    api("/auth/mfa/disable", { method: "POST", body: form }),
                  "MFA disabled.",
                );
                if (r) setMode("");
              }
            }}
          >
            {action.error && <ErrorCard error={action.error} />}{" "}
            {mfa && mode === "mfa-setup" && (
              <div className="mfa-secret">
                <strong>Save this secret in your authenticator app.</strong>
                <code>{mfa.secret}</code>
                <small>{mfa.uri}</small>
                <p>
                  This secret is shown only for enrollment. Do not share it.
                  Confirm the next six-digit code below.
                </p>
              </div>
            )}
            <Fields
              fields={
                mode === "password"
                  ? [
                      {
                        key: "current_password",
                        label: "Current password",
                        type: "password",
                        required: true,
                      },
                      {
                        key: "new_password",
                        label:
                          "New password — 12+ characters, letters and numbers",
                        type: "password",
                        required: true,
                      },
                    ]
                  : mode === "mfa-setup"
                    ? mfa
                      ? [
                          {
                            key: "code",
                            label: "Six-digit authenticator code",
                            required: true,
                          },
                        ]
                      : [
                          {
                            key: "password",
                            label: "Current password",
                            type: "password",
                            required: true,
                          },
                        ]
                    : [
                        {
                          key: "password",
                          label: "Current password",
                          type: "password",
                          required: true,
                        },
                        {
                          key: "code",
                          label: "Current authenticator code",
                          required: true,
                        },
                      ]
              }
              value={form}
              onChange={setForm}
            />
            <div className="form-actions">
              <Button busy={action.busy} type="submit">
                {mode === "password"
                  ? "Change password"
                  : mode === "mfa-setup"
                    ? mfa
                      ? "Confirm & enable MFA"
                      : "Generate authenticator secret"
                    : "Disable MFA"}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}
export function AuditPage() {
  const list = useList("/audit");
  const [detail, setDetail] = useState<any>(null);
  return (
    <>
      <PageHeading
        eyebrow="ACCOUNTABILITY"
        title="Audit trail"
        description="Who did what, when and why. Append-only records, scoped to your assigned branches."
      />
      <section className="card">
        <div className="table-toolbar">
          <SearchBox
            value={list.search}
            onChange={list.setSearch}
            placeholder="Search actor, action or entity…"
          />
          <Badge>Immutable history</Badge>
        </div>
        {list.error && <ErrorCard error={list.error} />}
        <DataTable
          items={list.data?.items}
          loading={list.loading}
          onRow={setDetail}
          columns={[
            {
              key: "created_at",
              title: "Timestamp",
              render: (r) => dateText(r.created_at, true),
            },
            { key: "actor", title: "Actor" },
            {
              key: "action",
              title: "Action",
              render: (r) => <code>{r.action}</code>,
            },
            { key: "entity", title: "Entity" },
            {
              key: "record_id",
              title: "Record",
              render: (r) => <code>{r.record_id?.slice(0, 8) ?? "—"}</code>,
            },
            { key: "reason", title: "Reason" },
          ]}
        />
        <Pagination
          page={list.page}
          total={list.data?.total ?? 0}
          onChange={list.setPage}
        />
      </section>
      <Dialog
        open={!!detail}
        onClose={() => setDetail(null)}
        title="Audit event"
        description={
          detail
            ? `${detail.actor} · ${detail.action} · ${dateText(detail.created_at, true)}`
            : ""
        }
        wide
      >
        <div className="audit-values">
          <section>
            <h3>Before</h3>
            <pre>
              {JSON.stringify(detail?.before_value, null, 2) ??
                "No prior value"}
            </pre>
          </section>
          <section>
            <h3>After</h3>
            <pre>
              {JSON.stringify(detail?.after_value, null, 2) ??
                "No replacement value"}
            </pre>
          </section>
        </div>
        <p className="form-note">
          Record {detail?.record_id} · Request {detail?.correlation_id}
        </p>
        {detail?.reason && (
          <div className="warning-box">
            <ScrollText size={19} />
            <p>{detail.reason}</p>
          </div>
        )}
      </Dialog>
    </>
  );
}
