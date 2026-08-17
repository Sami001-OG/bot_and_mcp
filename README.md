# Crypto Trading Platform

A single Next.js live-trading application (Vercel-deployable) that receives **TradingView alerts via signed webhooks**, executes them through **webhook bots**, and exposes a **Model Context Protocol (MCP) server** so AI agents can read portfolios and trade. Exchange connectivity is **Bybit only** (spot + USDT linear futures). All domain logic lives in workspace packages (`@platform/*`) that are bundled into the `.next` build; persistence is **MongoDB via Prisma**; credentials are stored per-account in MongoDB **encrypted at rest** — nothing is hardcoded in `.env`.

> [!WARNING]
> This is live-trading software for a real exchange. A bot bound to a real Bybit API key will spend real money when it receives a webhook signal. Read [Safety](#safety) before enabling trading.

## Contents

- [Live app](#live-app)
- [How a trade flows (execution model)](#how-a-trade-flows-execution-model)
- [1. Log in](#1-log-in)
- [2. Exchange APIs (required first step)](#2-exchange-apis-required-first-step)
- [3. Bots](#3-bots)
- [4. TradingView webhooks](#4-tradingview-webhooks)
- [5. Orders page (manual control)](#5-orders-page-manual-control)
- [6. Dashboard](#6-dashboard)
- [7. Settings and risk controls](#7-settings-and-risk-controls)
- [8. MCP server (AI agent access)](#8-mcp-server-ai-agent-access)
- [9. Cron maintenance endpoint](#9-cron-maintenance-endpoint)
- [REST API reference](#rest-api-reference)
- [Security model](#security-model)
- [Environment variables](#environment-variables)
- [Repository map](#repository-map)
- [Architecture and data model](#architecture-and-data-model)
- [Local development](#local-development)
- [Building, testing, linting](#building-testing-linting)
- [Deployment (Vercel)](#deployment-vercel)
- [Troubleshooting](#troubleshooting)
- [Safety](#safety)

## Live app

The production deployment is served from Vercel:

- URL: `https://web-blue-delta-17.vercel.app` (region `hkg1`, near Bybit's API edge — iad1 gets geo-blocked by Bybit, see [Troubleshooting](#troubleshooting))
- MCP endpoint: `https://web-blue-delta-17.vercel.app/api/mcp`

Everything below applies equally to `localhost:3000` and the deployed URL.

## How a trade flows (execution model)

There are exactly three ways to get an order to the exchange:

1. **TradingView webhook → bot** (the intended main path). A signed alert hits `/api/webhooks/tradingview/:endpointId`. The signature is verified, the payload is checked against the signal schema, and the signal is routed to every **ACTIVE** webhook bot subscribed to that endpoint — or, if the endpoint has no subscribed bots (e.g. an endpoint you created manually on the Webhooks page), to **all** ACTIVE webhook bots. Each bot then applies its own filters (symbol match incl. `*` wildcard, allowed-actions list, exchange) and skips non-matching signals. For matching signals the bot computes order size from its allocation mode, applies its SL/TP bracket, runs each order through the risk engine, persists it as an `OrderIntent`, and executes it synchronously against Bybit. Delivery is `DELIVERED` only if every matched bot run succeeded; otherwise `FAILED` with `routed`/`failed` counts.
2. **MCP trade tools** (`placeOrder`, `cancelOrder`, `closePosition`, `closeAll`, `changeLeverage`) — executed synchronously through the same commands/risk-engine/execute pipeline. You can call these from any MCP client (Claude, Cursor, custom scripts).
3. **Orders page** (manual order form + cancel + emergency close-all) — same synchronous pipeline.

All paths: parse → risk-check (`evaluateOrder`: trading enablement, daily-loss breaker, margin vs. equity, min-notional, leverage, position size) → size to exchange precision → persist `OrderIntent` → submit to Bybit → record `Execution` fills → update `Position` ledger. Bots also record a `BotRun` (STOPPED/ERROR with metrics: price, orders, skipped, notes, positionSide).

> [!NOTE]
> Execution is synchronous — an HTTP request (webhook, MCP call, API call) does not return until Bybit has answered. Timeouts on the exchange side surface as errors; use `cancelOrder` / the Orders page to clean up.

## 1. Log in

Open the app root (`/`). There is no user registration — the app is single-user, protected by one password:

- Enter the password (`APP_PASSWORD` env var) and submit.
- On success the app sets the session cookie (`nx_session`, Secure in production) and lands you on `/dashboard`.
- Log out via the account button in the sidebar.

If you're scripting against the REST API from outside a browser, `POST /api/auth/login` with `{ "password": "..." }` returns the session cookie in `Set-Cookie`; send it back as the `Cookie` header on subsequent requests.

## 2. Exchange APIs (required first step)

Every bot is created **with** an exchange API — there is no global/default key. Nothing is hardcoded; you enter your Bybit key/secret in the UI and it is encrypted before storage.

Go to **Exchange APIs** (`/accounts`):

1. **Create an account** — fields:
   - **Label** — a friendly name, e.g. "futures-main".
   - **Exchange** — currently `bybit`.
   - **Market type** — `USDT_FUTURES` (linear perpetuals) or `SPOT`.
   - **API key** and **API secret** — from Bybit (My Account → API Management). Create a read-write key; restrict withdrawal rights. The secret is encrypted with AES-256-GCM before it reaches MongoDB.
2. The first account automatically becomes **primary** (the default account for manual orders, dashboard reads, and MCP read tools). The list shows `keyPreview` (e.g. `LICs****iMMB`) so you can identify accounts without ever seeing the full key, and `botCount` — the number of bots bound to it.
3. **Set primary** — switches the default account for anything not bound to a specific account.
4. **Delete** — returns 409 `ACCOUNT_IN_USE` if bots still reference the account; stop/delete those bots first.

Trading API requirements on the Bybit side: enable the API key, and for futures ensure the account is in the appropriate position mode (one-way or hedge — the adapter handles both; `LONG`/`SHORT` map to hedge-mode positionIdx 1/2).

## 3. Bots

Bots are the automation unit: they subscribe a set of symbols to a webhook endpoint and translate incoming signals into sized, risk-checked orders with optional SL/TP brackets.

Go to **Bots** (`/bots`):

- **Create bot** (New bot) — fields:
  - **Name** — any label, e.g. `btc-breakout`.
  - **Exchange API** — the account the bot trades with (required, select from your saved accounts).
  - **Symbols** — one or more, e.g. `BTC/USDT:USDT`, `ETH/USDT:USDT` (futures format `<BASE>/<QUOTE>:<QUOTE>`). Symbols load live from Bybit's market list; if loading fails you'll see an error with a Retry button instead of an infinite spinner.
  - **Allocation mode** — how order size is derived:
    - `Use signal size` (NONE) — the bot uses `size` from the TradingView alert directly.
    - `PERCENT_EQUITY` — `percent`% of current equity.
    - `PERCENT_MAX_EQUITY` — `percent`% of peak equity.
    - `FIXED_AMOUNT` — a fixed USD amount (`amount`, decimal string).
    - `RISK_PERCENT` — `percent`% of equity at risk (stop-distance aware).
  - **Leverage** — 1–200 (futures).
  - **Stop loss price** — optional fixed SL price; orders will attach a reduce-only SL bracket.
  - **Take profits** — optional comma-separated prices, e.g. `100000, 110000`; each becomes a reduce-only TP bracket order.
  - **Require stop loss before entering** — when checked, signals without a `stop_loss` are skipped.
  - **Allowed signal actions** — checkbox allowlist: `BUY`, `SELL`, `LONG`, `SHORT`, `CLOSE_LONG`, `CLOSE_SHORT`, `REVERSE`, `PARTIAL_EXIT`. Signals with other actions are ignored.

- **Statuses**: bots start **ACTIVE** and respond to webhook signals. Pause / Resume / Stop per bot from the list or detail view; paused/stopped bots ignore signals (their endpoint is deactivated with them).
- **Dedicated endpoint**: creating a bot (UI or MCP) also creates a dedicated webhook endpoint named `<bot> (bot webhook)` — its URL and signing secret are shown once in the create dialog. A signal addressed to a bot's own endpoint only ever triggers that bot; a signal to a manually-created endpoint triggers every ACTIVE bot (each of which filters by symbol/action).
- **Bot detail** shows the bound account, config version history, and **runs** — each webhook trigger produces a run row with metrics: signal action, symbol, mark price, number of orders placed, skipped (with reasons, e.g. "Order margin exceeds available equity", "Order value below minimum of $10", "Symbol X not in configured bot symbols"), and errors.

## 4. TradingView webhooks

### Create an endpoint

Go to **Webhooks** (`/webhooks`), enter a name, and create. You get:

- **URL** — `https://<your-host>/api/webhooks/tradingview/<endpointId>`
- **Signing secret** — shown **exactly once**; copy it immediately. It is stored encrypted and can never be retrieved again (if you lose it, delete and recreate the endpoint).

### Signal payload format

The TradingView alert message body must be JSON with these fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `exchange` | string | yes | `"bybit"` |
| `symbol` | string | yes | e.g. `"BTC/USDT:USDT"` (uppercased) |
| `action` | string | yes | one of `BUY`, `SELL`, `LONG`, `SHORT`, `CLOSE_LONG`, `CLOSE_SHORT`, `REVERSE`, `PARTIAL_EXIT`, `SET_LEVERAGE`, `MOVE_STOP` |
| `size` | string | yes | **decimal string**, e.g. `"0.01"` — a JSON number `0.01` is rejected |
| `timestamp` | string | yes | **ISO-8601 string**, e.g. `"2026-08-17T10:00:00.000Z"`; must be within ±5 minutes of server time |
| `nonce` | string | yes | ≥ 12 chars; replaying the same `nonce` within 5 minutes is rejected |
| `leverage` | number | no | 1–200 |
| `stop_loss` | string | no | decimal string price |
| `take_profit` | array of strings | no | decimal string prices, max 20 |
| `reduce_only` | boolean | no | default false |
| `close_percentage` | number | no | 0–100 |

Actions `SET_LEVERAGE` and `MOVE_STOP` are schema-valid but not exposed as bot action options — bots ignore them unless configured.

**Minimal example** (`{{...}}` is TradingView alert message content):

```json
{
  "exchange": "bybit",
  "symbol": "{{ticker}}",
  "action": "BUY",
  "size": "0.01",
  "timestamp": "{{timestamp_iso}}",
  "nonce": "{{timenow}}-{{ticker}}"
}
```

> [!NOTE]
> `timestamp` must be an ISO-8601 string, not epoch seconds — TradingView's built-in `{{timenow}}` placeholder is epoch (and only 10 chars, too short for `nonce` on its own). From a Pine script, emit the timestamp as `str.format_time(time, "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "UTC")` into a plot/alert variable, or use any other ISO-producing placeholder. For manual tests, put a literal ISO timestamp of the current time (keep it within 5 minutes of sending).

Common alert scripts produce something like:

```json
{
  "exchange": "bybit",
  "symbol": "{{ticker}}",
  "action": "LONG",
  "size": "0.01",
  "leverage": 10,
  "stop_loss": "89000",
  "take_profit": ["100000", "110000"],
  "timestamp": "{{timestamp_iso}}",
  "nonce": "{{timenow}}-{{ticker}}"
}
```

### Signing (required)

Every request must carry the header:

```
x-tradingview-signature: <hex>
```

where `<hex>` is the **HMAC-SHA256 of the exact raw request body bytes**, keyed with the endpoint's signing secret, hex-encoded lowercase. The body must be sent byte-identical to what you sign (same whitespace, same key order) — TradingView sends the message content verbatim, so sign the exact JSON string.

Generating it in Node.js:

```js
import { createHmac } from 'node:crypto';
const body = JSON.stringify({ /* your signal */ });
const signature = createHmac('sha256', 'THE_SIGNING_SECRET').update(body).digest('hex');
console.log(body, signature);
```

or with a quick smoke test against a local/remote instance:

```powershell
$body = '{"exchange":"bybit","symbol":"BTC/USDT:USDT","action":"BUY","size":"0.01","timestamp":"2026-08-17T10:00:00.000Z","nonce":"n-1750000000-btc"}'
$sig = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes('THE_SIGNING_SECRET')).ComputeHash([Text.Encoding]::UTF8.GetBytes($body))
$sigHex = ($sig | ForEach-Object { $_.ToString('x2') }) -join ''
Invoke-WebRequest -Method POST -Uri 'https://<host>/api/webhooks/tradingview/<endpointId>' -Headers @{ 'x-tradingview-signature' = $sigHex } -ContentType 'application/json' -Body $body
```

If `WEBHOOK_REQUIRE_SIGNATURE=false`, unsigned requests are accepted (do not do this in production).

### Setting up the alert in TradingView

1. Open your strategy/chart → **Alerts** → create an alert for the symbol.
2. Set **Condition** / **Action** per your strategy.
3. Under **Notifications**, choose **Webhook URL** and paste the endpoint URL.
4. In **Message**, paste the JSON signal (with `{{...}}` placeholders so `symbol`, `timestamp`, and `nonce` are dynamic).
5. Under **Options**, ensure **"Webhook data is JSON"** is selected, then save.

### Responses

| Status | Meaning |
|---|---|
| `202` | Accepted. Body: `{ deliveryId, routed, failed, bots: [...] }`. `routed` = bots that processed it, `failed` = bot runs that errored, `deliveryId` = the persisted `WebhookDelivery` (view deliveries on the Webhooks page). A `note` field may explain degenerate cases: `LIVE_TRADING_DISABLED` (trading toggle off — `failed: 1`) or `no ACTIVE bot for this endpoint`. |
| `401` | Missing/invalid signature, stale timestamp, or replayed nonce (`WEBHOOK_VERIFICATION_FAILED`). |
| `404` / `410` | Unknown endpoint / endpoint deactivated (endpoints are deactivated when their bot is paused/stopped). |
| `4xx/5xx` | Schema or processing errors. |

Verification order: signature (HMAC over raw body) → schema parse → timestamp tolerance (±5 min) → nonce replay claim (`<exchange>:<nonce>`, persisted on the endpoint row for 5 minutes).

## 5. Orders page (manual control)

**Orders** (`/orders`) is the manual override surface:

- **Manual order form** — place a market/limit order directly: select the exchange API, symbol, side, order type, price, quantity. Goes through the same risk engine and persists as an `OrderIntent`.
- **Open orders** — list of in-flight orders on the exchange plus recent persisted order intents, with cancel buttons (`POST /api/orders/:id/cancel`).
- **Emergency close-all** — "Close all positions" issues reduce-only market orders for every open position on the account (also `POST /api/orders/emergency/close-all`). Not gated by risk controls by design, so it works in a crisis.

## 6. Dashboard

**Dashboard** (`/dashboard`) shows the live state of the primary account:

- Portfolio summary: total equity, 24h realized PnL, open position count.
- Positions with entry, mark price, unrealized PnL, liquidation estimate, leverage.
- Recent executions and orders.
- Risk panel: trading toggle, daily-loss limit, circuit-breaker state.
- Live-trading indicator + notifications bell (unread count, mark-read).

Read endpoints used by the dashboard: `/api/portfolio/summary`, `/api/portfolio/pnl`, `/api/portfolio/positions`, `/api/portfolio/executions`, `/api/orders`, `/api/settings`.

## 7. Settings and risk controls

`/api/settings` (GET/PATCH, session-protected) is the risk-control surface; the dashboard renders it:

- **`tradingEnabled`** (boolean) — global kill switch. When false: order placement (manual/MCP) and bot creation are rejected with 409 `LIVE_TRADING_DISABLED`, and webhook signals are accepted but not executed (202 with `note: LIVE_TRADING_DISABLED`, delivery marked FAILED). Acknowledging live trading sets `liveTradingAcknowledgedAt`.
- **`dailyLossLimit`** (decimal string or `null`) — when today's realized PnL is below the negative limit, the daily-loss **circuit breaker** trips (`breakerTripped`, `breakerReason`, `breakerDailyPnl`): bot runs are marked STOPPED with a CRITICAL notification, and manual/MCP orders are rejected with 409 `DAILY_LOSS_LIMIT_BREACHED`. Cleared by setting the limit to `null`. The breaker is re-evaluated by the [cron job](#9-cron-maintenance-endpoint) and before every order.
- **`equity` / `peakEquity`** — tracked for `PERCENT_MAX_EQUITY` allocation and drawdown checks.

## 8. MCP server (AI agent access)

The app exposes a full MCP server over Streamable HTTP — point any MCP client at the URL and the app's own tools/commands do the trading.

- **URL**: `<origin>/api/mcp` (also visible in the app via `/api/settings` → `mcpUrl`)
- **Auth**: `Authorization: Bearer <MCP_PASSWORD>` (falls back to `APP_PASSWORD` if `MCP_PASSWORD` is unset; `x-mcp-password` header also accepted). No auth → `401`.
- **Protocol**: JSON-RPC 2.0 over streamable HTTP. Supports `initialize`, `tools/list`, `tools/call`, `ping`.

### Tools (22)

Read tools:

| Tool | What it does |
|---|---|
| `listAccounts` | Configured exchange accounts (IDs needed for `createBot`) |
| `getPortfolio` | Live balances + positions for the configured account |
| `getBalance` | Current balances |
| `getPositions` | Open futures positions |
| `getOrders` | Open exchange orders + recent persisted order intents |
| `getMarketData` | Current price + tradability for a symbol |
| `getMarkets` | Tradeable markets, optionally filtered by quote |
| `getOHLCV` | Candlestick history |
| `getFundingRate` | Current funding for a perpetual |
| `getOpenInterest` | Open interest for a perpetual |
| `getRiskMetrics` | Risk policy, exposure, position count, 24h realized PnL |
| `getPerformance` | Realized PnL by symbol + ledger positions |
| `getTradeHistory` | Recent orders/executions incl. fees |

Write tools (all through the risk engine, synchronous):

| Tool | What it does |
|---|---|
| `placeOrder` | Place a live order (`exchangeAccountId`, `symbol`, `side`, `type`, `quantity`, `price?`, `stopPrice?`, `leverage?`, `reduceOnly?`, `clientOrderId?`, `idempotencyKey?`) |
| `cancelOrder` | Cancel an open order |
| `closePosition` | Reduce-only market close for a symbol |
| `closeAll` | Close every open position on the account |
| `changeLeverage` | Set leverage for a futures instrument |
| `createBot` | Create a webhook bot (requires `exchangeAccountId`; creates a dedicated endpoint) |
| `resumeBot` / `pauseBot` | Activate / pause a bot |
| `deleteBot` | Soft-delete (stop) a bot |

### Quick start

```bash
# list tools
curl -s -X POST https://<host>/api/mcp \
  -H 'Authorization: Bearer <MCP_PASSWORD>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"demo","version":"1.0"}}}'
```

Then `tools/list` (returns all 22 specs), then `tools/call`:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "getPortfolio", "arguments": {} } }
```

Results are returned as text content: `{ "ok": true, "tool": "...", "correlationId": "...", ...result }`.

To connect Claude Desktop or any MCP client, use the **streamable HTTP** transport with a custom `Authorization: Bearer` header; Claude Code supports streamable HTTP servers directly (see [MCP docs](https://opencode.ai) for your client). The same `MCP_PASSWORD` protects the UI-less API too — keep it random and long.

> [!NOTE]
> `placeOrder` and friends execute **immediately** and cannot be revoked mid-flight; treat the MCP write tools like the manual order form. `cancelOrder` and `closeAll` are your emergency handles from an agent.

## 9. Cron maintenance endpoint

`POST /api/cron` runs housekeeping that would otherwise be the BullMQ-era scheduled jobs:

- Auth: `x-cron-secret: <CRON_SECRET>` header (or `Authorization: Bearer <CRON_SECRET>`). Returns 503 if `CRON_SECRET` is unset, 401 on mismatch.
- Runs three jobs in parallel: `checkCircuitBreaker` (re-evaluates the daily-loss breaker), `scanForStaleOrders` (reconciles orders stuck in flight), `syncPositionsNow` (re-fetch positions + mark prices from Bybit).
- Response: `{ ranAt, breaker, stale, positions }`.

On Vercel, add a cron job (e.g. every 5 minutes) hitting this endpoint with the secret header. Locally, `curl -X POST http://localhost:3000/api/cron -H "x-cron-secret: $env:CRON_SECRET"`.

## REST API reference

All routes are session-protected except the public ones noted. Responses are JSON; errors use `{ message, code, statusCode }` (RFC 9457-style `ApiProblem`).

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/auth/login` | Password login → session cookie |
| `POST` | `/api/auth/logout` | Destroy session |
| `GET` | `/api/auth/me` | Current session info |
| `GET` | `/api/health` | Health (DB, engine location) |
| `GET` / `PATCH` | `/api/settings` | Risk settings (trading toggle, daily loss limit) |
| `GET` / `POST` | `/api/exchange-accounts` | List / create accounts (create body: `label`, `exchange`, `marketType`, `apiKey`, `apiSecret`) |
| `PATCH` / `DELETE` | `/api/exchange-accounts/[id]` | Set primary / delete (409 `ACCOUNT_IN_USE` when bots bound) |
| `GET` / `POST` | `/api/bots` | List / create bots |
| `PATCH` / `DELETE` | `/api/bots/[id]` | Update config / delete |
| `POST` | `/api/bots/[id]/[action]` | `resume` \| `pause` \| `stop` |
| `GET` / `POST` | `/api/orders` | List / place manual order |
| `POST` | `/api/orders/[id]/cancel` | Cancel an order |
| `POST` | `/api/orders/emergency/close-all` | Close all positions (ungated) |
| `GET` | `/api/orders/[id]` | Order intent detail |
| `GET` | `/api/markets?quote=USDT` | Live Bybit markets (drives the bots symbol picker) |
| `GET` | `/api/portfolio/summary` | Equity, PnL, positions count |
| `GET` | `/api/portfolio/pnl` | Realized PnL |
| `GET` | `/api/portfolio/positions` | Open positions |
| `GET` | `/api/portfolio/executions` | Recent fills |
| `GET` / `POST` | `/api/webhooks` | List / create endpoints (create returns `signingSecret` once) |
| `POST` | `/api/webhooks/tradingview/[endpointId]` | **Public** — signed TradingView ingress |
| `POST` | `/api/cron` | Maintenance (CRON_SECRET) |
| `GET` / `POST` | `/api/mcp` | **Public** — MCP server (Bearer password) |
| `GET` / `POST` / `DELETE` | `/api/notifications...` | Notifications list / read / unread count |

## Security model

- **Single-password auth**: `APP_PASSWORD` (comparison is constant-time). Session cookie `nx_session` is HttpOnly + Secure in production.
- **MCP**: Bearer `MCP_PASSWORD`, constant-time compared. No tokens stored.
- **Credentials at rest**: the Bybit API **secret** is encrypted with AES-256-GCM (`ENCRYPTION_KEY`, 64-hex or 32-byte base64) into `v1:<iv>:<tag>:<ct>` envelopes; the API key is stored plaintext (it's a public identifier) and shown only as `keyPreview`. Secrets are decrypted only in memory, immediately before an exchange call, and never returned by any API.
- **Webhooks**: HMAC-SHA256 of the raw body + ±5-minute timestamp tolerance + nonce replay protection. Signing secret shown once.
- **No secrets in the repo**: `.env` is gitignored (`.env.example` documents keys); never commit exchange keys, signing secrets, or passwords.
- The dashboard is the only UI; there is no registration, no multi-tenant separation — protect the password.

## Environment variables

Root `.env` (gitignored) — the app has **no** `apps/web/.env`; Next.js is started with the root `.env` loaded into the process environment (see [Local development](#local-development)).

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | MongoDB connection string (Atlas direct multi-host or `mongodb://127.0.0.1:27017/tradingbot` locally) |
| `APP_PASSWORD` | yes | UI login password |
| `MCP_PASSWORD` | yes (prod) | MCP bearer token (falls back to `APP_PASSWORD`) |
| `SESSION_SECRET` | yes | Signs the session cookie |
| `ENCRYPTION_KEY` | yes | 64-hex or 32-byte base64; AES-256-GCM for exchange secrets |
| `CRON_SECRET` | for cron | Authenticates `/api/cron` |
| `WEBHOOK_REQUIRE_SIGNATURE` | no | `true` (default) — set `false` only to allow unsigned webhooks |
| `BYBIT_API_KEY` / `BYBIT_SECRET_KEY` | no | **Legacy fallback only** — the app no longer reads them; enter credentials in the UI |

Generate a key: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.

## Repository map

```text
.
├── apps/web/                  # The entire app (Next.js 15, App Router, dark dashboard)
│   ├── app/api/               # All API routes (auth, accounts, bots, orders, portfolio,
│   │                          #   webhooks, settings, markets, notifications, cron, mcp, health)
│   ├── app/(pages)/           # dashboard, orders, bots, webhooks, accounts, login
│   ├── lib/                   # auth (session), route helpers, session fetch
│   └── vercel.json            # Lambda regions (hkg1)
├── packages/
│   ├── database/              # Prisma schema + generated client (MongoDB)
│   ├── security/              # encryptSecret/decryptSecret (AES-256-GCM), constantTimeEqual, hashToken
│   ├── contracts/             # Zod schemas (orders, TradingView signals, webhook bot config)
│   ├── exchange-core/         # Canonical exchange types/errors/adapter interface
│   ├── exchange-adapters/     # ccxt Bybit adapter (recvWindow 30000, time-sync enabled)
│   ├── trading-core/          # Order sizing, precision alignment, PnL/position math
│   ├── risk-engine/           # evaluateOrder (risk checks), min-notional, sizing
│   ├── bot-engine/            # Webhook strategy: buildWebhookOrders (entry + SL/TP brackets)
│   ├── webhook/               # TradingViewVerifier (HMAC, timestamp, replay)
│   └── commands/              # ALL domain logic: accounts, bots, orders, execute, portfolio, settings
└── scripts/vercel-build.mjs   # Vercel build hook (copies Prisma engine into .next)
```

All packages are bundled into the `.next` build — after editing a package you must rebuild its dist (`node_modules/.bin/tsc -p packages/<pkg>/tsconfig.json`) **and** rerun `next build`.

## Architecture and data model

- **Persistence**: MongoDB, single database `tradingbot`. Prisma models: `ExchangeAccount` (encrypted `apiSecret`, `isPrimary`), `Bot` (bound `exchangeAccountId`, JSON config, versions), `BotRun` (metrics), `OrderIntent` (exchangeAccountId + `source` records origin: webhook/MCP/manual), `Execution`, `Position`, `WebhookEndpoint` (+ encrypted signing secret), `WebhookDelivery` (nonce replay claims), `Notification`, `Settings` (kill switch, daily loss limit, equity/peak).
- **Clock handling**: this VM drifts; the Bybit adapter always sets `recvWindow: 30000` + `adjustForTimeDifference: true` — requests fail with 10002 otherwise. Never disable.
- **Risk pipeline** (`evaluateOrder`): trading enablement → daily-loss breaker → margin vs. equity → min-notional ($10 futures / $5 spot floor) → leverage bounds → size alignment to exchange precision (`alignAmount`/`alignPrice`, `PRECISION_REJECTED` below `amountMin`).
- **Futures details**: `LONG`/`SHORT` map to hedged-mode `positionIdx` 1/2; SL/TP brackets are reduce-only conditional trigger orders (`orderType: Market`, `triggerPrice`, `triggerDirection`, `triggerBy: LastPrice`); only **ISOLATED** margin is accepted.

## Local development

Prerequisites on this machine: Node 22, MongoDB **7.0.14** (the 8.0.4 binary crashes on this 2014 CPU — see [Troubleshooting](#troubleshooting)).

### 1. Start MongoDB (replica set — required for Prisma transactions)

```powershell
& "C:\Users\saifs\AppData\Local\MongoDB\v7\mongodb-win32-x86_64-windows-7.0.14\bin\mongod.exe" --dbpath C:\Users\saifs\AppData\Local\MongoDB\data --port 27017 --bind_ip 127.0.0.1 --replSet rs0 --wiredTigerEngineConfigString "log=(compressor=zlib)" --logpath C:\Users\saifs\AppData\Local\Temp\opencode\mongod.log
```

If the data dir is fresh, initiate the replica set once (root `npm i --no-save mongodb`; `mongosh` is broken here):

```js
new MongoClient('mongodb://127.0.0.1:27017/?directConnection=true')
  .db('admin').command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] } });
```

### 2. Configure and push the schema

```powershell
node --env-file-if-exists=../../.env ../../node_modules/prisma/build/index.js db push --schema prisma/schema.prisma
```

(run from `packages/database`; deps are hoisted to the root `node_modules`). Note the Prisma 6.x wasm validator rejects string-literal defaults — use enums or bare identifiers.

### 3. Run the app

```powershell
# load root .env into the process, then start the production build
Get-Content .env | ForEach-Object { if ($_ -match '^([A-Z0-9_]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') } }
Start-Process node -ArgumentList @('"D:\crypto_data\Trading bot mcp\node_modules\next\dist\bin\next"','start','-p','3000') -WorkingDirectory "D:\crypto_data\Trading bot mcp\apps\web"
```

(or `next dev` for development). App: `http://localhost:3000`.

A full end-to-end smoke script lives at `C:\Users\saifs\AppData\Local\Temp\opencode\smoke-web.mjs` (login → account → bot → signed webhook → MCP; expects a fresh DB).

## Building, testing, linting

```powershell
# rebuild a package dist (do this before next build after package edits)
node --env-file=.env node_modules\typescript\bin\tsc -p packages\<pkg>\tsconfig.json

# unit tests (security, commands, webhook, risk, trading-core, adapters, bot-engine)
node --env-file=.env node_modules\typescript\bin\tsc -p packages\<pkg>\tsconfig.json; node --env-file=.env node_modules\vitest\...   # see package scripts

# Next.js production build (local workarounds needed on this machine, see Troubleshooting)
$env:NODE_OPTIONS='--require C:\Users\saifs\AppData\Local\Temp\opencode\eperm-skip.cjs'
node "D:\crypto_data\Trading bot mcp\node_modules\next\dist\bin\next" build
```

## Deployment (Vercel)

The production site is deployed from this repo to Vercel:

1. **From the repo root** — `node "C:\Users\saifs\AppData\Roaming\npm\node_modules\vercel\dist\vc.js" deploy --prod`. Never use `--prebuilt` (cloud assembly fails on missing filePathMap refs) and never deploy from `apps/web` (rootDirectory would double-append).
2. **Environment** — set all vars in the Vercel project dashboard (same as `.env`; `DATABASE_URL` pointing at Atlas).
3. **Build hook** — `scripts/vercel-build.mjs` copies the Prisma engine into `.next/server/` and registers it in `required-server-files.json` so every Lambda can find it (otherwise `/api/health` 503s with "Query Engine not located").
4. **Region** — `apps/web/vercel.json` pins every API route to `hkg1`. Do not change: Bybit's CloudFront geo-blocks US datacenters (403), which made `/api/markets` fail from iad1.
5. **Atlas** — the cluster's IP access list must allow `0.0.0.0/0` for Vercel egress (otherwise TLS `InternalError`). Use a direct multi-host URI (this machine's DNS refuses SRV records).
6. **Cron** — add a scheduled function/cron hitting `/api/cron` with `x-cron-secret`.
7. **Deploy records** — the current live deployment is `web-e3zzigzfu-md-sami-s-projects.vercel.app` → alias `web-blue-delta-17.vercel.app`.

On a fresh `npm install`, re-apply the local build workarounds (nft home-glob patch + `eperm-skip.cjs`) — the Vercel cloud build needs none of them.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Markets never load; infinite spinner | Bybit geo-blocks the region. API routes must run in `hkg1` (`apps/web/vercel.json`). Locally this is not an issue. |
| `/api/health` → 503 "Query Engine not located" | Prisma engine missing from the Lambda — rerun a deploy; `scripts/vercel-build.mjs` copies it into `.next/server`. |
| Bybit API errors with code `10002` | Clock skew — never remove `recvWindow: 30000` / `adjustForTimeDifference: true` from the adapter. |
| Webhook returns 401 `WEBHOOK_VERIFICATION_FAILED` | Wrong signature (sign the raw body exactly), timestamp older than 5 minutes, or a replayed nonce. |
| "Order value below minimum of $10" / "margin exceeds available equity" | Normal risk skips for small balances — the run records the reason in `skipped`. |
| Local mongod crashes with `0xC000001D` | MongoDB 8.0.4 needs AVX2; this 2014 CPU lacks it. Use 7.0.14. If it won't restart after an unclean shutdown: stop it, wipe the data dir, restart, re-initiate the replica set (dev data is disposable). |
| Local `next build` dies on EPERM/home globs | Re-apply the nft patch + run with `NODE_OPTIONS=--require ...\eperm-skip.cjs`. |
| Session cookie not sent from PowerShell | Cookie is Secure in production; use the Node smoke script (manual `Cookie` header) or HTTPS. |
| `vercel deploy --prebuilt` fails with ENOENT | Use plain `vercel deploy --prod` from the repo root (cloud build). |

## Safety

- This software places live orders on Bybit with **real funds** when a signal arrives. Test with minimal amounts on a separate API key first; keep the global trading toggle off until you're confident.
- Every bot is bound to its own exchange API — revoke a key on Bybit to instantly kill everything using it.
- The daily-loss limit and trading toggle are your primary risk stops; the emergency close-all is your last resort.
- Monitor webhook deliveries (Webhooks page) and bot runs (Bots page) — `routed`/`failed` and `skipped` reasons tell you what actually happened.
- The MCP write tools are live-fire: do not hand the `MCP_PASSWORD` to an untrusted agent.
- Cryptocurrency and leveraged derivatives can cause rapid, total, or greater-than-deposit losses. Software controls reduce operational risk, not market risk.
