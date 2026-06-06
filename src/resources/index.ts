import { axiomApi, Envelope } from '../apiClient.js'

/**
 * Resources expose read-only Axiom state to MCP clients via URI. Unlike tools,
 * resources are addressable: a client can paste `axiom://chart-of-accounts`
 * into a context window and the MCP host knows how to fetch it.
 *
 * Two flavors:
 *   - StaticResource: fixed URI, listed in `resources/list`.
 *   - TemplatedResource: parametric URI like `axiom://contact/{contactId}`,
 *     listed in `resources/templates/list`. Clients construct the concrete URI
 *     themselves (often after a tool call returns an id).
 */

export interface StaticResource {
    uri:          string
    name:         string
    description:  string
    mimeType:     string
    read:        (companyId: string) => Promise<unknown>
}

export interface TemplatedResource {
    uriTemplate: string
    name:        string
    description: string
    mimeType:    string
    match:       (uri: string) => Record<string, string> | null
    read:        (companyId: string, params: Record<string, string>) => Promise<unknown>
}

// ── Static resources ────────────────────────────────────────────────────────

const companyProfile: StaticResource = {
    uri:         'axiom://company/profile',
    name:        'Company profile',
    description: 'Profile, fiscal-year settings, and contact info for the bound company.',
    mimeType:    'application/json',
    read: async (companyId) =>
        await axiomApi.get(`/companies/${companyId}`),
}

const chartOfAccounts: StaticResource = {
    uri:         'axiom://chart-of-accounts',
    name:        'Chart of accounts',
    description: 'All accounts (code, name, type, classification) for the bound company. Use as grounding when discussing accounts by name.',
    mimeType:    'application/json',
    read: async (companyId) =>
        await axiomApi.get(`/companies/${companyId}/chart-of-accounts`),
}

const reportsCatalog: StaticResource = {
    uri:         'axiom://reports/catalog',
    name:        'Reports catalog',
    description: 'List of available reports with their accepted date parameters. Use to pick a reportId for the `get_report` tool.',
    mimeType:    'application/json',
    read: async (companyId) =>
        await axiomApi.get(`/companies/${companyId}/reports/catalog`),
}

// ── Templated resources ─────────────────────────────────────────────────────

const contactTemplate: TemplatedResource = {
    uriTemplate: 'axiom://contact/{contactId}',
    name:        'Contact (templated)',
    description: 'A single contact (customer or supplier) by id. Construct the URI after a `find_contact` call returns the id.',
    mimeType:    'application/json',
    match: (uri) => {
        const m = /^axiom:\/\/contact\/([^/]+)$/.exec(uri)
        return m ? { contactId: m[1] } : null
    },
    read: async (companyId, params) =>
        await axiomApi.get(`/companies/${companyId}/contacts/${params.contactId}`),
}

const ledgerTemplate: TemplatedResource = {
    uriTemplate: 'axiom://ledger/{transactionId}',
    name:        'Ledger transaction (templated)',
    description: 'A single ledger transaction by id. Returns all legs (debits/credits) and account metadata.',
    mimeType:    'application/json',
    match: (uri) => {
        const m = /^axiom:\/\/ledger\/([^/]+)$/.exec(uri)
        return m ? { transactionId: m[1] } : null
    },
    read: async (companyId, params) => {
        const all = await axiomApi.get<Envelope<{ transactions: { transactionId: string }[] }> | { transactions: { transactionId: string }[] }>(
            `/companies/${companyId}/ledger`,
        )
        // The unversioned ledger endpoint returns either the bare object or an
        // envelope depending on version — handle both.
        const transactions = 'transactions' in all
            ? all.transactions
            : all.data?.transactions ?? []
        const tx = transactions.find(t => t.transactionId === params.transactionId)
        if (!tx) throw new Error(`Transaction ${params.transactionId} not found.`)
        return tx
    },
}

export const STATIC_RESOURCES: StaticResource[] = [
    companyProfile,
    chartOfAccounts,
    reportsCatalog,
]

export const TEMPLATED_RESOURCES: TemplatedResource[] = [
    contactTemplate,
    ledgerTemplate,
]

/** Look up which resource (static or templated) handles a given URI. */
export function resolveResource(uri: string):
    | { kind: 'static';     resource: StaticResource }
    | { kind: 'templated';  resource: TemplatedResource; params: Record<string, string> }
    | null
{
    const direct = STATIC_RESOURCES.find(r => r.uri === uri)
    if (direct) return { kind: 'static', resource: direct }

    for (const t of TEMPLATED_RESOURCES) {
        const params = t.match(uri)
        if (params) return { kind: 'templated', resource: t, params }
    }
    return null
}
