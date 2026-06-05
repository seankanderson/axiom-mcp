#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { zodToJsonSchema } from './zodToJsonSchema.js'
import { ALL_TOOLS } from './tools/index.js'

/**
 * MCP server entry point. Communicates with Claude Desktop, ChatGPT, etc. over
 * stdio. Tool definitions live in ./tools/. All Axiom API calls go through
 * apiClient.ts and carry Path-A (user_delegated) OAuth tokens.
 */
async function main(): Promise<void> {
    const server = new Server(
        { name: 'axiom-mcp', version: '0.1.0' },
        { capabilities: { tools: {} } },
    )

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
            return {
                content: [{ type: 'text' as const, text: `Unknown tool: ${request.params.name}` }],
                isError: true,
            }
        }
        try {
            const result = await tool.handler(request.params.arguments ?? {})
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            return {
                content: [{ type: 'text' as const, text: `Tool error: ${message}` }],
                isError: true,
            }
        }
    })

    const transport = new StdioServerTransport()
    await server.connect(transport)
}

main().catch(err => {
    console.error('Fatal:', err)
    process.exit(1)
})
