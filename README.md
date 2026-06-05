# @axiom/mcp

Model Context Protocol server for Axiom. Exposes accounting tools to Claude Desktop, ChatGPT, Codex, or any MCP-capable AI client — so the user's AI can read reports, suggest reconciliations, and create draft invoices without writing custom glue code.

## Install (one command)

```sh
npx @axiom/mcp install
```

That command:

1. Discovers your Axiom deployment's OAuth endpoints (`/.well-known/oauth-authorization-server`).
2. Dynamically registers a new OAuth client (RFC 7591) — no developer-portal step.
3. Opens your browser to the Axiom consent screen with PKCE.
4. Captures the redirect on a one-shot loopback listener (`http://127.0.0.1:<port>/callback`).
5. Exchanges the authorization code for access + refresh tokens.
6. Writes tokens to `~/.axiom-mcp/config.json` (mode 600).
7. Updates your Claude Desktop config to register the MCP server.

Restart Claude Desktop. The Axiom tools are now available in any conversation.

## Environment overrides

| Variable | Default | Meaning |
|---|---|---|
| `AXIOM_API_URL` | `http://localhost:8200/api` | Base URL of the Axiom API |
| `AXIOM_SCOPES` | `read:ledger read:invoices read:contacts read:reports read:bank-transactions offline_access` | Space-separated OAuth scopes to request |

## What it exposes

### Read tools

- `find_contact(query)` — fuzzy match contacts.
- `summarize_ar_aging()` — open AR with aging buckets.
- `list_open_invoices(contactId?)` — unpaid invoices.
- `list_unmatched_bank_transactions()` — bank transactions awaiting reconciliation.
- `explain_ledger_entry(transactionId)` — full debit/credit breakdown of a transaction.
- `get_report(reportId, dateFrom?, dateTo?)` — runs any of the standard Axiom reports.

### Write tools (approval-gated)

These tools NEVER write directly. They submit a request to the per-company approval queue. A human admin/supervisor explicitly approves each one from the Axiom UI before it runs. The exact policy (auto-approve, require-approval, block) is set per-tool per-company.

- `create_invoice_draft(contactId, items, dueDate?)` — proposes a draft invoice. Never finalizes.
- `record_payment(invoiceId, amount, method?, receivedDate?)` — proposes a payment row.
- `propose_reconciliation(bankTransactionId)` — returns a suggested match. Pure read.

## Audit trail

Every API call from this server carries `X-Axiom-Source: mcp`. The Axiom audit log records every mutation with `actorType: ai` and `actorId` = the user the install belongs to. Approved write actions also link the approving admin in the audit row.

## Security

- Tokens at rest in `~/.axiom-mcp/config.json` with file mode 600.
- Refresh tokens rotate on every use (RFC 6749 §6); reuse of an old refresh token revokes the entire grant chain.
- Revoke this install at any time from **Connected Apps** in the Axiom UI.

## License

Internal.
