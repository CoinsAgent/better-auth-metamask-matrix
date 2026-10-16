# Plugins and authorization code flow

Scope: the plugins documented in this repository, evaluated for this sample. This is an architectural assessment, not a claim that every combination has been integration tested. Social providers such as GitHub are core configuration, not separate plugins.

**22 plugins are relevant candidates: 5 protocol/integration plugins, 9 authentication plugins, 3 account/authorization context plugins, and 5 supporting utilities.** Of those, this demo mounts 3 Better Auth server plugins: OAuth Provider, JWT, and SIWE (plus the matching OAuth Provider and SIWE browser plugins). It also mounts a demo-only `wallet-registration` plugin to require a fresh signature for each client creation. Compatibility does not mean all 22 should be enabled together.

| Category | Plugin | How it participates / required adaptation |
| --- | --- | --- |
| Protocol | OAuth Provider | Issues authorization codes, checks PKCE and redirect URIs, handles consent, token exchange, refresh, revocation, discovery and UserInfo. |
| Protocol | JWT | Signing keys/JWKS for OAuth access and OIDC ID tokens; required by the provider's default configuration. Disable the standalone `/token` endpoint. |
| Protocol | Generic OAuth | Upstream OAuth/OIDC login. Configure provider endpoints, credentials and callback. Preserve the signed authorization request across the upstream redirect; verify the integration before adding it. |
| Protocol | SSO | Enterprise upstream OIDC/OAuth login; SAML is an alternative upstream protocol, not an authorization code grant. Requires enterprise provider and tenant configuration. |
| Protocol | OAuth Proxy | Supports upstream social OAuth across preview/deployment origins; configure the production origin and trusted origins. Does not issue downstream OAuth codes. |
| Authentication | SIWE | Establishes a session with a wallet signature before consent. Included. Keep synthesized wallet emails unverified. |
| Authentication | Username | Alternative password login identifier. Login form and matching client plugin required. |
| Authentication | Phone Number | Phone verification/login; requires delivery and verification UI. |
| Authentication | Magic Link | Email link creates a session; preserve the authorization request across navigation and confirm the continuation before deployment. |
| Authentication | Email OTP | Email OTP login; requires mail delivery and OTP UI, preserving the signed query. |
| Authentication | Passkey | WebAuthn login establishes the provider session; needs registration/login UI and correct origin/RP ID. |
| Authentication | One Tap | Google One Tap establishes a session; requires Google credentials and browser integration. It is not itself a downstream code flow. |
| Authentication | Two-Factor | Adds a second authentication step. Retain the authorization request until the second factor succeeds; never exchange a code from a partially authenticated session. |
| Authentication | Anonymous | Technically creates a session, but issuing identity/access tokens for guests needs an explicit policy. Prefer account upgrade before authorization. |
| Context | Multi Session | Implements account selection through `selectAccount` and the provider continue endpoint. |
| Context | Organization | Select tenant after login via `postLogin`, set the active organization, and explicitly map tenant permissions to scopes/claims. Membership does not automatically become OAuth scopes. |
| Context | Admin | User/client administration and policies; explicitly gate privileged client management. Admin roles do not automatically authorize requested scopes. |
| Utility | Captcha | Protect selected login/registration endpoints; requires browser challenge tokens and provider keys. |
| Utility | Have I Been Pwned | Password quality check for password-based login/registration; requires its documented setup. |
| Utility | Last Login Method | Remembers the upstream login choice; does not change token issuance. |
| Utility | i18n | Localizes auth errors and flow UI. |
| Utility | Open API | Documents auth endpoints for developers; does not participate in protocol decisions. |

Not counted: Device Authorization is a separate OAuth grant; API Key and Bearer authenticate with other credentials (Bearer session tokens are not OAuth access tokens); One Time Token is another session transfer mechanism; SCIM provisions identities; CIMD changes client metadata discovery/registration; MCP is a protected-resource integration rather than an authentication step; payment, analytics, infrastructure and test utilities do not implement the code flow. They can still coexist when needed. Custom Session changes session responses, not automatically OIDC claims.

The core is `authorization request → login → consent → code → PKCE token exchange → resource call`. Additional authentication plugins belong at login; organization/account selection belongs between login and consent; scope enforcement belongs in the authorization server and protected resource.

Sources: [repository OAuth Provider documentation](../docs/content/docs/plugins/oauth-provider.mdx), [plugin catalog](../docs/content/docs/plugins/meta.json), [official plugin catalog](https://better-auth.com/docs/plugins), [SSO documentation](https://better-auth.com/docs/plugins/sso).
