# @axiom-billing/mcp

Model Context Protocol server for Axiom. Exposes accounting tools to Claude Desktop, ChatGPT, Codex, or any MCP-capable AI client — so the user's AI can read reports, suggest reconciliations, and create draft invoices without writing custom glue code.

## Install

Two distribution paths, same server:

### Option A — Desktop Extension (one-click, recommended for Claude Desktop)

Download the latest `axiom-mcp-<version>.mcpb` from the [Releases page](https://github.com/seankanderson/axiom-mcp/releases) and **drag it onto Claude Desktop** (or open it). Claude Desktop prompts for your Axiom API URL, then registers the server. The first time a tool runs, the extension opens your browser to authorize (OAuth + PKCE) — no separate install step.

### Option B — npm (CLI / advanced)

```sh
npx @axiom-billing/mcp install
```

### Option C — Remote connector (URL, works everywhere)

A hosted instance runs as a remote MCP connector — usable from Claude.ai, Claude Desktop, mobile, Cowork, and Claude Code. Add it by URL:

```
https://<your-connector-host>/mcp
```

Claude discovers the authorization server via `/.well-known/oauth-protected-resource`, registers itself (Dynamic Client Registration), and walks you through Axiom's OAuth consent. Nothing is stored on your machine — your token is sent per request and forwarded to the Axiom API. See [Hosting the remote connector](#hosting-the-remote-connector) to deploy your own.

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

## Hosting the remote connector

The same server runs as a stateless remote connector on **Azure Container Apps**. It holds no credentials — it validates each request's OAuth bearer against Axiom's JWKS and forwards it to the Axiom API.

```sh
# One-time: set your Axiom API base URL, then provision + deploy with azd.
azd env set AXIOM_API_URL https://api.axiom-billing.com/api
azd up
```

`azd up` builds the [Dockerfile](Dockerfile), pushes to ACR, and deploys the Container App from [infra/](infra/) into the shared `axiom` resource group. CI deploys on push to `main` via [.github/workflows/deploy-remote.yml](.github/workflows/deploy-remote.yml) (OIDC, no stored secrets).

Runtime env: `AXIOM_MCP_REMOTE=true`, `AXIOM_API_URL`, `MCP_PUBLIC_URL` (its own public origin), `PORT`. Optional `MCP_ALLOWED_ORIGINS` to restrict CORS.

To list it in Anthropic's **Connectors Directory**, submit the connector URL `https://<host>/mcp` — Dynamic Client Registration is already supported, so end users need no setup.

## Security

- Remote connector: tokens are never persisted — validated per request (issuer + RS256 signature + audience + expiry) and forwarded to the API.
- Local install: tokens at rest in `~/.axiom-mcp/config.json` with file mode 600.
- Refresh tokens rotate on every use (RFC 6749 §6); reuse of an old refresh token revokes the entire grant chain.
- Revoke this install at any time from **Connected Apps** in the Axiom UI.

## License

Internal.
