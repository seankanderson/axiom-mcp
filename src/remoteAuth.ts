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
        const { payload } = await jwtVerify(token, this.jwks!, {
            issuer: this.issuer!,
            audience: this.resourceUrl,
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
            authorization_servers: [
                `${this.apiBaseUrl.replace(/\/$/, '')}/.well-known/oauth-authorization-server`,
            ],
            scopes_supported: this.scopesSupported,
            bearer_methods_supported: ['header'],
        }
    }
}
