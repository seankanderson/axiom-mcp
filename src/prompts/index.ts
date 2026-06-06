/**
 * Prompts are user-facing workflow starters — they appear as slash commands
 * or quick-actions in MCP-aware UIs. Each one expands to a `messages` array
 * the host injects into the conversation. The bodies are instruction templates
 * that ground the model in Axiom's tools and resources; they do NOT execute
 * tool calls themselves.
 */

export interface PromptArgument {
    name:        string
    description: string
    required:    boolean
}

export interface PromptDefinition {
    name:        string
    description: string
    arguments:   PromptArgument[]
    /** Build the messages payload returned by `prompts/get`. */
    build:      (args: Record<string, string | undefined>) => {
        description: string
        messages:    Array<{ role: 'user'; content: { type: 'text'; text: string } }>
    }
}

function userMessage(text: string): { role: 'user'; content: { type: 'text'; text: string } } {
    return { role: 'user', content: { type: 'text', text } }
}

const monthEndClose: PromptDefinition = {
    name:        'month-end-close',
    description: 'Walk through a month-end close: review unmatched bank transactions, run P&L and balance sheet, flag anomalies.',
    arguments: [
        { name: 'period', description: 'Period to close in YYYY-MM format (e.g. "2026-05").', required: true },
    ],
    build: (args) => {
        const period = args.period ?? '<period>'
        return {
            description: `Month-end close for ${period}`,
            messages: [userMessage(
                `Help me close the books for ${period}. Work through these steps using the Axiom MCP tools and resources:\n\n` +
                `1. Read \`axiom://company/profile\` to confirm fiscal-year alignment.\n` +
                `2. Read \`axiom://chart-of-accounts\` so you can refer to accounts by name.\n` +
                `3. Call \`list_unmatched_bank_transactions\` and walk each row — propose a match using \`propose_reconciliation\`.\n` +
                `4. Call \`get_report\` with reportId="profit-and-loss-cash-basis" for dateFrom=${period}-01 to the period end.\n` +
                `5. Call \`get_report\` with reportId="balance-sheet" dated at the period end.\n` +
                `6. Flag anomalies: account balances that swung >20% MoM, negative liabilities, zero-activity accounts that used to be active.\n` +
                `7. Summarize what's safe to close vs what needs the bookkeeper's attention.`,
            )],
        }
    },
}

const reconcileBankAccount: PromptDefinition = {
    name:        'reconcile-bank-account',
    description: 'Reconcile a bank account: list unmatched transactions, propose ledger matches for each, summarize anything that needs human review.',
    arguments: [
        { name: 'accountId', description: 'Bank account id (chart-of-accounts code). Omit to reconcile all bank accounts.', required: false },
        { name: 'period',    description: 'Period to reconcile in YYYY-MM. Omit for current period.',                       required: false },
    ],
    build: (args) => {
        const scope = args.accountId ? `account ${args.accountId}` : 'all bank accounts'
        const period = args.period ?? 'the current period'
        return {
            description: `Reconcile ${scope} for ${period}`,
            messages: [userMessage(
                `Reconcile ${scope} for ${period}.\n\n` +
                `1. Call \`list_unmatched_bank_transactions\`.\n` +
                `2. For each row, call \`propose_reconciliation\` with the bankTransactionId. Read \`axiom://ledger/{transactionId}\` for any candidate match the suggestion references.\n` +
                `3. Group results into: (a) high-confidence auto-matches, (b) ambiguous matches needing review, (c) bank tx with no ledger candidate (likely missing journal entry).\n` +
                `4. For category (c), describe what journal entry should be created — do NOT call \`create_invoice_draft\` or any write tool. Hand off the list to the human.`,
            )],
        }
    },
}

const reviewArAging: PromptDefinition = {
    name:        'review-ar-aging',
    description: 'Review AR aging buckets, highlight overdue customers, and draft suggested follow-up actions.',
    arguments: [
        { name: 'asOfDate', description: 'Aging cut-off in YYYY-MM-DD. Defaults to today.', required: false },
    ],
    build: (args) => {
        const asOf = args.asOfDate ?? 'today'
        return {
            description: `Review AR aging as of ${asOf}`,
            messages: [userMessage(
                `Review AR aging as of ${asOf}.\n\n` +
                `1. Call \`summarize_ar_aging\`${args.asOfDate ? ` with asOfDate="${args.asOfDate}"` : ''}.\n` +
                `2. For each contact with >60 days outstanding, read \`axiom://contact/{contactId}\` for context (terms, prior payment history).\n` +
                `3. Call \`list_open_invoices\` for those contacts to itemize what's overdue.\n` +
                `4. Draft a short follow-up action per contact: friendly reminder (<30), firm reminder (30–60), collections escalation (>60).\n` +
                `5. Do NOT send anything. Output a table the bookkeeper can review and dispatch manually.`,
            )],
        }
    },
}

const prepare1040cInputs: PromptDefinition = {
    name:        'prepare-1040c-inputs',
    description: 'Collect and validate the tax inputs the /reports/1040c endpoint needs before posting.',
    arguments: [
        { name: 'taxYear', description: 'Tax year (e.g. "2026").', required: true },
    ],
    build: (args) => {
        const year = args.taxYear ?? '<taxYear>'
        return {
            description: `Prepare Schedule C inputs for ${year}`,
            messages: [userMessage(
                `Gather the inputs required to file Schedule C (Form 1040) for tax year ${year}.\n\n` +
                `1. Read \`axiom://company/profile\` — confirm the entity is a sole proprietorship (Schedule C only applies to sole props / single-member LLCs).\n` +
                `2. Read \`axiom://chart-of-accounts\` to map account categories to Schedule C lines (gross receipts, returns, COGS, expenses by category).\n` +
                `3. Call \`get_report\` with reportId="profit-and-loss-cash-basis", dateFrom=${year}-01-01, dateTo=${year}-12-31.\n` +
                `4. Call \`get_report\` with reportId="general-ledger-detail" for the same range to verify P&L totals roll up correctly.\n` +
                `5. Summarize: (a) the Schedule C inputs you've collected, (b) anything ambiguous that needs the owner's confirmation (home-office %, vehicle mileage, depreciation method), (c) accounts that don't map cleanly to a Schedule C line.\n` +
                `6. Do NOT post to /reports/1040c yet — that's the next step after the owner confirms the inputs.`,
            )],
        }
    },
}

export const ALL_PROMPTS: PromptDefinition[] = [
    monthEndClose,
    reconcileBankAccount,
    reviewArAging,
    prepare1040cInputs,
]
