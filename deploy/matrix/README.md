# Matrix login with MetaMask

This Linux loopback demo runs **Synapse 1.163.0** and **Element Web 1.12.31** in Docker.
Better Auth runs from this workspace on port 3100; its React UI runs on port 5173.
Element's login screens use a plain local background and the demo logo.
Signed-out visitors first see a wallet welcome page at `http://localhost:8088/`.
Login starts only after clicking **Sign in with MetaMask** on that page.
The Element image adds a scoped stylesheet through `Element.Dockerfile`; the
standard HTML sanitizer and non-root runtime are preserved.

| Service | Address |
| --- | --- |
| Demo / identity provider UI | http://localhost:5173 |
| Matrix entry page | http://localhost:5173/matrix |
| Better Auth OIDC issuer | http://localhost:3100/api/auth |
| Synapse | http://localhost:8008 |
| Element Web | http://localhost:8088 |

## Start

From the repository root, with the workspace dependencies and libraries built as in
[the demo instructions](../README.md):

```sh
node deploy/matrix/setup.mjs
pnpm --filter @better-auth-deploy/server dev
```

In another terminal:

```sh
pnpm --filter @better-auth-deploy/client dev
```

Then start Matrix (Better Auth must be listening before Synapse starts):

```sh
docker compose -f deploy/matrix/compose.yaml up -d --build --wait
```

The setup command creates random OIDC credentials and Synapse secrets in the
ignored `.runtime/` directory. It preserves these, the signing key, media, and
both databases across restarts. The auth server loads the credentials at startup
and provisions the fixed **Matrix · Synapse** client. Restart the auth server if
it was already running when you first ran setup.

## Browser login

1. Open http://localhost:8088/ (or use **Open Element** at http://localhost:5173/matrix).
2. Read the wallet login information and click **Sign in with MetaMask**.
   Element then sends you to Better Auth. Choose **MetaMask**.
3. Connect the extension, or scan the embedded QR with MetaMask Mobile.
4. Click **Sign in with Ethereum** and approve the message.
5. On the separate consent page, approve **Matrix · Synapse**.
6. Synapse creates your Matrix account on first login and sends you back to Element.
   Complete Element's recovery/key setup if prompted.

An existing Better Auth login can be reused by SSO. Email sign-in is also supported.
Use `localhost` consistently. The phone connects through the MetaMask relay and
scans the desktop QR; it does not need to open a localhost web page.

You do **not** need to click **Register demo client** for Matrix. That separate
page demonstrates user-owned public OAuth client registration and still requires
a fresh, single-use wallet signature for every registration.

## Pages

| Page | Purpose |
| --- | --- |
| `/` | Choose a task |
| `/sign-in` | Choose a login method |
| `/sign-in/wallet` | MetaMask connection and SIWE login |
| `/sign-in/email` | Email login |
| `/sign-up` | Email account creation |
| `/session` | Current Better Auth identity |
| `/sign-out` | Better Auth logout and wallet disconnection |
| `/matrix` | Open Matrix chat |
| `/register` | Approve and create a demo OAuth client |
| `/authorize` | Start a PKCE authorization request |
| `/consent` | Review permissions and allow/deny |
| `/oauth/callback` | Validate callback and exchange code |
| `/tokens` | Current application access |
| `/userinfo` | Read the shared identity |
| `/tokens/refresh` | Rotate tokens |
| `/tokens/revoke` | Revoke tokens |
| `/provider` | Discovery and public signing keys |

OAuth interaction links preserve the server-signed query across login method
changes. Local navigation preserves the wallet connection and current flow's
in-memory tokens; tokens never enter localStorage or page URLs.

## How it connects

Element → Synapse SSO → Better Auth authorization code + S256 PKCE → MetaMask
SIWE signature → Better Auth consent → Synapse OIDC callback → one-use Matrix
login token → Element Matrix session.

Synapse validates the ID token signature, issuer, audience, nonce, and expiry with
Better Auth's JWKS, then fetches the wallet display name from OIDC UserInfo.
Better Auth uses RS256 for Synapse compatibility, adding a key
at startup if an older demo database contains only EdDSA keys. Old verification
keys remain available. The OIDC client secret stays server-side; Better Auth stores
its SHA-256 hash. Browser CRUD cannot edit the fixed client.

The Matrix subject is the immutable Better Auth `sub`; the localpart is
`ba_{{ user.sub | lower }}`. Changing a display name does not change account ownership.
No placeholder SIWE email is used for Matrix account mapping or verified-email linking.
Synapse automatically creates accounts for valid OIDC identities; public password
registration and password login are disabled.

This uses Synapse's classic OIDC SSO for **Element Web**. Native Matrix OAuth
clients such as Element X use a different delegated-auth setup (MAS), which is
not part of this stack. See [Synapse's OIDC guide](https://element-hq.github.io/synapse/latest/openid.html)
and [Element's configuration guide](https://github.com/element-hq/element-web/blob/develop/docs/config.md).

## Restart / stop

```sh
docker compose -f deploy/matrix/compose.yaml restart
# Stop containers, retaining accounts, media and keys:
docker compose -f deploy/matrix/compose.yaml down
# Inspect health and recent logs:
docker compose -f deploy/matrix/compose.yaml ps
docker compose -f deploy/matrix/compose.yaml logs --tail 50
```

Restart the pnpm server/client process separately when necessary. Do not delete
`.runtime/` or either auth database to restart: this would change identities or keys.
Sign out from **Element** to end a Matrix session, and from `/sign-out` to end the
Better Auth session and disconnect MetaMask. These sessions have separate lifetimes.

## Verify

With all services running:

```sh
pnpm --filter @better-auth-deploy/server exec node matrix-e2e.mjs
```

This signs with a throwaway Ethereum key and exercises real Synapse OIDC + PKCE,
consent, ID-token validation, Matrix login-token exchange, `whoami`, replay
rejection, repeat-login identity stability, and Matrix logout. It leaves one test
account but logs out its Matrix devices. It does not approve a physical MetaMask
wallet or test Element's recovery UI.
Repeated runs in quick succession can hit Synapse's normal IP login rate limit;
wait for its retry interval before running again.

## Local deployment scope

Synapse uses host networking on Linux to reach the same `localhost:3100` issuer
that the browser sees. Its client listener binds only to `127.0.0.1:8008`; Element
is published only on `127.0.0.1:8088`. It uses SQLite and federation is disabled.
Synapse's `skip_verification: true` is solely to accept the local HTTP OIDC metadata;
ID-token checks still run. For public deployment use HTTPS, correct public issuer
and callback URLs, normal metadata verification, PostgreSQL, and a stable auth
secret. Also replace the development auth secret described in the main README.
