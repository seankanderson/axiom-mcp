import { createHash, randomBytes } from 'node:crypto'
import { AxiomMcpConfig, loadConfig, saveConfig } from './config.js'

/**
 * Discovery → DCR → Authorization-Code-with-PKCE → token-exchange,
 * per the auth section of the automation enablement plan. The install command
 * runs this once interactively; the server only uses {@link refreshIfNeeded}.
 */
export interface DiscoveryDocument {
    issuer: string
    authorization_endpoint: string
    token_endpoint: string
    registration_endpoint: string
    revocation_endpoint: string
    jwks_uri: string
    scopes_supported: string[]
}

export async function discover(apiBaseUrl: string): Promise<DiscoveryDocument> {
    const url = `${apiBaseUrl.replace(/\/$/, '')}/.well-known/oauth-authorization-server`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`OAuth discovery failed: ${res.status} ${res.statusText}`)
    return await res.json() as DiscoveryDocument
}

export async function registerClient(
    registrationEndpoint: string,
    clientName: string,
    redirectUri: string,
): Promise<{ clientId: string }> {
    const res = await fetch(registrationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // RFC 7591 — snake_case members. Must match the spec so a hosted Axiom
        // also accepts non-Axiom clients identically.
        body: JSON.stringify({
            client_name: clientName,
            redirect_uris: [redirectUri],
            grant_types: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_method: 'none',
        }),
    })
    if (!res.ok) {
        throw new Error(`Dynamic client registration failed: ${res.status} ${await res.text()}`)
    }
    const json = await res.json() as { client_id: string }
    return { clientId: json.client_id }
}

export function generatePkcePair(): { verifier: string; challenge: string } {
    const verifier  = randomBytes(48).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    return { verifier, challenge }
}

export async function exchangeCode(params: {
    tokenEndpoint: string
    code: string
    redirectUri: string
    clientId: string
    codeVerifier: string
}): Promise<TokenResponse> {
    const body = new URLSearchParams({
        grant_type:    'authorization_code',
        code:          params.code,
        redirect_uri:  params.redirectUri,
        client_id:     params.clientId,
        code_verifier: params.codeVerifier,
    })
    const res = await fetch(params.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    })
    if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`)
    return await res.json() as TokenResponse
}

export async function refreshToken(params: {
    tokenEndpoint: string
    refreshToken: string
}): Promise<TokenResponse> {
    const body = new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: params.refreshToken,
    })
    const res = await fetch(params.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    })
    if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`)
    return await res.json() as TokenResponse
}

export interface TokenResponse {
    access_token:  string
    token_type:    string
    expires_in:    number
    refresh_token: string
    scope:         string
}

/**
 * Returns a valid access token, refreshing if the current one is within 60s
 * of expiry. Updates the on-disk config in place so subsequent server calls
 * see the new tokens.
 */
export async function refreshIfNeeded(cfg: AxiomMcpConfig): Promise<string> {
    const skewMs = 60_000
    if (cfg.expiresAt - skewMs > Date.now()) return cfg.accessToken

    const discovery = await discover(cfg.apiBaseUrl)
    const refreshed = await refreshToken({
        tokenEndpoint: discovery.token_endpoint,
        refreshToken: cfg.refreshToken,
    })

    const updated: AxiomMcpConfig = {
        ...cfg,
        accessToken:  refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        expiresAt:    Date.now() + refreshed.expires_in * 1000,
        scope:        refreshed.scope,
    }
    saveConfig(updated)
    return updated.accessToken
}

export async function getAuthenticatedConfig(): Promise<AxiomMcpConfig> {
    const cfg = loadConfig()
    await refreshIfNeeded(cfg)
    return loadConfig() // re-read in case refresh updated it
}
