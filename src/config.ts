import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Persisted session for the Axiom MCP install. Created by the install command,
 * consumed by the server on every tool call.
 */
export interface AxiomMcpConfig {
    apiBaseUrl: string
    clientId: string
    accessToken: string
    refreshToken: string
    expiresAt: number
    scope: string
    companyId: string | null
}

const CONFIG_DIR  = join(homedir(), '.axiom-mcp')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

export function loadConfig(): AxiomMcpConfig {
    if (!existsSync(CONFIG_PATH)) {
        throw new Error(
            `Axiom MCP is not installed. Run 'npx @axiom-billing/mcp install' first.\n` +
            `Expected config at: ${CONFIG_PATH}`,
        )
    }
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as AxiomMcpConfig
}

export function saveConfig(cfg: AxiomMcpConfig): void {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 })
}

export function configPath(): string {
    return CONFIG_PATH
}

export function configExists(): boolean {
    return existsSync(CONFIG_PATH)
}

export function ensureConfigDir(): void {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
}

export function loadOrThrow(): AxiomMcpConfig {
    const cfg = loadConfig()
    if (cfg.expiresAt < Date.now()) {
        throw new Error('Axiom MCP access token has expired. The server will refresh on the next call.')
    }
    return cfg
}

/** Test helper — allows pointing at a temp path. */
export function setConfigPathForTesting(path: string): { restore: () => void } {
    // Intentionally minimal — tests stub the module instead.
    return { restore: () => { /* noop */ } }
}

export { CONFIG_DIR, CONFIG_PATH }
