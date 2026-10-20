# Log in to the Arena workspace preview

The workspace has a running application and restored saved PostgreSQL data. It was recovered from the encrypted preview snapshot only after the local database was absent; existing databases/passwords were not overwritten and no demo reseed was run.

Use **Use demo account** and then **Sign in to workspace**:

- Owner: `owner@duka.test`
- Manager: `manager@duka.test`
- Cashier: `cashier@duka.test`
- Shared isolated-development password: `DukaDemo2026!`

These are intentionally public sample accounts, not suitable for production. The owner has the full development business workspace; lower-privilege roles still get server-enforced restrictions.

## Embedded sign-in

An explicit `WORKSPACE_PREVIEW=true` API flag is allowed only with `DEMO_MODE=true` and a non-production API, with live payment/fiscal integrations forbidden. It uses a separate `duka_workspace_session` cookie with **HttpOnly, Secure, SameSite=None and Partitioned (CHIPS)**. This lets supported browsers retain the session inside Arena's cross-site viewer without placing bearer tokens in local storage or removing Origin/CSRF checks. Legacy ordinary cookies cannot select a different actor in this mode. Logout expires the matching partitioned cookie and revokes the session.

Production rejects this flag and retains the ordinary Secure/HttpOnly/SameSite=Lax policy. Do not enable preview auth or public sample credentials on real production data. Browsers that block all embedded storage may still require opening the workspace in a top-level tab; the UI now reports failure to restore a session instead of silently returning to sign-in.

## Stable workspace frontend

The viewer serves a dedicated standalone frontend rather than relying on development hot-reload WebSockets:

```bash
# Only an already configured isolated development/demo environment:
npm run workspace:build
# Start API in another supervised process. Do not override production NODE_ENV.
WORKSPACE_PREVIEW=true npm run dev:api
npm run workspace:web
```

The launcher refuses production/non-demo configuration. `WORKSPACE_BUILD_DIR=.cache/next-workspace-r3` (or another validated revision suffix) allows building a new version without deleting files used by the currently running preview; launch that same directory when switching versions. It uses port3000 (or `WORKSPACE_WEB_PORT`) and a separate build directory, and allows the Arena viewer plus local TLS test parents in its preview-only frame policy. The normal production build/frame policy remains separate and self-only by default. Server processes, dependency installs and OS database services can be absent after a sandbox recreation; this preview is not persistent production hosting. Preserve encrypted backups and never reseed/overwrite an existing DB to repair a login problem.

## Actual local verification

`npm run test:workspace-login` exercises real browser network traffic through local HTTPS and a genuinely cross-site sandboxed parent iframe: owner login, HttpOnly/Secure/partition key, reload/session retention and logout/cookie removal. It does not change passwords or post a sale. Local TLS certificates are test-only and cleaned up; the test bridge aliases the Origin to the existing localhost dev origin without changing the production policy. Separate HTTP tests cover default production-like cookies and rejection/ignoring of preview mode in production.

The current workspace also exposes **Accounting → Opening balances** for reviewed positive legacy AR/AP imports. Do not try this with real production balances before reading OPENING_BALANCES and completing operator/accountant acceptance. The preview remains explicitly isolated and is not a public production deployment.
