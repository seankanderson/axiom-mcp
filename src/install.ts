#!/usr/bin/env node
import { createServer } from 'node:http'
import { exec } from 'node:child_process'
import { platform } from 'node:os'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
    discover,
    registerClient,
    exchangeCode,
    generatePkcePair,
} from './auth.js'
import { saveConfig, configPath } from './config.js'

/**
 * One-command install. Drives the full discovery → DCR → PKCE flow against
 * an Axiom deployment, then writes both the MCP server config AND the
 * Claude Desktop config block. No credentials in the command — the user
 * approves in their browser.
 */
async function main(): Promise<void> {
    const apiBaseUrl = process.env.AXIOM_API_URL ?? 'http://localhost:8200/api'
    const scopes    = process.env.AXIOM_SCOPES   ?? 'read:ledger read:invoices read:contacts read:reports read:bank-transactions offline_access'

    console.error(`Axiom MCP installer — using API at ${apiBaseUrl}`)

    const discovery = await discover(apiBaseUrl)

    // Pick a free port on loopback for the redirect listener.
    const { port, server, code, state } = await startLoopbackListener()
    const redirectUri = `http://127.0.0.1:${port}/callback`

    const { clientId } = await registerClient(
        discovery.registration_endpoint,
        'Axiom MCP (this machine)',
        redirectUri,
    )

    const { verifier, challenge } = generatePkcePair()
    const resource = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`

    const authorizeUrl = new URL(discovery.authorization_endpoint)
    authorizeUrl.searchParams.set('response_type',         'code')
    authorizeUrl.searchParams.set('client_id',             clientId)
    authorizeUrl.searchParams.set('redirect_uri',          redirectUri)
    authorizeUrl.searchParams.set('code_challenge',        challenge)
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')
    authorizeUrl.searchParams.set('scope',                 scopes)
    authorizeUrl.searchParams.set('state',                 state)
    authorizeUrl.searchParams.set('resource',              resource)

    console.error(`Opening browser to: ${authorizeUrl}`)
    openInBrowser(authorizeUrl.toString())

    const callbackCode = await code
    server.close()

    const tokens = await exchangeCode({
        tokenEndpoint: discovery.token_endpoint,
        code:          callbackCode,
        redirectUri,
        clientId,
        codeVerifier:  verifier,
    })

    saveConfig({
        apiBaseUrl,
        clientId,
        accessToken:  tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt:    Date.now() + tokens.expires_in * 1000,
        scope:        tokens.scope,
        companyId:    null, // server reads the companyId claim from the access token
    })

    console.error(`Saved tokens to ${configPath()}`)

    writeClaudeDesktopBlock()

    console.error('✔ Done. Restart Claude Desktop to pick up the Axiom MCP server.')
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
        let rejectCode!:  (e: Error) => void
        const code = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej })

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
            const codeParam     = u.searchParams.get('code')
            const errorParam    = u.searchParams.get('error')
            if (errorParam) {
                res.writeHead(400, { 'Content-Type': 'text/html' })
                res.end(`<h1>Authorization failed</h1><p>${errorParam}</p>`)
                rejectCode(new Error(`Authorization failed: ${errorParam}`))
                return
            }
            if (returnedState !== state || !codeParam) {
                res.writeHead(400).end('state mismatch')
                rejectCode(new Error('state mismatch'))
                return
            }
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end('<h1>Authorized.</h1><p>You can close this tab.</p>')
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
    const cmd = platform() === 'win32' ? `start "" "${url}"`
        :       platform() === 'darwin' ? `open "${url}"`
        :       `xdg-open "${url}"`
    exec(cmd, () => { /* swallow */ })
}

function writeClaudeDesktopBlock(): void {
    const dir = platform() === 'win32'
        ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude')
        : platform() === 'darwin'
            ? join(homedir(), 'Library', 'Application Support', 'Claude')
            : join(homedir(), '.config', 'Claude')

    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = join(dir, 'claude_desktop_config.json')

    let existing: { mcpServers?: Record<string, unknown> } = {}
    if (existsSync(path)) {
        try { existing = JSON.parse(readFileSync(path, 'utf8')) } catch { /* invalid; overwrite */ }
    }
    existing.mcpServers ??= {}
    ;(existing.mcpServers as Record<string, unknown>)['axiom'] = {
        command: process.execPath,
        args:    [new URL('./server.js', import.meta.url).pathname],
    }
    writeFileSync(path, JSON.stringify(existing, null, 2))
    console.error(`Wrote Claude Desktop config: ${path}`)
}

main().catch(err => {
    console.error('Install failed:', err instanceof Error ? err.message : err)
    process.exit(1)
})
