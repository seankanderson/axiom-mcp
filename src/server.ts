#!/usr/bin/env node
import { createServer as createHttpServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
    CallToolRequestSchema,
    GetPromptRequestSchema,
    InitializedNotificationSchema,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
    SetLevelRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { zodToJsonSchema } from './zodToJsonSchema.js'
import { LOGO_SVG } from './logo.js'
import { ALL_TOOLS } from './tools/index.js'
import {
    STATIC_RESOURCES,
    TEMPLATED_RESOURCES,
    resolveResource,
} from './resources/index.js'
import { ALL_PROMPTS } from './prompts/index.js'
import { logger } from './logger.js'
import { axiomApi } from './apiClient.js'
import { RemoteAuth } from './remoteAuth.js'
import { runWithAuth } from './requestContext.js'
import type { IncomingMessage, ServerResponse } from 'node:http'

const SERVER_NAME    = 'axiom-mcp'
const SERVER_VERSION = '0.1.0'

// Scopes advertised in protected-resource metadata (matches the install defaults).
const SUPPORTED_SCOPES = [
    'read:company',
    'read:contacts', 'write:contacts',
    'read:inventory', 'write:inventory',
    'read:ledger',
    'read:invoices', 'write:invoices',
    'read:reports',
    'read:bank-transactions',
    'offline_access',
]

/**
 * MCP server entry point. Stdio by default; `--http <port>` (default 8210)
 * exposes the Streamable HTTP transport at `POST /mcp` for inspectors and
 * curl-based testing.
 */
async function main(): Promise<void> {
    const mode   = parseMode(process.argv.slice(2))
    const server = buildServer()
    logger.bind(server)

    if (mode.kind === 'http') {
        await startHttp(server, mode.port)
    } else {
        await startStdio(server)
    }
}

function buildServer(): Server {
    const server = new Server(
        { name: SERVER_NAME, version: SERVER_VERSION },
        {
            capabilities: {
                tools:     { listChanged: true },
                resources: { listChanged: true },
                prompts:   { listChanged: true },
                logging:   {},
            },
        },
    )

    // After handshake completes, push a tools/list_changed notification so the
    // client always re-fetches the current tool list (handles server restarts
    // without requiring a manual disconnect/reconnect in the MCP client).
    server.setNotificationHandler(InitializedNotificationSchema, async () => {
        await server.notification({ method: 'notifications/tools/list_changed' })
        logger.info('sent notifications/tools/list_changed after client initialized')
    })

    // ── tools ──────────────────────────────────────────────────────────────
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: ALL_TOOLS.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: zodToJsonSchema(t.inputSchema),
        })),
    }))

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const tool = ALL_TOOLS.find(t => t.name === request.params.name)
        if (!tool) {
            logger.warning(`tool not found: ${request.params.name}`)
            return {
                content: [{ type: 'text' as const, text: `Unknown tool: ${request.params.name}` }],
                isError: true,
            }
        }
        logger.info(`tool ${tool.name} called`)
        try {
            const result = await tool.handler(request.params.arguments ?? {})
            logger.debug(`tool ${tool.name} succeeded`)
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            logger.error(`tool ${tool.name} failed: ${message}`)
            return {
                content: [{ type: 'text' as const, text: `Tool error: ${message}` }],
                isError: true,
            }
        }
    })

    // ── resources ──────────────────────────────────────────────────────────
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: STATIC_RESOURCES.map(r => ({
            uri:         r.uri,
            name:        r.name,
            description: r.description,
            mimeType:    r.mimeType,
        })),
    }))

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
        resourceTemplates: TEMPLATED_RESOURCES.map(r => ({
            uriTemplate: r.uriTemplate,
            name:        r.name,
            description: r.description,
            mimeType:    r.mimeType,
        })),
    }))

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const uri      = request.params.uri
        const resolved = resolveResource(uri)
        if (!resolved) {
            logger.warning(`resource not found: ${uri}`)
            throw new Error(`Resource ${uri} is not exposed by this server.`)
        }
        const companyId = axiomApi.getCompanyId()
        logger.info(`reading resource ${uri}`)
        const data = resolved.kind === 'static'
            ? await resolved.resource.read(companyId)
            : await resolved.resource.read(companyId, resolved.params)
        return {
            contents: [{
                uri,
                mimeType: resolved.resource.mimeType,
                text:     JSON.stringify(data, null, 2),
            }],
        }
    })

    // ── prompts ────────────────────────────────────────────────────────────
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
        prompts: ALL_PROMPTS.map(p => ({
            name:        p.name,
            description: p.description,
            arguments:   p.arguments,
        })),
    }))

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        const prompt = ALL_PROMPTS.find(p => p.name === request.params.name)
        if (!prompt) {
            throw new Error(`Prompt ${request.params.name} is not exposed by this server.`)
        }
        // The SDK types `params.arguments` as `Record<string, string> | undefined`,
        // but we accept undefined per-arg and let each prompt validate required ones.
        const args = (request.params.arguments ?? {}) as Record<string, string | undefined>
        for (const a of prompt.arguments) {
            if (a.required && !args[a.name]) {
                throw new Error(`Prompt ${prompt.name} requires argument "${a.name}".`)
            }
        }
        logger.info(`prompt ${prompt.name} built`)
        return prompt.build(args)
    })

    // ── logging ────────────────────────────────────────────────────────────
    server.setRequestHandler(SetLevelRequestSchema, async (request) => {
        logger.setLevel(request.params.level)
        return {}
    })

    return server
}

async function startStdio(server: Server): Promise<void> {
    const transport = new StdioServerTransport()
    await server.connect(transport)
    // Process stderr — protocol logging isn't useful until the client has
    // negotiated, and even then they may not subscribe. This line confirms the
    // server reached the run loop.
    console.error(`${SERVER_NAME} v${SERVER_VERSION} ready (stdio)`)
    logger.info(`${SERVER_NAME} v${SERVER_VERSION} ready`, { transport: 'stdio' })
}

async function startHttp(server: Server, port: number): Promise<void> {
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
    })
    await server.connect(transport)

    // Remote-connector mode: validate the per-request OAuth bearer and advertise
    // protected-resource metadata. Enabled via env so local `--http` (inspector)
    // stays open and unauthenticated.
    const remoteMode = process.env.AXIOM_MCP_REMOTE === 'true'
    const apiBaseUrl = process.env.AXIOM_API_URL ?? 'http://localhost:8200/api'
    const publicUrl  = (process.env.MCP_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, '')
    // Serve the MCP endpoint at the subdomain root (e.g. https://mcp.host) rather
    // than a /mcp sub-path. This is the OAuth resource/audience identifier and the
    // URL users enter in the client; it must match the `resource` advertised in
    // protected-resource metadata and the `aud` validated on bearers — all three
    // derive from here, so changing this one value moves the whole endpoint.
    const resourceUrl = publicUrl
    const displayName = process.env.MCP_DISPLAY_NAME ?? 'Axiom Accounting'
    const logoUri     = process.env.MCP_LOGO_URI     ?? `${publicUrl}/logo.svg`
    const remoteAuth = remoteMode
        ? new RemoteAuth(apiBaseUrl, resourceUrl, SUPPORTED_SCOPES, displayName, logoUri)
        : null
    const resourceMetadataUrl = `${publicUrl}/.well-known/oauth-protected-resource`
    const allowedOrigin = process.env.MCP_ALLOWED_ORIGINS ?? '*'
    const bindHost = remoteMode ? '0.0.0.0' : '127.0.0.1'
    const listenPort = Number(process.env.PORT) || port

    const applyCors = (res: ServerResponse): void => {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID')
        res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, WWW-Authenticate')
    }

    const unauthorized = (res: ServerResponse): void => {
        res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}"`)
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized', error_description: 'Valid OAuth bearer token required.' }))
    }

    const http = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
        applyCors(res)

        if (req.method === 'OPTIONS') {
            res.writeHead(204)
            res.end()
            return
        }

        // Discovery + health must be matched before the root MCP route below.
        if (req.url?.startsWith('/.well-known/oauth-protected-resource')) {
            if (!remoteAuth) {
                res.writeHead(404, { 'Content-Type': 'text/plain' })
                res.end('Not found')
                return
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(remoteAuth.protectedResourceMetadata()))
            return
        }

        // RFC 8414 AS metadata — served here (at the MCP server's domain root) so
        // that clients following the 2025-03-26 spec, which derives the auth base URL
        // by discarding the MCP server's path, find it at the expected location.
        // The issuer MUST be the public MCP URL (not the API base URL) so that RFC 8414
        // issuer-match validation passes; all operative endpoints still live on the API.
        if (req.url?.startsWith('/.well-known/oauth-authorization-server')) {
            if (!remoteAuth) {
                res.writeHead(404, { 'Content-Type': 'text/plain' })
                res.end('Not found')
                return
            }
            const base = apiBaseUrl.replace(/\/$/, '')
            const asMetadata = {
                issuer:                               publicUrl,
                authorization_endpoint:               `${base}/oauth/authorize`,
                token_endpoint:                       `${base}/oauth/token`,
                revocation_endpoint:                  `${base}/oauth/revoke`,
                registration_endpoint:                `${base}/oauth/register`,
                jwks_uri:                             `${base}/.well-known/jwks.json`,
                response_types_supported:             ['code'],
                grant_types_supported:                ['authorization_code', 'refresh_token'],
                token_endpoint_auth_methods_supported: ['none'],
                code_challenge_methods_supported:     ['S256'],
                scopes_supported:                     SUPPORTED_SCOPES,
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(asMetadata))
            return
        }

        if (req.url?.startsWith('/health')) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
                server: SERVER_NAME,
                version: SERVER_VERSION,
                transport: 'streamable-http',
                endpoint: '/',
                remote: remoteMode,
            }))
            return
        }

        // Branding — serve the Axiom SVG logo so Claude and other MCP clients can
        // display the app icon in the connector list. /favicon.ico redirects here
        // as a fallback for clients that use domain favicon discovery.
        const path = (req.url ?? '/').split('?')[0]
        if (path === '/logo.svg') {
            res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' })
            res.end(LOGO_SVG)
            return
        }
        if (path === '/favicon.ico') {
            res.writeHead(302, { Location: '/logo.svg' })
            res.end()
            return
        }

        // MCP transport at the root (`/`); `/mcp` kept as a back-compat alias.
        if (path === '/' || path.startsWith('/mcp')) {
            void handleMcp(req, res)
            return
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not found')
    })

    async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
        try {
            if (!remoteAuth) {
                await transport.handleRequest(req, res)
                return
            }
            const header = req.headers.authorization
            const token = header?.toLowerCase().startsWith('bearer ')
                ? header.slice(7).trim()
                : null
            if (!token) {
                unauthorized(res)
                return
            }
            let auth
            try {
                auth = await remoteAuth.validateBearer(token)
            } catch (err) {
                logger.warning(`bearer validation failed: ${err instanceof Error ? err.message : String(err)}`)
                unauthorized(res)
                return
            }
            await runWithAuth(auth, () => transport.handleRequest(req, res))
        } catch (err) {
            console.error('handleRequest failed:', err)
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' })
                res.end('Internal server error')
            }
        }
    }

    http.listen(listenPort, bindHost, () => {
        console.log(`${SERVER_NAME} v${SERVER_VERSION} listening on http://${bindHost}:${listenPort}/ (remote=${remoteMode})`)
        logger.info(`${SERVER_NAME} v${SERVER_VERSION} ready`, { transport: 'streamable-http', port: listenPort, remote: remoteMode })
    })
}

type Mode =
    | { kind: 'stdio' }
    | { kind: 'http'; port: number }

function parseMode(argv: string[]): Mode {
    const i = argv.indexOf('--http')
    if (i === -1) return { kind: 'stdio' }
    const next = argv[i + 1]
    const port = next && /^\d+$/.test(next) ? Number(next) : 8210
    return { kind: 'http', port }
}

main().catch(err => {
    console.error('Fatal:', err)
    process.exit(1)
})
