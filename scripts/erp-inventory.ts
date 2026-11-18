#!/usr/bin/env node
/**
 * Generates the ERP endpoint inventory from the ERP's own route registry.
 *
 * Usage: tsx scripts/erp-inventory.ts <path-to-erp-repo> [output.md]
 *
 * It parses apps/api/src/routes/index.ts (the file that calls `endpoint(...)`)
 * with the TypeScript compiler API, so the inventory is derived from source
 * rather than from prose. Literal values are printed verbatim; computed values
 * (loop-generated customer/supplier routes, dynamic paths) are shown as the
 * source expression and marked "computed".
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const erpRoot = process.argv[2];
if (!erpRoot) {
  console.error("usage: tsx scripts/erp-inventory.ts <erp-repo> [output.md]");
  process.exit(2);
}
const output =
  process.argv[3] ?? path.resolve("docs/ERP_ENDPOINT_INVENTORY.md");
const routesFile = path.join(erpRoot, "apps/api/src/routes/index.ts");
const source = await readFile(routesFile, "utf8");
const file = ts.createSourceFile(
  routesFile,
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

interface Row {
  method: string;
  routePath: string;
  permission: string;
  summary: string;
  computed: boolean;
}

const rows: Row[] = [];

function literal(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  return null;
}

function expression(node: ts.Node | undefined): string {
  if (!node) return "—";
  return node.getText(file).replace(/\s+/g, " ").slice(0, 160);
}

function visit(node: ts.Node) {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "endpoint" &&
    node.arguments.length >= 5
  ) {
    const [methodArg, pathArg, permissionArg, , summaryArg] = node.arguments;
    const method = literal(methodArg);
    const routePath = literal(pathArg);
    const permission = literal(permissionArg);
    const summary = literal(summaryArg);
    rows.push({
      method: (method ?? expression(methodArg)).toUpperCase(),
      routePath: routePath ?? expression(pathArg),
      permission:
        permission ??
        (permissionArg.kind === ts.SyntaxKind.Identifier &&
        permissionArg.getText(file) === "undefined"
          ? "—"
          : expression(permissionArg)),
      summary: summary ?? expression(summaryArg),
      computed: !method || !routePath,
    });
  }
  ts.forEachChild(node, visit);
}
visit(file);

const header = [
  "| Method | Path | Permission | Description |",
  "| --- | --- | --- | --- |",
];
const body = rows.map(
  (row) =>
    `| ${row.method} | \`${row.routePath}\`${row.computed ? " *(computed)*" : ""} | ${
      row.permission === "—"
        ? "authenticated / service-checked"
        : `\`${row.permission.replaceAll("|", "\\|")}\``
    } | ${row.summary.replaceAll("|", "\\|")} |`,
);

const content = `# ERP endpoint inventory (generated)

Generated from \`${routesFile}\` by \`scripts/erp-inventory.ts\`.
**${rows.length} registered \`endpoint()\` calls.**

These are the routes the ERP registers at runtime through the \`endpoint()\` helper in apps/api/src/http.ts.
All are mounted under \`/api/v1\`; \`/health/live\`, \`/health/ready\`,
\`/api/v1/openapi.json\` and \`/api/v1/docs\` live in \`apps/api/src/app.ts\`.

\`\`\`
${header.join("\n")}
${body.join("\n")}
\`\`\`
`;

await writeFile(output, content);
console.log(`wrote ${rows.length} endpoints to ${output}`);
