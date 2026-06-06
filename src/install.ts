#!/usr/bin/env node
import { platform } from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { runInteractiveOAuth } from './oauth.js'

/**
 * One-command install for npm users (`npx @axiom-billing/mcp install`).
 * Drives the OAuth flow, then registers the server in Claude Desktop's config.
 *
 * Note: the .mcpb Desktop Extension does NOT use this command — Claude Desktop
 * registers the server from the bundle manifest, and the server authorizes
 * itself on first use (see src/oauth.ts `ensureAuthenticated`).
 */
async function main(): Promise<void> {
    await runInteractiveOAuth()
    writeClaudeDesktopBlock()
    console.error('✔ Done. Restart Claude Desktop to pick up the Axiom MCP server.')
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
