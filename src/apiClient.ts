import { randomBytes } from 'node:crypto'
import { refreshIfNeeded } from './auth.js'
import { loadConfig } from './config.js'

/**
 * Thin HTTP client over Axiom's /api/v1 surface. Refreshes the access token
 * before every call. Every mutation carries X-Axiom-Source: mcp so the audit
 * log attributes correctly (actorType=ai).
 */
export class AxiomApiClient {
    async get<T = unknown>(path: string): Promise<T> {
        return await this.request<T>('GET', path)
    }

    async post<T = unknown>(path: string, body?: unknown): Promise<T> {
        return await this.request<T>('POST', path, body)
    }

    async put<T = unknown>(path: string, body?: unknown): Promise<T> {
        return await this.request<T>('PUT', path, body)
    }

    async delete<T = unknown>(path: string): Promise<T> {
        return await this.request<T>('DELETE', path)
    }

    private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const cfg   = loadConfig()
        const token = await refreshIfNeeded(cfg)

        const headers: Record<string, string> = {
            Authorization:   `Bearer ${token}`,
            'X-Axiom-Source': 'mcp',
        }
        if (method !== 'GET' && method !== 'DELETE') {
            headers['Content-Type'] = 'application/json'
            headers['Idempotency-Key'] = randomBytes(16).toString('hex')
        }

        const res = await fetch(`${cfg.apiBaseUrl}${path}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        })

        if (!res.ok) {
            const text = await res.text()
            throw new Error(`Axiom API ${method} ${path} failed: ${res.status} ${text}`)
        }

        if (res.status === 204) return undefined as unknown as T
        return await res.json() as T
    }

    getCompanyId(): string {
        const cfg = loadConfig()
        const fromToken = extractCompanyIdFromJwt(cfg.accessToken)
        const companyId = cfg.companyId ?? fromToken
        if (!companyId) {
            throw new Error('No companyId is bound to this MCP install. Reinstall and pick a company on the consent screen.')
        }
        return companyId
    }
}

function extractCompanyIdFromJwt(token: string): string | null {
    const parts = token.split('.')
    if (parts.length < 2) return null
    try {
        const payload = JSON.parse(
            Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
        ) as { companyId?: string }
        return payload.companyId ?? null
    } catch {
        return null
    }
}

export const axiomApi = new AxiomApiClient()

/** Standard /api/v1 envelope. */
export interface Envelope<T> {
    success: boolean
    message: string
    data:    T
    error:   null | { title: string; status: number; errorCode: string; detail?: string }
}
