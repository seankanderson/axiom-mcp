import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Per-request authentication carried through the call stack when the server runs
 * as a remote connector (Streamable HTTP). The MCP client sends an OAuth bearer
 * on every request; we validate it, stash the result here, and the API client
 * forwards the same token to Axiom — scoped to exactly that user/company.
 *
 * In stdio / .mcpb mode there is no request scope, so {@link getRequestAuth}
 * returns undefined and the API client falls back to the local token file.
 */
export interface RequestAuth {
    accessToken: string
    companyId: string | null
    scopes: string[]
}

const storage = new AsyncLocalStorage<RequestAuth>()

export function runWithAuth<T>(auth: RequestAuth, fn: () => T): T {
    return storage.run(auth, fn)
}

export function getRequestAuth(): RequestAuth | undefined {
    return storage.getStore()
}
