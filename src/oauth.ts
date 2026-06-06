import { createServer } from 'node:http'
import { exec } from 'node:child_process'
import { platform } from 'node:os'
import { randomBytes } from 'node:crypto'
import {
    discover,
    registerClient,
    exchangeCode,
    generatePkcePair,
    refreshIfNeeded,
} from './auth.js'
import {
    AxiomMcpConfig,
    configExists,
    loadConfig,
    saveConfig,
    configPath,
} from './config.js'

const DEFAULT_API_URL = 'http://localhost:8200/api'
const DEFAULT_SCOPES =
    'read:ledger read:invoices read:contacts read:reports read:bank-transactions offline_access'

/** Loopback OAuth wait timeout — long enough for the user to approve in their browser. */
const AUTH_TIMEOUT_MS = 5 * 60_000

export interface OAuthOptions {
    apiBaseUrl?: string
    scopes?: string
    /** Where to send progress lines. Defaults to stderr (safe for stdio MCP). */
    log?: (line: string) => void
}

/**
 * Drives the full discovery → DCR → PKCE → token-exchange flow against an Axiom
 * deployment and persists the resulting tokens to {@link configPath}. Returns the
 * saved config. Used by both the standalone `install` command and the server's
 * lazy bootstrap (so a drag-and-drop .mcpb install authorizes on first use).
 */
export async function runInteractiveOAuth(opts: OAuthOptions = {}): Promise<AxiomMcpConfig> {
    const log = opts.log ?? ((line: string) => console.error(line))
    const apiBaseUrl = opts.apiBaseUrl ?? process.env.AXIOM_API_URL ?? DEFAULT_API_URL
    const scopes = opts.scopes ?? process.env.AXIOM_SCOPES ?? DEFAULT_SCOPES

    log(`Axiom MCP — authorizing against API at ${apiBaseUrl}`)

    const discovery = await discover(apiBaseUrl)

    // Pick a free port on loopback for the redirect listener.
    const { port, server, code, state } = await startLoopbackListener()
    const redirectUri = `http://127.0.0.1:${port}/callback`

    try {
        const { clientId } = await registerClient(
            discovery.registration_endpoint,
            'Axiom MCP (this machine)',
            redirectUri,
        )

        const { verifier, challenge } = generatePkcePair()
        const resource = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`

        const authorizeUrl = new URL(discovery.authorization_endpoint)
        authorizeUrl.searchParams.set('response_type', 'code')
        authorizeUrl.searchParams.set('client_id', clientId)
        authorizeUrl.searchParams.set('redirect_uri', redirectUri)
        authorizeUrl.searchParams.set('code_challenge', challenge)
        authorizeUrl.searchParams.set('code_challenge_method', 'S256')
        authorizeUrl.searchParams.set('scope', scopes)
        authorizeUrl.searchParams.set('state', state)
        authorizeUrl.searchParams.set('resource', resource)

        log(`Opening browser to authorize: ${authorizeUrl}`)
        openInBrowser(authorizeUrl.toString())

        const callbackCode = await code

        const tokens = await exchangeCode({
            tokenEndpoint: discovery.token_endpoint,
            code: callbackCode,
            redirectUri,
            clientId,
            codeVerifier: verifier,
        })

        const cfg: AxiomMcpConfig = {
            apiBaseUrl,
            clientId,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt: Date.now() + tokens.expires_in * 1000,
            scope: tokens.scope,
            companyId: null, // server reads the companyId claim from the access token
        }
        saveConfig(cfg)
        log(`Saved tokens to ${configPath()}`)
        return cfg
    } finally {
        server.close()
    }
}

/**
 * Returns a valid, authenticated config — running the interactive OAuth flow once
 * if no config exists yet. Concurrent callers share a single in-flight flow so a
 * burst of tool calls never opens multiple browser tabs.
 */
let inflight: Promise<AxiomMcpConfig> | null = null

export async function ensureAuthenticated(opts: OAuthOptions = {}): Promise<AxiomMcpConfig> {
    if (configExists()) {
        const cfg = loadConfig()
        await refreshIfNeeded(cfg)
        return loadConfig() // re-read in case refresh rotated the tokens
    }
    if (!inflight) {
        inflight = runInteractiveOAuth(opts).finally(() => {
            inflight = null
        })
    }
    return inflight
}

function startLoopbackListener(): Promise<{
    port: number
    server: ReturnType<typeof createServer>
    code: Promise<string>
    state: string
}> {
    return new Promise((resolve) => {
        const state = randomBytes(16).toString('hex')
        let resolveCode!: (v: string) => void
        let rejectCode!: (e: Error) => void
        const code = new Promise<string>((res, rej) => {
            resolveCode = res
            rejectCode = rej
        })

        const timer = setTimeout(
            () => rejectCode(new Error('Timed out waiting for browser authorization.')),
            AUTH_TIMEOUT_MS,
        )
        timer.unref?.()

        const server = createServer((req, res) => {
            if (!req.url) {
                res.writeHead(400).end('missing url')
                return
            }
            const u = new URL(req.url, 'http://localhost')
            if (u.pathname !== '/callback') {
                res.writeHead(404).end()
                return
            }
            const returnedState = u.searchParams.get('state')
            const codeParam = u.searchParams.get('code')
            const errorParam = u.searchParams.get('error')
            if (errorParam) {
                res.writeHead(400, { 'Content-Type': 'text/html' })
                res.end(`<h1>Authorization failed</h1><p>${errorParam}</p>`)
                clearTimeout(timer)
                rejectCode(new Error(`Authorization failed: ${errorParam}`))
                return
            }
            if (returnedState !== state || !codeParam) {
                res.writeHead(400).end('state mismatch')
                clearTimeout(timer)
                rejectCode(new Error('state mismatch'))
                return
            }
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end('<h1>Authorized.</h1><p>You can close this tab and return to Claude.</p>')
            clearTimeout(timer)
            resolveCode(codeParam)
        })

        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            if (typeof address === 'object' && address !== null) {
                resolve({ port: address.port, server, code, state })
            }
        })
    })
}

function openInBrowser(url: string): void {
    const cmd =
        platform() === 'win32'
            ? `start "" "${url}"`
            : platform() === 'darwin'
              ? `open "${url}"`
              : `xdg-open "${url}"`
    exec(cmd, () => {
        /* swallow — the URL is also printed so the user can open it manually */
    })
}
