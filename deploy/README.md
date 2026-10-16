# better-auth · local server + client deployment

## Matrix + MetaMask and separate auth pages

The demo now includes a local Docker stack for Synapse and Element Web, with
Better Auth as the OIDC provider. Open `http://localhost:5173/matrix` after starting
the services. See [Matrix setup, browser login, pages, and restart commands](./matrix/README.md).
Login methods, client registration, authorization, consent, callback, profile,
token refresh/revocation, and logout each have a dedicated page.

Two small apps that deploy the `better-auth` library from this repo
(built from source: `packages/*` → `dist/`) as a real **server** + **client** pair.

## What runs

| Part | What | Port | Process |
|------|------|------|---------|
| Server | Node HTTP server exposing `better-auth` (`/api/auth/*` + `/api/me`) with a SQLite DB | **3100** | `deploy/server` |
| Client | Vite + React app using `createAuthClient` from `better-auth/react` | **5173** | `deploy/client` |
| Matrix server | Synapse with Better Auth OIDC SSO | **8008** | Docker |
| Chat client | Element Web | **8088** | Docker |

The client proxies `/api` → `http://127.0.0.1:3100` (see `client/vite.config.ts`), so the
browser sees a same-origin API and session cookies just work.

> Ports 3000/3001 are already used by the SIWE OIDC dev services — hence 3100/5173 here.

## Server (`deploy/server`)

- `src/index.ts` — creates the auth instance, runs migrations, serves HTTP.
- Auth config: email & password enabled **plus the SIWE plugin**, SQLite database at `data/auth.db`.
- Endpoints:
  - `POST /api/auth/sign-up/email` · `POST /api/auth/sign-in/email` · `POST /api/auth/sign-out`
  - `POST /api/auth/siwe/nonce` · `POST /api/auth/siwe/verify` (Sign in with Ethereum)
  - `GET  /api/auth/get-session`
  - `GET  /api/me` (reads session via `auth.api.getSession`)
  - `GET  /health`

### SIWE (Sign in with Ethereum)

Uses better-auth's `siwe` plugin (`better-auth/plugins`, docs: /docs/plugins/siwe):

- `getNonce` → `generateRandomString(32, "a-z", "A-Z", "0-9")` (better-auth/crypto)
- `verifyMessage` → viem `verifyMessage` (EIP-191 signature recovery)
- `ensLookup` → optional, viem ENS, wrapped in a 6s timeout so a slow RPC can't stall sign-in
- `anonymous: true` → no email required; wallet-only accounts
- `SIWE_DOMAIN` must equal the domain the client signs (default `localhost`)

The plugin adds a `walletAddress` table (userId, address, chainId, isPrimary).
Run once with env `SIWE_DOMAIN=localhost` and it migrates automatically at boot.

Run:

```bash
cd deploy/server
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"   # >=32 chars
PORT=3100 BETTER_AUTH_URL=http://localhost:3100 pnpm start
```

## Client (`deploy/client`)

- `src/auth-client.ts` — `createAuthClient({ baseURL: window.location.origin, plugins: [siweClient()] })`.
- `src/App.tsx` — **Sign in with Ethereum** (injected wallet: `eth_requestAccounts` →
  `siwe.nonce()` → `createSiweMessage` (viem/siwe) → `personal_sign` → `siwe.verify()`)
  plus email sign up / sign in / session view / sign out.
- Uses an injected browser wallet, or shows a MetaMask Mobile pairing QR if no extension is installed. Sign in over `http://localhost:5173`.
- Vite config sets `esbuild/optimizeDeps/build target = esnext` (the better-auth dep
  chain ships modern syntax that Vite 6's default target can't down-level).

Run:

```bash
cd deploy/client
pnpm dev            # dev server on :5173
pnpm build          # production build -> dist/
```

## Smoke test (server directly)

```bash
curl -s http://localhost:3100/health
curl -s -i -c /tmp/c.txt -X POST http://localhost:3100/api/auth/sign-up/email \
  -H 'content-type: application/json' \
  -d '{"email":"demo@example.com","password":"password123","name":"Demo"}'
curl -s -b /tmp/c.txt http://localhost:3100/api/auth/get-session
```

## Build note

Workspace packages are built from source: `pnpm install` (root) then `pnpm build`
(`turbo build --filter=./packages/*`). This produced 22 packages including
`better-auth`, `@better-auth/core`, and the adapters the deploy apps import.

## Complete authorization code demo

The server now also mounts `@better-auth/oauth-provider` and `jwt`. The browser includes
`oauthProviderClient()` so the signed authorization query follows email and SIWE login.
Use **localhost** consistently (the registered callback and login pages are fixed to
`http://localhost:5173`); these are development defaults.

```bash
# From repository root
pnpm install --frozen-lockfile
# Build workspace libraries if dist files do not exist / after library changes
pnpm build
pnpm --filter @better-auth-deploy/server start
# In a second terminal
pnpm --filter @better-auth-deploy/client dev
```

Open `http://localhost:5173/sign-in/wallet`, sign in with Ethereum, visit
`/register`, click **Register demo client**, and approve the separate wallet
signature. Continue to `/authorize` and choose **Start authorization**. The demo forces login and consent so every run
shows the flow. Log in, choose **Allow** or **Deny**, and return to `/oauth/callback`.
On approval the browser validates `state` and issuer, exchanges the code with its S256
PKCE verifier, and calls UserInfo with the access token. The `/tokens` page links to
separate profile, refresh, and revoke pages. Use **Refresh tokens** to rotate
the refresh token, or **Revoke tokens** to revoke both current tokens. Sign out is a
separate action that ends the Better Auth session.

For this HTTP loopback demo the client is registered with `application_type: "native"`
to use the provider's loopback redirect policy. A deployed browser app should register
`application_type: "web"` with its HTTPS callback on a non-loopback host. This metadata
controls redirect policy; `token_endpoint_auth_method: "none"` makes it public.

Only the public client ID is persisted. The verifier/state live in sessionStorage until
the callback; tokens stay in React memory and disappear on reload. ID tokens are issued
but are not used to establish a relying-party session; a production OIDC relying party
must validate the ID token signature, issuer, audience and applicable claims. This
sample demonstrates the authorization code grant, not every OAuth grant or client
authentication method.

Endpoints added under `/api/auth`: `/oauth2/authorize`, `/oauth2/token`,
`/oauth2/consent`, `/oauth2/userinfo`, `/oauth2/revoke`, `/jwks`, and discovery at
`/.well-known/openid-configuration`. The root RFC 8414 discovery route also reaches the
auth handler. `/api/consent-details` checks the signed, expiring authorization query
before the UI displays scopes. Client registration uses the authenticated
`/oauth2/create-client` endpoint and requires a fresh wallet approval through
`/client-registration/challenge`; unauthenticated dynamic registration is not enabled.

### External provider authorization code login (GitHub)

Create a GitHub OAuth App with homepage `http://localhost:5173` and authorization
callback `http://localhost:3100/api/auth/callback/github`. Start the server with
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` set. The **Sign in with GitHub** button
appears automatically. Secrets belong only on the server. GitHub's upstream code is
exchanged by Better Auth, creating the same session used by downstream consent and
code issuance. External login requires real provider credentials; the email/SIWE
and downstream OAuth example runs locally without them.

To use a different upstream provider, configure core `socialProviders`, or add Generic
OAuth for a provider without a built-in integration. See [plugin compatibility and
counts](./PLUGIN-COMPATIBILITY.md) for the 22 relevant plugin candidates and adaptation
requirements.

### Verification

```bash
pnpm exec vitest run --root deploy/client --config vitest.config.ts
# With the server running; creates a test account and OAuth client in its database
node deploy/server/oauth-e2e.mjs
pnpm --filter @better-auth-deploy/client exec tsc --noEmit
pnpm --filter @better-auth-deploy/client build
pnpm typecheck
```

The E2E script verifies consent denial/approval, PKCE exchange, code replay rejection,
UserInfo, refresh rotation, refresh revocation and discovery. `TEST_SERVER_URL` overrides
its default `http://localhost:3100`; `DB_PATH` lets the server use an isolated test DB.

### SIWE session refresh

The demo wraps `siweClient()` with a `/siwe/verify` session listener so wallet
verification notifies `useSession()`. It also waits for a readable cookie-backed
session before reporting login success. Session fetch errors appear in the Session
section. Use `http://localhost:5173` consistently; switching between localhost and
127.0.0.1 uses different cookies. After changing this client code, reload the browser.

With the server running, `pnpm --filter @better-auth-deploy/server exec node siwe-e2e.mjs`
checks wallet login and OAuth client registration using a throwaway wallet.

### Fresh wallet signature for every registration

Click **Register demo client** to request a two-minute challenge and sign it with
your selected browser wallet. This signature approves registration only; it is
separate from the SIWE login signature. The server binds the message to your user,
session, browser origin, linked wallet/chain, exact demo registration metadata,
and a random nonce. The challenge is consumed atomically on a verification attempt;
replay, concurrent reuse, expired proof, another session, an unlinked wallet, or
changed application details are rejected. Cancellation leaves no registered client.

The demo's `walletRegistration()` plugin validates the proof before client creation.
The OAuth Provider's `clientPrivileges` callback requires an internal approval for
that exact request. Calling `/oauth2/create-client` directly with just a session is
therefore denied; administrative creation without approval is also denied. Challenges
are stored in Better Auth's verification table, with no new database tables required.

Email/GitHub sessions may register only if the selected wallet is already linked to
that same account. SIWE login normally signs into the wallet account; it does not
automatically link a wallet to a separate email account. For this demo, sign in with
Ethereum before registration. Existing clients can still authorize email/GitHub users.

This example supports the fixed **Local PKCE demo** application metadata and uses the
same EOA signature verification as its SIWE setup. Adding other application details
requires updating the shared metadata and approval policy together.

```bash
pnpm exec vitest run --root deploy/server --config vitest.config.ts
pnpm exec vitest run --root deploy/client --config vitest.config.ts
pnpm --filter @better-auth-deploy/server exec node siwe-e2e.mjs
pnpm --filter @better-auth-deploy/server exec node oauth-e2e.mjs
```

## Client and provider design / MetaMask Mobile

The client uses a simple single-column layout with a dedicated page for each task.
It retains the purple palette and reference assets from
[signinwithethereum/oidc-client](https://github.com/signinwithethereum/oidc-client)
and [signinwithethereum/oidc-provider](https://github.com/signinwithethereum/oidc-provider).
The provider homepage is available at `http://localhost:5173/provider`; visiting
`http://localhost:3100/` redirects there. OAuth routes and security requirements remain
as described above, including explicit consent and fresh wallet approval for registration.

On `/sign-in/wallet` load, the sign-in card checks for MetaMask using injected providers and
EIP-6963 discovery. When MetaMask is absent, it automatically generates a pairing
QR embedded in the page, alongside a **Use extension** link to install MetaMask.
Install the extension and reload to use it, or open MetaMask Mobile's scanner,
scan the QR, and approve the connection. Then click **Sign in with
Ethereum** and approve the separate sign-in message on your phone. The registration
button also uses that mobile provider for its fresh registration signature.

This uses the official `@metamask/connect-evm` SDK with `headless: true`,
`preferExtension: true`, and `showInstallModal: false`. React renders the live
`display_uri` using `qrcode.react`; the SDK does not open a QR popup. When MetaMask
is installed, account access starts only after clicking **Connect MetaMask**.
A cancelled, failed, or timed-out connection clears the code and offers a new attempt.
An existing mobile wallet session is reused across requests; signing is initiated only
by clicking a sign-in or registration button. SDK analytics are disabled.

Signing out clears the cached wallet provider, address, pairing URI, and any pending
connection, and waits for the SDK session to disconnect before signing out of Better
Auth. Logout also disables automatic pairing when the login card remounts: use
**Generate a new QR code** or **Connect MetaMask** to connect again explicitly.
A tab-local logout marker also prevents restoring the wallet automatically after
refreshing that tab; an explicit connection clears the marker.
If MetaMask is unavailable or refuses revocation, Better Auth still signs out,
and the page shows a disconnection error with a retry button. Keep MetaMask open
while logging out so it can acknowledge the revocation request.
The next login starts with a fresh wallet connection. The embedded QR scales
with its card up to 400px and includes the MetaMask fox logo with high error correction.
Text sizes are increased throughout the client, login, consent, and provider pages.
Each QR request is valid for five minutes. The page automatically replaces it just
before expiry, briefly showing connection progress. Pairing transport timeouts also
start a fresh attempt after cleaning up the previous one. No refresh icon or timeout
alert is shown for these automatic renewals. Cancel and logout stop renewal; signing
in and approving registration still require explicit actions.
The fox asset is from the local MetaMask React quickstart; its MIT license is included
as `client/public/metamask-LICENSE`.

No WalletConnect project ID is required. The optional `VITE_ETH_RPC_URL` sets the
client's Ethereum mainnet RPC URL (default: `https://cloudflare-eth.com`). Internet
access to MetaMask's relay and a current MetaMask Mobile app are required for pairing.
The phone uses the relay to communicate with the desktop page; it does not have to
open the desktop's localhost URL.

Test the fallback in Chrome without the MetaMask extension. Test the extension path in
Chrome with MetaMask installed. Mobile pairing transport is covered by connection
state tests, but approving a real connection/signature on a physical phone requires
that device.

Reference artwork is in `client/public/reference/`, with the upstream MIT license
included in that directory. The original repositories retain copyright to their assets.

### MetaMask / Vite dependency resolution

The demo pins Vite's resolution of `@metamask/mobile-wallet-protocol-core` to the
package's shipped ESM entry. Its default CommonJS entry becomes a default-only
dynamic import under Vite's development optimizer, while MetaMask Connect expects
named `SessionStore` and `WebSocketTransport` exports. Without this alias, mobile
pairing can fail with `Cannot read properties of undefined (reading 'create')`.

The SDK also dynamically imports named encryption APIs from the CommonJS-only
`eciesjs` package. The `src/metamask-ecies.ts` facade exposes these APIs as ESM;
without it, pairing can subsequently fail with `PrivateKey is not a constructor`.

As in the quickstart, `@metamask/multichain-ui` is excluded from Vite's dependency
optimizer so Stencil's QR and OTP components can load their lazy imports correctly.

The pinned MetaMask packages also have persistent pnpm patches in `deploy/patches`:
`connect-evm@2.1.1` revokes the entire session rather than only EVM scopes (matching
[the upstream fix](https://github.com/MetaMask/connect-monorepo/pull/344));
`connect-multichain@1.2.0` waits for `wallet_revokeSession` acknowledgement and cache
deletion before closing the mobile relay. Failed revocations remain retryable.
Its pairing timeout also allows the five-minute QR window plus handshake grace,
and each attempt finishes removing its pending request before the next starts.
`mobile-wallet-protocol-dapp-client@0.3.0` extends the actual protocol QR expiry from
one minute to five minutes and cancels obsolete handshake listeners and timers on
disconnect, so old attempts cannot interfere with a replacement QR.
These patches are applied through `pnpm-workspace.yaml` during installation.

`src/metamask-bundle.test.ts` exercises the actual optimized SDK import and checks
both sets of exports. After changing the Vite config or SDK dependencies, restart with
`pnpm --filter @better-auth-deploy/client exec vite --force` and reload the page.
