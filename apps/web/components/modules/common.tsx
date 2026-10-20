"use client";
import React, { useState, useEffect } from "react";
import {
  api,
  useWorkspace,
  useQuery,
  useDebounce,
  scopedQuery,
  download,
} from "../lib";
export function useList(
  resource: string | null,
  extra: Record<string, any> = {},
) {
  const { branch } = useWorkspace();
  const [search, setSearch] = useState(""),
    [page, setPage] = useState(1);
  const debounced = useDebounce(search);
  const extras = JSON.stringify(extra);
  useEffect(() => setPage(1), [debounced, branch, extras]);
  const query = scopedQuery(
    { q: debounced, page, limit: 25, ...extra },
    branch,
  );
  const r = useQuery<any>(resource ? resource + "?" + query : null);
  return { ...r, search, setSearch, page, setPage, query };
}
export function useAction(onSuccess?: (r: any) => void | Promise<void>) {
  const { notify } = useWorkspace();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<any>(null);
  async function run(fn: () => Promise<any>, message = "Saved successfully.") {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (message) notify(message);
      await onSuccess?.(r);
      return r;
    } catch (e: any) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}
export function clean(data: any) {
  const result: any = {};
  for (const [k, v] of Object.entries(data))
    if (v !== "" && v !== undefined) result[k] = v;
  return result;
}
export async function save(resource: string, data: any, id?: string) {
  return api(resource + (id ? "/" + id : ""), {
    method: id ? "PUT" : "POST",
    body: clean(data),
  });
}
export function parseCsv(input: string) {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      if (quoted && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  if (quoted) throw new Error("Unclosed quoted CSV field");
  if (!rows.length) throw new Error("CSV is empty");
  const headers = rows.shift()!.map((h) => h.replace(/^\ufeff/, "").trim());
  if (new Set(headers).size !== headers.length)
    throw new Error("Duplicate CSV headers");
  return rows.map((values, i) => {
    if (values.length !== headers.length)
      throw new Error(`CSV row ${i + 2} has an incorrect number of fields`);
    return Object.fromEntries(headers.map((h, j) => [h, values[j].trim()]));
  });
}
