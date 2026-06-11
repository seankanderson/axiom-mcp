import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { discover } from './auth.js'
import type { RequestAuth } from './requestContext.js'

/**
 * OAuth resource-server logic for the remote connector. Validates Axiom-issued
 * RS256 access tokens against Axiom's JWKS and exposes the RFC 9728 protected-
 * resource metadata that lets MCP clients discover the authorization server.
 *
 * Axiom's authorization server already mints audience-bound tokens (the `resource`
 * indicator, RFC 8707). We require `aud === RESOURCE_URL` here, then forward the
 * same bearer to the Axiom API — which accepts it because its user-token validator
 * sets ValidateAudience=false (see axiom-api JwtService.ValidateToken).
 *
 * ⚠️  KEY ROTATION — what breaks and how to recover ⚠️
 *
 * The API signs OAuth tokens with an RSA key configured via OAuthSigningPrivateKeyPem
 * (see axiom-api/services/OAuthKeyProvider.cs). This server caches the JWKS fetched
 * from /.well-known/jwks.json at startup (see ensureKeys below). If the API's signing
 * key is rotated:
 *
 *   1. All previously-issued access tokens and refresh tokens are immediately invalid.
 *   2. This MCP server must be restarted (or redeployed) so the in-memory JWKS cache
 *      is cleared and it fetches the new public key. A running container will continue
 *      rejecting tokens signed with the new key until it restarts.
 *   3. Every MCP client (e.g. Claude) that stored tokens must re-authorize:
 *      remove the Axiom integration, re-add it, and complete the OAuth/PKCE browser flow.
 *
 * See axiom-api/app-context/authentication-and-authorization.md §OAuth Signing Key
 * for the full rotation procedure.
 */
export class RemoteAuth {
    private jwks: JWTVerifyGetKey | null = null
    private issuer: string | null = null
    private discoveryPromise: Promise<void> | null = null

    constructor(
        private readonly apiBaseUrl: string,
        /** This server's canonical MCP endpoint, e.g. https://host/mcp — the token audience. */
        private readonly resourceUrl: string,
        private readonly scopesSupported: string[],
        private readonly displayName?: string,
        private readonly logoUri?: string,
    ) {}

    /** Lazily fetch the AS metadata (issuer + jwks_uri) and build a cached JWKS. */
    private async ensureKeys(): Promise<void> {
        if (this.jwks && this.issuer) return
        if (!this.discoveryPromise) {
            this.discoveryPromise = (async () => {
                const doc = await discover(this.apiBaseUrl)
                this.issuer = doc.issuer
                this.jwks = createRemoteJWKSet(new URL(doc.jwks_uri))
            })().catch((err) => {
                this.discoveryPromise = null // allow retry on transient discovery failure
                throw err
            })
        }
        await this.discoveryPromise
    }

    /** Validates a raw bearer token. Throws if invalid/expired/wrong audience. */
    async validateBearer(token: string): Promise<RequestAuth> {
        await this.ensureKeys()
        // Accept the resource both with and without a trailing slash: now that the
        // endpoint is the subdomain root, some clients canonicalize the empty path
        // to "/", which would otherwise mint an aud that fails an exact match.
        const audiences = this.resourceUrl.endsWith('/')
            ? [this.resourceUrl, this.resourceUrl.replace(/\/$/, '')]
            : [this.resourceUrl, `${this.resourceUrl}/`]
        const { payload } = await jwtVerify(token, this.jwks!, {
            issuer: this.issuer!,
            audience: audiences,
        })
        const scope = typeof payload.scope === 'string' ? payload.scope : ''
        const companyId = typeof payload.companyId === 'string' ? payload.companyId : null
        return {
            accessToken: token,
            companyId,
            scopes: scope.split(' ').filter(Boolean),
        }
    }

    /** RFC 9728 protected-resource metadata document. */
    protectedResourceMetadata(): Record<string, unknown> {
        return {
            resource: this.resourceUrl,
            // RFC 9728: this is the AS *issuer identifier* (base URL). Clients
            // append `/.well-known/oauth-authorization-server` themselves.
            // We advertise the MCP server's own public URL here (not the API base URL)
            // so that RFC 8414 issuer-match validation passes: clients fetching
            // `/.well-known/oauth-authorization-server` from this host will receive an
            // `issuer` equal to this URL, satisfying the spec's requirement that issuer
            // == the prefix from which metadata was fetched.
            authorization_servers: [this.resourceUrl.replace(/\/$/, '')],
            scopes_supported: this.scopesSupported,
            bearer_methods_supported: ['header'],
            // Branding — Claude and other MCP clients display these in the connector list.
            ...(this.displayName && { display_name: this.displayName }),
            ...(this.logoUri     && { logo_uri:     this.logoUri }),
        }
    }
}
