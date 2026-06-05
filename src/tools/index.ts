import { z } from 'zod'
import { axiomApi, Envelope } from '../apiClient.js'

export interface ToolDefinition {
    name:        string
    description: string
    inputSchema: z.ZodType
    handler:     (input: unknown) => Promise<unknown>
}

// ── Read tools (v1) ─────────────────────────────────────────────────────────

const FindContactInput = z.object({
    query: z.string().describe('Substring to match against contact name or email.'),
})

const findContact: ToolDefinition = {
    name: 'find_contact',
    description: 'Find contacts (customers / suppliers) by name or email substring.',
    inputSchema: FindContactInput,
    handler: async (raw) => {
        const input = FindContactInput.parse(raw)
        const companyId = axiomApi.getCompanyId()
        const res = await axiomApi.get<Envelope<unknown[]>>(
            `/v1/companies/${companyId}/contacts?search=${encodeURIComponent(input.query)}`,
        )
        return res.data
    },
}

const SummarizeArAgingInput = z.object({
    asOfDate: z.string().optional().describe('Optional ISO date; defaults to today.'),
})

const summarizeArAging: ToolDefinition = {
    name: 'summarize_ar_aging',
    description: 'Summarize accounts-receivable aging buckets (current, 30, 60, 90+ days).',
    inputSchema: SummarizeArAgingInput,
    handler: async (raw) => {
        SummarizeArAgingInput.parse(raw)
        const companyId = axiomApi.getCompanyId()
        const open = await axiomApi.get<Envelope<unknown>>(
            `/v1/companies/${companyId}/reports/open-invoices`,
        )
        return open.data
    },
}

const ListOpenInvoicesInput = z.object({
    contactId: z.string().optional(),
})

const listOpenInvoices: ToolDefinition = {
    name: 'list_open_invoices',
    description: 'List unpaid invoices for the bound company, optionally filtered by contactId.',
    inputSchema: ListOpenInvoicesInput,
    handler: async (raw) => {
        const input = ListOpenInvoicesInput.parse(raw)
        const companyId = axiomApi.getCompanyId()
        const path = input.contactId
            ? `/v1/companies/${companyId}/reports/open-invoices?contactId=${encodeURIComponent(input.contactId)}`
            : `/v1/companies/${companyId}/reports/open-invoices`
        const res = await axiomApi.get<Envelope<unknown>>(path)
        return res.data
    },
}

const ListUnmatchedBankTxInput = z.object({})

const listUnmatchedBankTransactions: ToolDefinition = {
    name: 'list_unmatched_bank_transactions',
    description: 'List bank transactions that have not yet been matched to a ledger entry.',
    inputSchema: ListUnmatchedBankTxInput,
    handler: async () => {
        const companyId = axiomApi.getCompanyId()
        const res = await axiomApi.get<Envelope<{ status: string }[]>>(
            `/v1/companies/${companyId}/bank-transactions`,
        )
        return (res.data ?? []).filter(t => t.status === 'posted' || t.status === 'pending')
    },
}

const ExplainLedgerEntryInput = z.object({
    transactionId: z.string(),
})

const explainLedgerEntry: ToolDefinition = {
    name: 'explain_ledger_entry',
    description: 'Fetch all legs of a ledger transaction with account metadata so you can summarize it.',
    inputSchema: ExplainLedgerEntryInput,
    handler: async (raw) => {
        const input = ExplainLedgerEntryInput.parse(raw)
        const companyId = axiomApi.getCompanyId()
        // The unversioned route is the only one currently exposing this; v1 alias comes later.
        const all = await axiomApi.get<{ transactions: { transactionId: string }[] }>(
            `/companies/${companyId}/ledger`,
        )
        const tx = all.transactions?.find(t => t.transactionId === input.transactionId)
        if (!tx) throw new Error(`Transaction ${input.transactionId} not found.`)
        return tx
    },
}

const GetReportInput = z.object({
    reportId: z.enum([
        'profit-and-loss-cash-basis',
        'balance-sheet',
        'income-statement',
        'general-ledger-detail',
        'open-invoices',
        'sales-by-customer',
        'sales-by-item',
        'inventory-valuation',
        'purchase-history',
    ]),
    dateFrom: z.string().optional(),
    dateTo:   z.string().optional(),
})

const getReport: ToolDefinition = {
    name: 'get_report',
    description: 'Run a standard Axiom report and return its data.',
    inputSchema: GetReportInput,
    handler: async (raw) => {
        const input = GetReportInput.parse(raw)
        const companyId = axiomApi.getCompanyId()
        const params = new URLSearchParams()
        if (input.dateFrom) params.set('dateFrom', input.dateFrom)
        if (input.dateTo)   params.set('dateTo',   input.dateTo)
        const path = `/v1/companies/${companyId}/reports/${input.reportId}` +
            (params.size ? `?${params.toString()}` : '')
        return await axiomApi.get(path)
    },
}

// ── Write tools (v2 — gated by approval policy) ─────────────────────────────

const CreateInvoiceDraftInput = z.object({
    contactId: z.string(),
    items: z.array(z.object({
        description: z.string(),
        amount:      z.number(),
        quantity:    z.number().int().positive().optional(),
    })),
    dueDate: z.string().optional(),
})

const createInvoiceDraft: ToolDefinition = {
    name: 'create_invoice_draft',
    description: 'Create an invoice in DRAFT state. The user must explicitly finalize it from the UI; this tool never finalizes.',
    inputSchema: CreateInvoiceDraftInput,
    handler: async (raw) => {
        const input = CreateInvoiceDraftInput.parse(raw)
        const companyId = axiomApi.getCompanyId()
        return await axiomApi.post(`/v1/companies/${companyId}/approvals`, {
            tool: 'create_invoice_draft',
            payload: input,
        })
    },
}

const RecordPaymentInput = z.object({
    invoiceId: z.string(),
    amount:    z.number().positive(),
    method:    z.string().optional(),
    receivedDate: z.string().optional(),
})

const recordPayment: ToolDefinition = {
    name: 'record_payment',
    description: 'Record a payment against an invoice. Requires explicit human approval per the per-company policy.',
    inputSchema: RecordPaymentInput,
    handler: async (raw) => {
        const input = RecordPaymentInput.parse(raw)
        const companyId = axiomApi.getCompanyId()
        return await axiomApi.post(`/v1/companies/${companyId}/approvals`, {
            tool: 'record_payment',
            payload: input,
        })
    },
}

const ProposeReconciliationInput = z.object({
    bankTransactionId: z.string(),
})

const proposeReconciliation: ToolDefinition = {
    name: 'propose_reconciliation',
    description: 'Look at a bank transaction and propose a matching ledger entry. Read-only suggestion — never writes.',
    inputSchema: ProposeReconciliationInput,
    handler: async (raw) => {
        const input = ProposeReconciliationInput.parse(raw)
        const companyId = axiomApi.getCompanyId()
        const all = await axiomApi.get<Envelope<{ id: string; amount: number; postedDate: string; payee?: string | null }[]>>(
            `/v1/companies/${companyId}/bank-transactions`,
        )
        const target = all.data?.find(t => t.id === input.bankTransactionId)
        if (!target) throw new Error(`Bank transaction ${input.bankTransactionId} not found.`)
        return {
            target,
            suggestion: `Look for a ledger entry near ${target.postedDate} with amount ${target.amount}. Use match endpoint to confirm.`,
        }
    },
}

export const ALL_TOOLS: ToolDefinition[] = [
    findContact,
    summarizeArAging,
    listOpenInvoices,
    listUnmatchedBankTransactions,
    explainLedgerEntry,
    getReport,
    createInvoiceDraft,
    recordPayment,
    proposeReconciliation,
]
