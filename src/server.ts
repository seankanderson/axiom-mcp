#!/usr/bin/env node
import { createServer as createHttpServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
    CallToolRequestSchema,
    GetPromptRequestSchema,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
    SetLevelRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { zodToJsonSchema } from './zodToJsonSchema.js'
import { ALL_TOOLS } from './tools/index.js'
import {
    STATIC_RESOURCES,
    TEMPLATED_RESOURCES,
    resolveResource,
} from './resources/index.js'
import { ALL_PROMPTS } from './prompts/index.js'
import { logger } from './logger.js'
import { axiomApi } from './apiClient.js'

const SERVER_NAME    = 'axiom-mcp'
const SERVER_VERSION = '0.1.0'

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

    const http = createHttpServer((req, res) => {
        if (req.url === '/' || req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
                server: SERVER_NAME,
                version: SERVER_VERSION,
                transport: 'streamable-http',
                endpoint: '/mcp',
            }))
            return
        }
        if (req.url?.startsWith('/mcp')) {
            transport.handleRequest(req, res).catch((err: unknown) => {
                console.error('handleRequest failed:', err)
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' })
                    res.end('Internal server error')
                }
            })
            return
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not found')
    })

    http.listen(port, '127.0.0.1', () => {
        console.log(`${SERVER_NAME} v${SERVER_VERSION} listening on http://127.0.0.1:${port}/mcp`)
        logger.info(`${SERVER_NAME} v${SERVER_VERSION} ready`, { transport: 'streamable-http', port })
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
