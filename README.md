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
- [Webhook integration guide — building a signal-generator app on top of BOTX](#4b-webhook-integration-guide--building-a-signal-generator-app-on-top-of-botx)
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

1. **TradingView webhook → bot** (the intended main path). A signed alert hits `/api/webhooks/tradingview/:endpointId`. The signature is verified, the payload is checked against the signal schema, and the signal is routed to the **ACTIVE** bot that owns that endpoint. Each bot then applies its own filters (symbol match incl. `*` wildcard, allowed-actions list, exchange) and skips non-matching signals. For matching signals the bot computes order size from its allocation mode, applies its SL/TP bracket, runs each order through the risk engine, persists it as an `OrderIntent`, and executes it synchronously against Bybit. Delivery is `DELIVERED` only if the bot run succeeded; otherwise `FAILED` with `routed`/`failed` counts.
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
   - **Testnet** — check to use Bybit **testnet** (test funds, `api-testnet.bybit.com`). Keys must come from `testnet.bybit.com` (separate login, USDT-M testnet keys). Testnet accounts are marked with a TESTNET badge and behave exactly like mainnet accounts — ideal for dry-running bots and cron flows without real money.
   - **API key** and **API secret** — from Bybit (My Account → API Management). Create a read-write key; restrict withdrawal rights. The secret is encrypted with AES-256-GCM before it reaches MongoDB.
2. The first account automatically becomes **primary** (the default account for manual orders, dashboard reads, and MCP read tools). The list shows `keyPreview` (e.g. `LICs****iMMB`) so you can identify accounts without ever seeing the full key, and `botCount` — the number of bots bound to it.
3. **Set primary** — switches the default account for anything not bound to a specific account.
4. **Delete** — returns 409 `ACCOUNT_IN_USE` if bots still reference the account; stop/delete those bots first.

Trading API requirements on the Bybit side: enable the API key, and for futures the adapter auto-detects the account's position mode (one-way or hedge — it omits `positionIdx` for one-way accounts and uses hedge-mode `positionIdx 1/2` for hedged accounts, so no manual mode setting is needed).

## 3. Bots

Bots are the automation unit: they subscribe a set of symbols to a dedicated webhook endpoint and translate incoming signals into sized, risk-checked orders with optional SL/TP brackets. **Every trade runs through a bot** — a webhook signal or MCP trade without a bot is rejected.

Go to **Bots** (`/bots`):

- **Create bot** (New bot) — fields:
  - **Name** — any label, e.g. `btc-breakout`.
  - **Webhook / MCP password** — optional, ≥ 12 chars, chosen by you. This **one** password is both the webhook HMAC signing secret and the per-bot MCP Bearer token. Leave empty to auto-generate. Shown once after creation.
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
   - **Trailing stop** — optional `callbackPercent` (0.01–10, e.g. `1.5` = 1.5%). Every **futures** entry gets a reduce-only trailing-stop order activated at the entry price: once price moves `callbackPercent`% past the best (highest for longs / lowest for shorts) price, the stop follows it, locking in profit on pullbacks. It can be combined with a fixed SL (disaster stop) — the fixed SL stays in place and the trailing stop rides above it. Not available on spot bots (Bybit spot has no trailing-stop order type); signals requesting it on a spot bot skip it with a recorded note.
  - **Require stop loss before entering** — when checked, signals without a `stop_loss` are skipped.
  - **Allowed signal actions** — checkbox allowlist: `BUY`, `SELL`, `LONG`, `SHORT`, `CLOSE_LONG`, `CLOSE_SHORT`, `REVERSE`, `PARTIAL_EXIT`. Signals with other actions are ignored.
  - **Position-management capabilities** (evaluated on every bot run, and on demand via the MCP `manageBot` tool, or triggered by the webhook `MANAGE` action; all three work on **both futures and spot** bots — spot positions are tracked via the fill ledger with weighted-average entry prices):
    - > [!TIP]
      > **Built-in defaults — zero configuration required.** Every bot can DCA, move its stop to breakeven and claim partial take-profits out of the box, even if you never touch these settings. Defaults: **DCA** 3% trigger, $25 fixed steps, max 3 · **Breakeven** move SL at +1.5% · **Partial TPs** close 30% at +2%, 30% at +4%, 40% at +8%. Anything you configure explicitly replaces the default for that capability; set `"enabled": false` (or customize via MCP `updateBotConfig`) to turn one off. Webhook/MCP ephemeral overrides always win for that single run.
    - **DCA — average down**: add to a losing position when price drops `triggerDropPercent`% below entry. `stepDropPercent` (optional) spaces subsequent steps further out; each step adds `amount` (fixed $ or % of equity), up to `maxSteps` steps, one step per run. Example: 3% trigger, $50 steps, 3 max → steps at −3%, −6%, −9%.
    - **Breakeven stop-loss move**: when price moves `moveAtProfitPercent`% in favor, the stop loss is moved to entry (or `safeProfitPercent` above/below entry for longs/shorts if set). One move per position — state is tracked per bot.
    - **Partial take-profit claims**: comma-separated `price%:close%` levels, e.g. `2:30, 5:40, 10:30`. When price reaches a level the bot closes that percentage of the position at market (or rests a reduce-only TP trigger order at the level so the claim happens when price arrives). Levels must sum to ≤ 100%.
    - All three can be **overridden per signal** (ephemeral) or triggered on demand — see [Comprehensive examples](#comprehensive-examples-external-apps--tradingview-alerts).

- **Statuses**: bots start **ACTIVE** and respond to webhook signals. Pause / Resume / Stop per bot from the list or detail view; paused/stopped bots ignore signals (their endpoint is deactivated with them).
- **Dedicated endpoints**: creating a bot (UI or MCP) creates its own webhook endpoint **and** its own MCP endpoint. The create dialog shows each once:
  - Webhook URL `https://<host>/api/webhooks/tradingview/<endpointId>` + password (HMAC secret).
  - MCP URL `https://<host>/api/mcp/bots/<botId>` + the same password (Bearer token). Authenticate with this URL from Claude/Cursor etc.
  - A signal to a bot's own endpoint only ever triggers that bot. Endpoints are bot-owned only — there is no standalone endpoint creation (the old Webhooks page was removed).
- **Delete / Delete all**: every bot row has a permanent-delete action; the header has a **Delete all** button (also used internally when you force-delete an exchange account).
- **Bot detail** shows the bound account, config version history, and **runs** — each webhook trigger produces a run row with metrics: signal action, symbol, mark price, number of orders placed, skipped (with reasons, e.g. "Order margin exceeds available equity", "Order value below minimum of $10", "Symbol X not in configured bot symbols"), the position-management pass summary (`managed`), and errors.

## 4. TradingView webhooks

### Create an endpoint

Endpoints are **bot-owned** — creating a bot (UI or MCP) provisions its webhook endpoint automatically and shows you once:

- **URL** — `https://<your-host>/api/webhooks/tradingview/<endpointId>`
- **Signing secret** — shown **exactly once**; copy it immediately. It is stored encrypted and can never be retrieved again (if you lose it, delete and recreate the bot).

### Signal payload format

The TradingView alert message body must be JSON with these fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `exchange` | string | yes | `"bybit"` |
| `symbol` | string | yes | e.g. `"BTC/USDT:USDT"` (uppercased) |
| `action` | string | yes | one of `BUY`, `SELL`, `LONG`, `SHORT`, `CLOSE_LONG`, `CLOSE_SHORT`, `REVERSE`, `PARTIAL_EXIT`, `SET_LEVERAGE`, `MOVE_STOP`, `MANAGE` |
| `size` | string | no* | **decimal string**, e.g. `"0.01"` — a JSON number `0.01` is rejected. Required for every action **except** `MANAGE` |
| `timestamp` | string | yes | **ISO-8601 string**, e.g. `"2026-08-17T10:00:00.000Z"`; must be within ±5 minutes of server time |
| `nonce` | string | yes | ≥ 12 chars; replaying the same `nonce` within 5 minutes is rejected |
| `leverage` | number | no | 1–200 |
| `stop_loss` | string | no | decimal string price |
| `take_profit` | array of strings | no | decimal string prices, max 20 |
| `reduce_only` | boolean | no | default false |
| `close_percentage` | number | no | 0–100 (used by `PARTIAL_EXIT`) |
| `dca` | object | no | **ephemeral** DCA override for this run only (see below) |
| `breakeven` | object | no | **ephemeral** breakeven override for this run only |
| `partialTps` | object | no | **ephemeral** partial-TP override for this run only |
| `trailing` | object | no | **ephemeral** trailing-stop override for this run's entry: `{ callbackPercent }` (0.01–10). Like `stop_loss`/`take_profit`, it applies to the entry bracket, not the management pass |

Actions `SET_LEVERAGE` and `MOVE_STOP` are schema-valid but not exposed as bot action options — bots ignore them unless configured. (To move a stop loss on an existing position, use the MCP `manageBot` tool or the position-management features above.)

> [!NOTE]
> `trailing` is **not** a management override — it belongs to the entry bracket (`stop_loss` / `take_profit` family) and only takes effect on the run's entry orders. The management pass (DCA / breakeven / partial TP) does not add or move trailing stops.

#### Ephemeral management overrides (DCA / breakeven / partial TP)

Every signal can carry `dca`, `breakeven`, and/or `partialTps` objects. When present they **replace the bot's saved config for that single run** — nothing is persisted, and the next signal falls back to the saved config. This lets an external app (or a TradingView alert) tune risk on the fly — e.g. widen DCA spacing during high volatility, tighten breakeven, or change TP levels — without touching the bot's permanent settings.

- Fields are identical to the bot config (see the Bots section): `dca` = `triggerDropPercent` (0–50), `stepDropPercent` (optional), `amountMode` (`FIXED` | `PERCENT_EQUITY`), `amount`, `maxSteps` (1–20); `breakeven` = `moveAtProfitPercent` (0–100), `safeProfitPercent` (optional); `partialTps` = `levels: [{ pricePercent, closePercent }]` (closePercent sum ≤ 100).
- Supplying an override **enables** that capability for the run (`enabled` defaults to true; set `"enabled": false` explicitly to force it off for that run).
- Example: `"dca": { "triggerDropPercent": 6, "amountMode": "FIXED", "amount": 50, "maxSteps": 4 }` runs DCA this run with those exact params even if the bot had DCA disabled (or configured differently).

#### MANAGE action

A `MANAGE` signal runs **only** the position-management pass (DCA steps, breakeven SL move, partial-TP claims) — no orders are built or placed, `size` must be omitted, and it does not need to match `config.actions`. The management engine evaluates all open positions on the bot's symbols against the (possibly overridden) config — **built-in defaults apply when the bot has none saved**, so a plain `MANAGE` tick works on every bot with zero setup. This is the perfect "tick" for an external app: send a `MANAGE` alert every N minutes to let the engine react to the market even when your strategy is not emitting trade signals.

`MANAGE` respects the circuit breaker and trading toggle like any other run; the run is recorded as a normal `BotRun` with the `managed` metrics attached.

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

### Comprehensive examples (external apps / TradingView alerts)

Every example below is a complete, valid signal body. Replace `timestamp` and `nonce` per alert and HMAC-sign the raw JSON string.

**1. Plain entry with SL/TP bracket (most common)**

```json
{
  "exchange": "bybit",
  "symbol": "BTC/USDT:USDT",
  "action": "LONG",
  "size": "0.01",
  "leverage": 10,
  "stop_loss": "89000",
  "take_profit": ["100000", "110000"],
  "timestamp": "2026-08-19T10:00:00.000Z",
  "nonce": "b1f2a3c4d5e6"
}
```

**2. Entry that also (ephemerally) enables DCA with custom params for this run**

The saved bot config is untouched; this run DCA will trigger after a 4% drop and step every further 4%, $50 fixed per step, max 3 steps:

```json
{
  "exchange": "bybit",
  "symbol": "ETH/USDT:USDT",
  "action": "LONG",
  "size": "0.1",
  "stop_loss": "2200",
  "dca": { "triggerDropPercent": 4, "stepDropPercent": 4, "amountMode": "FIXED", "amount": 50, "maxSteps": 3 },
  "timestamp": "2026-08-19T10:00:00.000Z",
  "nonce": "c2f3b4d5e6f7"
}
```

**3. Ephemeral breakeven + partial TP tuning on an existing position**

Move the stop to entry once +1% in profit (from this run's perspective) and sell 25% at +3%, 50% at +8%:

```json
{
  "exchange": "bybit",
  "symbol": "BTC/USDT:USDT",
  "action": "BUY",
  "size": "0.001",
  "breakeven": { "moveAtProfitPercent": 1, "safeProfitPercent": 0.2 },
  "partialTps": { "levels": [ { "pricePercent": 3, "closePercent": 25 }, { "pricePercent": 8, "closePercent": 50 } ] },
  "timestamp": "2026-08-19T10:00:00.000Z",
  "nonce": "d3g4h5i6j7k8"
}
```

**4. Management-only tick (no orders placed)**

Force the DCA/breakeven/partial-TP engine to evaluate all open positions now — for external apps that poll the market and want the bot's auto-management to run on a timer:

```json
{
  "exchange": "bybit",
  "symbol": "BTC/USDT:USDT",
  "action": "MANAGE",
  "timestamp": "2026-08-19T10:00:00.000Z",
  "nonce": "e4h5i6j7k8l9"
}
```

**5. Partial exit (manual TP claim) — close 25% of the open position at market**

```json
{
  "exchange": "bybit",
  "symbol": "BTC/USDT:USDT",
  "action": "PARTIAL_EXIT",
  "size": "0.001",
  "close_percentage": 25,
  "timestamp": "2026-08-19T10:00:00.000Z",
  "nonce": "f5i6j7k8l9m0"
}
```

**6. Move the stop loss of the open position (breakeven-style manual move)**

```json
{
  "exchange": "bybit",
  "symbol": "BTC/USDT:USDT",
  "action": "MOVE_STOP",
  "size": "0.001",
  "stop_loss": "95000",
  "timestamp": "2026-08-19T10:00:00.000Z",
  "nonce": "g6j7k8l9m0n1"
}
```

**7. Close the entire position**

```json
{
  "exchange": "bybit",
  "symbol": "BTC/USDT:USDT",
  "action": "CLOSE_LONG",
  "size": "0",
  "timestamp": "2026-08-19T10:00:00.000Z",
  "nonce": "h7k8l9m0n1o2"
}
```

**8. Reverse a position**

```json
{
  "exchange": "bybit",
  "symbol": "BTC/USDT:USDT",
  "action": "REVERSE",
  "size": "0.005",
  "stop_loss": "91000",
  "timestamp": "2026-08-19T10:00:00.000Z",
  "nonce": "i8l9m0n1o2p3"
}
```

**9. Entry with a trailing stop (ephemeral — overrides the bot's saved trailing config for this run)**

`trailing` attaches a reduce-only trailing-stop order to this run's entry. Here: 1.5% callback. The stop activates at the entry price and follows the market once price moves 1.5% past the best price. If the bot also has a saved fixed SL, both exist (trailing rides above the fixed stop):

```json
{
  "exchange": "bybit",
  "symbol": "SOL/USDT:USDT",
  "action": "LONG",
  "size": "0.5",
  "leverage": 5,
  "trailing": { "callbackPercent": 1.5 },
  "timestamp": "2026-08-19T10:00:00.000Z",
  "nonce": "k0m1n2o3p4q5"
}
```

**10. Full entry bracket: fixed SL + multi-TP + trailing + DCA + breakeven + partial-TP — everything in one signal**

The complete toolset on a single alert: enter 0.1 ETH with a fixed stop at 2200, two take-profit bracket orders (2400, 2600), a 2% trailing stop riding above, and ephemeral management config for the run (DCA after a 4% drop, breakeven move at +1.5%, partial claims 25% at +3% / 50% at +8%):

```json
{
  "exchange": "bybit",
  "symbol": "ETH/USDT:USDT",
  "action": "LONG",
  "size": "0.1",
  "leverage": 10,
  "stop_loss": "2200",
  "take_profit": ["2400", "2600"],
  "trailing": { "callbackPercent": 2 },
  "dca": { "triggerDropPercent": 4, "amountMode": "FIXED", "amount": 50, "maxSteps": 3 },
  "breakeven": { "moveAtProfitPercent": 1.5, "safeProfitPercent": 0.2 },
  "partialTps": { "levels": [ { "pricePercent": 3, "closePercent": 25 }, { "pricePercent": 8, "closePercent": 50 } ] },
  "timestamp": "2026-08-19T10:00:00.000Z",
  "nonce": "l1n2o3p4q5r6"
}
```

> [!TIP]
> Any of the overrides in examples 2–3 combine with any action, including `MANAGE` — e.g. a `MANAGE` tick that temporarily widens DCA spacing without touching the saved config:
>
> ```json
> { "exchange": "bybit", "symbol": "BTC/USDT:USDT", "action": "MANAGE",
>   "dca": { "triggerDropPercent": 8, "amountMode": "FIXED", "amount": 25, "maxSteps": 2 },
>   "timestamp": "2026-08-19T10:00:00.000Z", "nonce": "j9m0n1o2p3q4" }
> ```

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

The endpoint **acknowledges immediately** and executes asynchronously:

| Status | Body | Meaning |
|---|---|---|
| `202` | `{ "deliveryId": "...", "status": "ACCEPTED" }` | Signature valid, payload schema-valid, nonce claimed. The signal is now queued for execution (`WebhookDelivery` row created with status `PROCESSING`). **The HTTP response does not contain execution results** — orders are placed after the ack via a background task. |
| `401` | `{ message, code: 'WEBHOOK_VERIFICATION_FAILED' }` | Bad HMAC signature, timestamp outside ±5 min, or replayed nonce. |
| `404` | — | Unknown `endpointId`. |
| `410` | — | Endpoint deactivated (its bot is paused/stopped/deleted). |
| `4xx/5xx` | `{ message, code?, statusCode? }` | Schema validation or processing errors (schema errors carry Zod issue details in `message`). |

Execution outcomes are persisted, not returned: the delivery row becomes `DELIVERED` (all bot runs OK) or `FAILED` (with error), and each bot run records its own metrics (orders placed, skipped reasons, price, management summary). Inspect them on the Bots page (runs timeline + deliveries) or in notifications. A signal-generator that needs programmatic confirmation of fills should read positions/orders through the bot's MCP server (see [section 8](#8-mcp-server-ai-agent-access)) — see [Result feedback loop](#result-feedback-loop-for-your-app).

Verification order: endpoint lookup → active check → HMAC signature over raw body → JSON parse + signal schema → timestamp tolerance (±5 min, UTC `Z`) → nonce replay claim (`<exchange>:<nonce>`, stored 5 minutes).

## 4b. Webhook integration guide — building a signal-generator app on top of BOTX

This section is a **complete implementation specification** for any external app (or AI agent writing one) that wants to emit trades into BOTX over webhooks. It explains the whole contract — transport, authentication, payload schema, market-type routing, replay/retry semantics, response handling, and reference sender implementations in Node.js and Python. Follow it exactly and your app can drive BOTX bots (and through them Bybit spot + USDT futures) with signed signals.

### How the pieces fit

```text
┌──────────────────────┐   HTTPS POST + HMAC     ┌─────────────────────────────────────────┐
│ Your signal app      │ ───────────────────────▶ │ BOTX  /api/webhooks/tradingview/<id>    │
│ (strategy, ML, TV,   │   x-tradingview-signature │ 1. verify signature/timestamp/nonce     │
│  scheduler, agent)   │ ◀─────────────────────── │ 2. validate payload against schema      │
└──────────────────────┘   202 {deliveryId}      │ 3. persist WebhookDelivery              │
                                                 │ 4. (async) route to the owning bot      │
                                                 │    → risk engine → sized orders         │
                                                 │    → Bybit spot / USDT futures          │
                                                 └─────────────────────────────────────────┘
```

Key mental model:

- You never talk to an exchange. You emit **signals**; the BOTX **bot** owns the exchange API, sizing, leverage, brackets, risk limits, and position management.
- Each bot has **exactly one** webhook endpoint and **exactly one** signing secret. A signal sent to that endpoint can only ever trigger that bot.
- The bot's permanent config (market type, symbols, capital-per-trade allocation, leverage, SL/TP, DCA/breakeven/partial-TP) is set once at creation; your signals select *what* to do (action + symbol), while the bot governs *how much* and *how* — unless you pass ephemeral overrides.

### Step 0 — provision a bot and store its credentials

Before your app can send anything, a bot must exist. Create it once (human step, or automate via REST/MCP):

- **UI**: Bots page → New bot → pick **Spot** or **Futures**, choose capital-per-trade mode (fixed $ / % equity / % peak equity / risk %), leverage (futures only), symbols → create.
- **REST** (session cookie): `POST /api/bots` with `{ name, exchangeAccountId, password?, config }`.
- **MCP**: `createBot` tool (same fields).

The creation response contains everything your app needs — capture and store all three values:

```json
{
  "bot":  { "id": "<botId>", "name": "btc-breakout", "...": "..." },
  "webhook": {
    "id": "<endpointId>",
    "url": "https://<host>/api/webhooks/tradingview/<endpointId>",
    "signingSecret": "<64+ char random string>"
  },
  "mcp": {
    "url": "https://<host>/api/mcp/bots/<botId>",
    "password": "<same as signingSecret>"
  }
}
```

> [!WARNING]
> `signingSecret` is shown **exactly once** and cannot be retrieved later. If lost, delete and recreate the bot. Treat it like an API key: it authorizes trades.

Config notes relevant to senders:

- `config.marketType` is `"SPOT"` or `"USDT_FUTURES"` (default `"USDT_FUTURES"`). It decides how your `symbol` is interpreted (see [Symbol routing](#symbol-routing-and-market-types)) and whether leverage applies.
- If `config.allocation` is set (any mode other than "use signal size"), the bot **ignores your `size`** and sizes from its own capital-per-trade rule. Send `size` anyway — it is schema-required for non-MANAGE actions and serves as a fallback.
- `config.actions` (if configured) allowlists actions; anything else is skipped with a recorded reason.

### Transport contract

| Item | Value |
|---|---|
| Method | `POST` |
| URL | `<origin>/api/webhooks/tradingview/<endpointId>` |
| Content-Type | `application/json` |
| Auth header | `x-tradingview-signature: <lowercase hex hmac>` |
| Body | The exact JSON string you signed (UTF-8, byte-identical) |
| Timeout guidance | Ack typically returns in < 1 s; give the HTTP call ≥ 10 s |
| Health probe | `GET` on the same URL returns `{ ok: true, ts }` (unsigned, harmless) |

The signature is computed over the **raw bytes of the body** — not a re-serialization. So: build the object → `JSON.stringify` once → sign that exact string → send that exact string. Do not pretty-print, do not let an HTTP library re-encode what you signed.

#### Signing algorithm

```
signature = lowercase_hex( HMAC_SHA256( key = signingSecret, message = raw_body_utf8_bytes ) )
header    = x-tradingview-signature: <signature>
```

Node.js:

```js
import { createHmac } from 'node:crypto';

const body = JSON.stringify(signal);                       // stringify ONCE
const signature = createHmac('sha256', signingSecret)      // key = the bot's signing secret
  .update(body, 'utf8')                                    // message = the exact string you send
  .digest('hex');                                          // lowercase hex
// headers: { 'content-type': 'application/json', 'x-tradingview-signature': signature }
```

Python:

```python
import json, hmac, hashlib

body = json.dumps(signal, separators=(",", ":"), ensure_ascii=False)  # one canonical string
signature = hmac.new(signing_secret.encode(), body.encode("utf-8"), hashlib.sha256).hexdigest()
# headers: {"Content-Type": "application/json", "x-tradingview-signature": signature}
```

PowerShell (quick manual tests):

```powershell
$body  = '{"exchange":"bybit","symbol":"BTC/USDT","action":"BUY","size":"0.001","timestamp":"2026-08-21T12:00:00.000Z","nonce":"test-nonce-0001"}'
$hmac  = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($secret))
$sig   = ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($body)) | ForEach-Object { $_.ToString('x2') }) -join ''
Invoke-RestMethod -Method Post -Uri "$host/api/webhooks/tradingview/$endpointId" -Headers @{ 'x-tradingview-signature' = $sig } -ContentType 'application/json' -Body $body
```

Any language with HMAC-SHA256 works — the contract is deliberately minimal so TradingView's plain webhook (which cannot compute signatures) is supported by setting `WEBHOOK_REQUIRE_SIGNATURE=false`; **never do this on a publicly reachable deployment**.

### Signal schema (authoritative field reference)

The body is a single JSON object. Unknown fields are ignored; listed constraints are enforced server-side (violations → `4xx` with a descriptive message).

| Field | Type | Required | Constraints / notes |
|---|---|---|---|
| `exchange` | string | yes | Must be `"bybit"` (the bot's account exchange must match too, else the run skips). |
| `symbol` | string | yes | 3–40 chars, case-insensitive (uppercased server-side). Bare (`BTC/USDT`) or futures (`BTC/USDT:USDT`) form accepted; routed per the bot's market type — see [Symbol routing](#symbol-routing-and-market-types). |
| `action` | string | yes | One of `BUY`, `SELL`, `LONG`, `SHORT`, `CLOSE_LONG`, `CLOSE_SHORT`, `REVERSE`, `PARTIAL_EXIT`, `MANAGE` (also schema-valid but bot-ignored unless allowlisted: `SET_LEVERAGE`, `MOVE_STOP`). |
| `size` | **string** | yes* | **Decimal string**, e.g. `"0.01"`. A JSON number (`0.01`) is **rejected**. Base-asset quantity. Required for every action **except** `MANAGE`; forbidden **with** `MANAGE`. Ignored when the bot has an allocation mode. |
| `timestamp` | **string** | yes | **ISO-8601 UTC string ending in `Z`**, e.g. `"2026-08-21T12:00:00.000Z"`. Must be within **±5 minutes** of server time. Not epoch seconds. |
| `nonce` | string | yes | 12–128 chars. Must be **unique per endpoint within 5 minutes** (replay window). Reusing one → `401 WEBHOOK_VERIFICATION_FAILED`. |
| `leverage` | number | no | Integer 1–200. Futures entries only; the bot's saved leverage wins if it sets one. |
| `stop_loss` | string | no | Decimal-string price. Attaches a reduce-only stop-market bracket to the entry. |
| `take_profit` | string[] | no | Up to 20 decimal-string prices; each becomes a reduce-only TP bracket order splitting the entry quantity evenly. |
| `reduce_only` | boolean | no | Default `false`. Meaningful only for manual-style flows; CLOSE/PARTIAL_EXIT orders are always reduce-only regardless. |
| `close_percentage` | number | no | 0 < x ≤ 100. Used by `PARTIAL_EXIT` (default 100). |
| `trailing` | object | no | `{ callbackPercent: 0.01–10, enabled?: bool }` — attaches a trailing-stop order to **this run's entry** (futures bots; skipped with a note on spot bots). Overrides the bot's saved trailing config for this run only. |
| `dca` | object | no | Ephemeral DCA override — see below. |
| `breakeven` | object | no | Ephemeral breakeven override — see below. |
| `partialTps` | object | no | Ephemeral partial-TP override — see below. |

\* `size` super-rule: present on trade actions, absent on `MANAGE`.

#### Ephemeral overrides (per-run config)

All three override objects **replace the bot's effective capability config for this single run** — that is the saved config if the bot has one, otherwise the built-in defaults — and enable it unless `"enabled": false` is explicit. Nothing is persisted.

```jsonc
"dca": {
  "triggerDropPercent": 4,        // >0, ≤50 — fire step 1 when price is 4% below entry
  "stepDropPercent": 4,           // optional, ≤50 — spacing for steps 2+
  "amountMode": "FIXED",          // "FIXED" | "PERCENT_EQUITY"
  "amount": 50,                   // >0 — USD (FIXED) or percent (PERCENT_EQUITY)
  "maxSteps": 3                   // 1–20
},
"breakeven": {
  "moveAtProfitPercent": 1.5,     // >0, ≤100 — move SL at +1.5% in favor
  "safeProfitPercent": 0.2        // optional — lock +0.2% instead of exact breakeven
},
"partialTps": {
  "enabled": true,
  "levels": [                     // 1–10 levels; closePercent must sum ≤ 100
    { "pricePercent": 3, "closePercent": 25 },
    { "pricePercent": 8, "closePercent": 50 }
  ]
},
"trailing": { "callbackPercent": 2 }   // entry-bracket override, NOT a management-pass input
```

### Actions — exact semantics

| Action | `size` | Needs existing position? | What the bot does |
|---|---|---|---|
| `BUY` / `LONG` | yes | no | Market buy entry (+ SL/TP/trailing brackets per config/signal). |
| `SELL` / `SHORT` | yes | no | Market sell/short entry (+ brackets). Spot `SELL` entries require base balance. |
| `CLOSE_LONG` | yes* | effectively yes | Reduce-only market sell. Quantity: real position qty (futures) / free base balance (spot) when known, else your `size`. |
| `CLOSE_SHORT` | yes* | effectively yes | Reduce-only market buy to flatten a short (futures). |
| `PARTIAL_EXIT` | yes | yes | Closes `close_percentage`% (default 100) of the live position at market. Skipped if the bot has no readable position state. |
| `REVERSE` | yes | yes | Close current side, then open the opposite side with full bracket logic. Skipped when flat. |
| `MANAGE` | **no** (forbidden) | no | Runs only the management pass (DCA steps, breakeven SL move, partial-TP claims) using saved config + any overrides. No entry/exit orders. Ideal as a periodic "tick" from schedulers. |
| `SET_LEVERAGE`, `MOVE_STOP` | — | — | Schema-valid but inert unless the bot allowlists them; prefer the MCP tools for these. |

\* For CLOSE actions supply your best-known quantity (or `"0"`-style placeholder is **not** valid — `size` must be a positive decimal string; use the actual amount you want as fallback). The bot substitutes the real exchange-side quantity whenever it can read one, so a slightly-stale `size` is safe.

### Symbol routing and market types

Bots are **market-typed**. Your symbol is normalized to the bot's market before anything executes — send whichever form is convenient:

| Bot market type | You send | Executes as | Note |
|---|---|---|---|
| `SPOT` | `BTC/USDT` | `BTC/USDT` | canonical spot form |
| `SPOT` | `BTC/USDT:USDT` | `BTC/USDT` | colon stripped automatically |
| `USDT_FUTURES` | `BTC/USDT` | `BTC/USDT:USDT` | colon appended automatically |
| `USDT_FUTURES` | `BTC/USDT:USDT` | `BTC/USDT:USDT` | canonical futures form |
| `USDT_FUTURES` | `SOL/USDT:SOL` | `SOL/USDT:USDT` | settle coerced to USDT (linear) |
| either | symbol not in bot's configured list | — | fast-skipped, zero exchange calls |
| `USDT_FUTURES` | `BTC/USD` (non-USDT quote) | **rejected** | futures bots trade USDT-quoted pairs only |

Routing happens **before** any network I/O: a mismatched symbol/action/exchange is answered with the normal `202` and recorded as a skipped reason on the bot run — cheap for both sides. Spot bots have no leverage and no trailing stops (requested trailing is skipped with a note); spot CLOSE/PARTIAL_EXIT operate on free base balance.

### Feature compatibility — spot vs futures bots

Every webhook capability works on **both** bot market types unless marked otherwise. Verified behavior:

| Webhook feature | Futures bot | Spot bot | How it works |
|---|---|---|---|
| Entry `BUY`/`LONG`/`SELL`/`SHORT` | ✓ | ✓ | Market order; futures apply leverage/position-mode handling, spot trades 1:1 against balance. |
| Capital-per-trade allocation (fixed $ / % equity / % peak equity / risk %) | ✓ | ✓ | Bot-side sizing; on spot the sizing is leverage-free. Overrides signal `size` when configured. |
| Leverage (`leverage` field or bot config) | ✓ | n/a — ignored | Spot has no leverage; the field is schema-valid but inert on spot bots. |
| Fixed stop-loss bracket (`stop_loss` or bot config) | ✓ | ✓ | Reduce-only-style conditional stop-market; Bybit spot conditionals are mapped automatically (no `triggerDirection`). |
| Take-profit brackets (`take_profit[]` or bot config) | ✓ | ✓ | Conditional TP-market orders splitting the entry quantity evenly. |
| Trailing stop (`trailing` or bot config) | ✓ | **skipped** (run note) | Bybit spot has no trailing-stop order type; everything else in the signal still executes. |
| `CLOSE_LONG` / `CLOSE_SHORT` | ✓ | ✓ | Futures: real exchange position quantity. Spot: sells the **free base balance** (fee-haircut clamped). |
| `PARTIAL_EXIT` / `REVERSE` | ✓ | ✓ | Position state: futures from exchange positions; spot from the fill ledger + free balance. |
| **DCA** (saved config or ephemeral `dca`) | ✓ | ✓ | Futures: entry/mark from exchange positions. Spot: average entry price and quantity are tracked by BOTX's fill ledger, mark price fetched live. Adds market entries on trigger. |
| **Breakeven SL move** (saved config or ephemeral `breakeven`) | ✓ | ✓ | Cancels the previous managed SL and places a new conditional stop at entry (+ safe profit). Works identically on both markets. |
| **Partial TPs** (saved config or ephemeral `partialTps`) | ✓ | ✓ | Market claims at reached levels + resting conditional TP orders for pending levels; resting orders are consumed on fill. Both markets. |
| Ephemeral overrides combine with any action (incl. `MANAGE`) | ✓ | ✓ | Same semantics; `trailing` override is the only spot-degraded piece. |

Spot position tracking detail: spot holdings have no exchange-side position object, so BOTX maintains them in its fill ledger — every recorded fill updates quantity and weighted-average entry price per symbol. That is what powers DCA triggers ("price dropped X% below *my* average entry"), breakeven targets, partial-TP percentages, and spot CLOSE sizing on spot bots. Selling your full balance clears the ledger row automatically; the cron sync never wipes live spot rows.


### Nonce, timestamp, retries — read this before wiring retries

The anti-replay design has direct consequences for your retry logic:

1. **Every accepted request permanently claims its nonce for 5 minutes** (per endpoint). A retry with the same nonce inside the window gets `401 …replay detected`.
2. Therefore:
   - **Transport-level errors** (connection refused/reset, DNS, 5xx before reading a body): the request may or may not have landed. Safe pattern: retry **once** after a short delay **with a fresh nonce and fresh timestamp** ONLY if your strategy tolerates a possible duplicate entry; otherwise don't blind-retry trade signals — send a `MANAGE` tick instead and reconcile via MCP reads.
   - **`401 replay detected`**: your original request **did arrive** earlier. Treat the trade as submitted; do not resend.
   - **Timeout after ~10 s with no response**: same as transport error — ambiguous. Prefer reconciliation over duplication.
3. Generate nonces that are unique under concurrency: `Date.now()` + random suffix, or UUID-with-dashes stripped to ≤128 chars. Minimum 12 chars.
4. Always regenerate `timestamp` per attempt (clock skew between your server and BOTX eats the ±5-min window silently).

### Result feedback loop for your app

Because execution is asynchronous, the `202` means *"accepted and verified"*, not *"filled"*. Options, best first:

1. **Per-bot MCP reads** (programmatic, recommended): authenticate to `https://<host>/api/mcp/bots/<botId>` with the bot password and call `getPositions` / `getOrders` / `getTradeHistory` / `getPortfolio` to confirm the effect of your signal seconds later.
2. **BOTX UI/notifications**: Bots page shows every run (orders, skipped reasons, price, managed-summary) and every delivery (`DELIVERED`/`FAILED`).
3. **Cron-managed autonomy**: you don't need to poll at all — schedule periodic `MANAGE` ticks (e.g. every 1–5 min) and let BOTX's engine handle DCA/breakeven/partial-TP reactions between your signals.

### Reference sender — Node.js (drop-in)

```js
// botx-signal-client.mjs — zero dependencies (Node 18+ built-in fetch)
import { createHmac, randomBytes } from 'node:crypto';

export class BotxSignals {
  /**
   * @param {{ host: string, endpointId: string, signingSecret: string }} opts
   * host e.g. 'https://web-blue-delta-17.vercel.app' (no trailing slash)
   */
  constructor(opts) {
    this.host = opts.host.replace(/\/+$/, '');
    this.endpointId = opts.endpointId;
    this.signingSecret = opts.signingSecret;
  }

  static newNonce() {
    return `${Date.now().toString(36)}${randomBytes(6).toString('hex')}`; // ~20 chars, unique
  }

  sign(body) {
    return createHmac('sha256', this.signingSecret).update(body, 'utf8').digest('hex');
  }

  /**
   * Send one signal. Returns { ok, status, deliveryId?, error? }.
   * Throws only on unreachable host; HTTP errors are returned, not thrown.
   */
  async send(signal) {
    const body = JSON.stringify({
      exchange: 'bybit',
      timestamp: new Date().toISOString(),       // UTC 'Z' ISO string, regenerated per attempt
      nonce: BotxSignals.newNonce(),
      ...signal,
    });
    const res = await fetch(`${this.host}/api/webhooks/tradingview/${this.endpointId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tradingview-signature': this.sign(body) },
      body,                                       // the exact string we signed
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 202) return { ok: true, status: 202, deliveryId: data.deliveryId };
    if (res.status === 401 && /replay/i.test(String(data.message))) {
      return { ok: true, status: 401, deduplicated: true, error: data.message }; // already accepted earlier
    }
    return { ok: false, status: res.status, error: data.message ?? 'rejected' };
  }

  // Convenience wrappers -------------------------------------------------
  enter(symbol, side, size, extra = {}) {
    const action = { long: 'LONG', longBuy: 'BUY', short: 'SHORT', shortSell: 'SELL' }[side] ?? side;
    return this.send({ symbol, action, size: String(size), ...extra });
  }
  closeLong(symbol, size)  { return this.send({ symbol, action: 'CLOSE_LONG',  size: String(size) }); }
  closeShort(symbol, size) { return this.send({ symbol, action: 'CLOSE_SHORT', size: String(size) }); }
  partialExit(symbol, size, closePercentage) {
    return this.send({ symbol, action: 'PARTIAL_EXIT', size: String(size), ...(closePercentage ? { close_percentage: closePercentage } : {}) });
  }
  reverse(symbol, size, extra = {}) { return this.send({ symbol, action: 'REVERSE', size: String(size), ...extra }); }
  manageTick(symbol, overrides = {}) { return this.send({ symbol, action: 'MANAGE', ...overrides }); }
}

// ---- usage ----
// const botx = new BotxSignals({ host: 'https://<host>', endpointId: process.env.BOTX_ENDPOINT_ID, signingSecret: process.env.BOTX_SIGNING_SECRET });
// await botx.enter('BTC/USDT', 'LONG', '0.01', { stop_loss: '89000', take_profit: ['100000'], leverage: 5 });
// setInterval(() => botx.manageTick('BTC/USDT'), 60_000);   // keep the management engine ticking
```

### Reference sender — Python (stdlib only)

```python
# botx_signals.py
import hmac, hashlib, json, time, secrets
from urllib.request import Request, urlopen
from urllib.error import HTTPError

class BotxSignals:
    def __init__(self, host: str, endpoint_id: str, signing_secret: str):
        self.host = host.rstrip("/")
        self.endpoint_id = endpoint_id
        self.secret = signing_secret.encode()

    def _send(self, signal: dict) -> dict:
        payload = {"exchange": "bybit", "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
                   "nonce": f"{int(time.time()*1000):x}{secrets.token_hex(6)}", **signal}
        body = json.dumps(payload, separators=(",", ":"))          # one canonical string
        sig = hmac.new(self.secret, body.encode("utf-8"), hashlib.sha256).hexdigest()
        req = Request(f"{self.host}/api/webhooks/tradingview/{self.endpoint_id}", data=body.encode("utf-8"),
                      headers={"Content-Type": "application/json", "x-tradingview-signature": sig}, method="POST")
        try:
            with urlopen(req, timeout=15) as resp:
                return {"ok": True, "status": resp.status, **json.loads(resp.read())}
        except HTTPError as e:
            detail = e.read().decode(errors="replace")
            dedup = (e.code == 401 and "replay" in detail.lower())
            return {"ok": dedup, "deduplicated": dedup, "status": e.code, "error": detail}

    def enter(self, symbol, side, size, **extra):   # side: LONG SHORT BUY SELL
        return self._send({"symbol": symbol, "action": side, "size": str(size), **extra})

    def close_long(self, symbol, size):   return self._send({"symbol": symbol, "action": "CLOSE_LONG",  "size": str(size)})
    def close_short(self, symbol, size):  return self._send({"symbol": symbol, "action": "CLOSE_SHORT", "size": str(size)})
    def partial_exit(self, symbol, size, pct): return self._send({"symbol": symbol, "action": "PARTIAL_EXIT", "size": str(size), "close_percentage": pct})
    def reverse(self, symbol, size, **extra):  return self._send({"symbol": symbol, "action": "REVERSE", "size": str(size), **extra})
    def manage_tick(self, symbol, **overrides): return self._send({"symbol": symbol, "action": "MANAGE", **overrides})

# usage:
# botx = BotxSignals("https://<host>", os.environ["BOTX_ENDPOINT_ID"], os.environ["BOTX_SIGNING_SECRET"])
# print(botx.enter("BTC/USDT", "LONG", "0.01", stop_loss="89000", take_profit=["100000"], leverage=5))
```

### Implementation checklist for the integrating agent

1. Store `host`, `endpointId`, `signingSecret` as secrets — never log the secret or the signed body together.
2. Build signal object → `JSON.stringify`/`json.dumps` **once** → HMAC that exact string → send it unchanged.
3. Regenerate `timestamp` (UTC ISO `Z`) and `nonce` on **every** attempt.
4. Handle: `202` (accepted), `401` (bad signature/stale timestamp → fix clock/signing; replay → treat as already-submitted), `404/410` (endpoint gone — alert operator), other `4xx` (your payload is invalid — do not retry verbatim).
5. Respect the bot's market type when choosing symbol form (either form works; non-USDT quotes fail on futures bots).
6. Remember `size` is a decimal **string** and is ignored when the bot uses an allocation mode.
7. Add a periodic `MANAGE` tick (1–5 min) so DCA/breakeven/partial-TP react between signals — this replaces you having to implement exit logic.
8. Confirm fills via the per-bot MCP server (`getPositions`/`getOrders`/`getTradeHistory`) when your strategy needs closed-loop feedback.
9. Test end-to-end on a **testnet** exchange account first (create the account with Testnet checked; everything else is identical).
10. Rate expectations: there is no artificial rate limit, but each trade-action signal triggers synchronous exchange calls; keep signal bursts per bot modest (≤ a few per second) and prefer batching decisions in your app.

### Troubleshooting sender integrations

| Symptom | Cause / fix |
|---|---|
| `401 Invalid webhook signature` | Body changed after signing (re-serialization, charset, proxy rewrite). Sign the exact bytes you send. |
| `401 …timestamp outside tolerance` | Your clock or the timestamp format. Use UTC `…Z` ISO strings; sync NTP; ±5 min window. |
| `401 …replay detected` | Nonce reused within 5 min — your earlier request arrived. Don't resend; new nonce for new signals. |
| `422/400` mentioning `size` | `size` sent as JSON number, missing on a trade action, or present on `MANAGE`. Decimal string, correct presence per action. |
| `202` but no order appeared | Normal paths: symbol/action filtered by bot config, allocation mode overrode size, risk skip (min-notional $10 futures/$5 spot, margin, daily-loss breaker), trading toggle off (`LIVE_TRADING_DISABLED`). Check the bot's run reasons on the Bots page. |
| `410` | Bot paused/stopped/deleted — endpoint deactivated. Resume the bot or re-provision. |


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

The app exposes MCP servers over Streamable HTTP — point any MCP client at the URL and the app's own tools/commands do the trading.

- **Global server**: `<origin>/api/mcp` — admin + account management + read tools.
  - **Auth**: `Authorization: Bearer <MCP_PASSWORD>` (falls back to `APP_PASSWORD` if `MCP_PASSWORD` is unset; `x-mcp-password` header also accepted). No auth → `401`.
  - **Protocol**: JSON-RPC 2.0 over streamable HTTP. Supports `initialize`, `tools/list`, `tools/call`, `ping`.
- **Per-bot servers**: `<origin>/api/mcp/bots/<botId>` — one per bot (see Bots page detail view for the exact URL).
  - **Auth**: `Authorization: Bearer <bot password>` — the password you chose at bot creation (the webhook signing secret). Wrong password → `401`; unknown bot → `404`.
  - **Tools**: everything except `listAccounts`, `createBot`, `deleteBot`; trade tools (`placeOrder`, `cancelOrder`, `closePosition`, `closeAll`, `changeLeverage`, `manageBot`) run **only on that bot's account** — no `botId` argument needed.
  - Connect with `npx mcp-remote <origin>/api/mcp/bots/<botId>` and authenticate with the bot password.

### Tools (24)

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
| `placeOrder` | Place a live order **through a bot** — `botId` is required (every trade runs through a bot; on the per-bot server it's injected) |
| `cancelOrder` | Cancel an open order of the bot account |
| `closePosition` | Reduce-only market close for a symbol on the bot account |
| `closeAll` | Close every open position on the bot account |
| `changeLeverage` | Set leverage for a futures instrument on the bot account |
| `manageBot` | Run the position-management pass: DCA, breakeven SL move, partial TP claims for the bot's open positions. Uses the saved config (built-in defaults when unconfigured); optional `dca` / `breakeven` / `partialTps` arguments override for that single run |
| `updateBotConfig` | Replace a bot's saved config (symbols, marketType, allocation, leverage, SL/TP, actions, dca/breakeven/partialTps — `enabled:false` turns a capability off; omitted fields fall back to built-in defaults). Creates a new version. Global server only |
| `createBot` | Create a webhook bot (requires `exchangeAccountId`; optional `password` ≥ 12 chars = shared webhook secret + MCP token; creates a dedicated webhook endpoint and per-bot MCP) |
| `resumeBot` / `pauseBot` | Activate / pause a bot |
| `deleteBot` | Hard-delete a bot (endpoint, runs, versions) |

### Quick start

```bash
# list tools
curl -s -X POST https://<host>/api/mcp \
  -H 'Authorization: Bearer <MCP_PASSWORD>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"demo","version":"1.0"}}}'
```

Then `tools/list` (returns all 24 specs), then `tools/call`:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "getPortfolio", "arguments": {} } }
```

Trade through a bot from the global server:

```json
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": { "name": "placeOrder", "arguments": { "botId": "<botId>", "symbol": "BTC/USDT:USDT", "side": "BUY", "type": "MARKET", "quantity": "0.001" } } }
```

Results are returned as text content: `{ "ok": true, "tool": "...", "correlationId": "...", ...result }`.

To connect Claude Desktop or any MCP client, use the **streamable HTTP** transport with a custom `Authorization: Bearer` header; Claude Code supports streamable HTTP servers directly (see [MCP docs](https://opencode.ai) for your client). The same `MCP_PASSWORD` protects the UI-less API too — keep it random and long.

> [!NOTE]
> `placeOrder` and friends execute **immediately** and cannot be revoked mid-flight; treat the MCP write tools like the manual order form. `cancelOrder` and `closeAll` are your emergency handles from an agent. Calling a trade tool **without** `botId` on the global server fails with `BOT_REQUIRED`.

## 9. Cron maintenance endpoint

`POST /api/cron` runs housekeeping that would otherwise be the BullMQ-era scheduled jobs:

- Auth: `x-cron-secret: <CRON_SECRET>` header (or `Authorization: Bearer <CRON_SECRET>`). Returns 503 if `CRON_SECRET` is unset, 401 on mismatch.
- Runs four jobs in parallel: `checkCircuitBreaker` (re-evaluates the daily-loss breaker), `scanForStaleOrders` (reconciles orders stuck in flight), `syncPositionsNow` (re-fetch positions + mark prices from Bybit), `runAllBotManagement` (runs the DCA/breakeven/partial-TP management pass for every ACTIVE bot — same engine the webhook `MANAGE` action triggers, no signing needed).
- Response: `{ ranAt, breaker, stale, positions, management }` where `management` is one summary per active bot: `{ botId, name, result }` (or `{ botId, name, error }`).

On Vercel, add a cron job (e.g. **every 1 minute**) hitting this endpoint with the secret header — a free cron service like [cron-job.org](https://cron-job.org) supports 1-minute intervals and custom headers:

1. cron-job.org → **Create job**.
2. Request URL: `https://web-blue-delta-17.vercel.app/api/cron` — method `POST`.
3. **Headers**: `x-cron-secret: <CRON_SECRET>` (from your Vercel env).
4. Schedule: **every 1 minute**, timezone UTC. Save and run once to confirm HTTP 200.

This gives you a free, always-on "management ticker": DCA steps, breakeven moves and partial-TP claims are evaluated every minute even when no webhook signal arrives. Note the Vercel Hobby function timeout (10 s default, up to 60 s) — each bot's manage pass takes ~2–4 s, so a handful of bots fits comfortably.

Locally, `curl -X POST http://localhost:3000/api/cron -H "x-cron-secret: $env:CRON_SECRET"`.

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
| `PATCH` / `DELETE` | `/api/exchange-accounts/[id]` | Set primary / delete (`?force=true` also deletes bound bots; 409 `ACCOUNT_IN_USE` otherwise) |
| `GET` / `POST` | `/api/bots` | List / create bots (create body: `name`, `exchangeAccountId`, `password?`, `config`; returns `webhook` + `mcp` access). `DELETE` = delete all bots (optionally `?accountId=`) |
| `PATCH` / `DELETE` | `/api/bots/[id]` | Update config / hard delete |
| `POST` | `/api/bots/[id]/[action]` | `resume` \| `pause` \| `stop` |
| `GET` / `POST` | `/api/orders` | List / place manual order |
| `POST` | `/api/orders/[id]/cancel` | Cancel an order |
| `POST` | `/api/orders/emergency/close-all` | Close all positions (ungated) |
| `GET` | `/api/orders/[id]` | Order intent detail |
| `GET` | `/api/markets?quote=USDT` | Live Bybit markets (cached 15 min; drives the bots symbol picker) |
| `GET` | `/api/portfolio/summary` | Equity, PnL, positions count |
| `GET` | `/api/portfolio/pnl` | Realized PnL |
| `GET` | `/api/portfolio/positions` | Open positions |
| `GET` | `/api/portfolio/executions` | Recent fills |
| `POST` | `/api/webhooks/tradingview/[endpointId]` | **Public** — signed TradingView ingress (bot-owned endpoints) |
| `POST` | `/api/cron` | Maintenance (CRON_SECRET) |
| `GET` / `POST` | `/api/mcp` | **Public** — global MCP server (Bearer `MCP_PASSWORD`) |
| `GET` / `POST` | `/api/mcp/bots/[botId]` | **Public** — per-bot MCP server (Bearer bot password) |
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
│   ├── contracts/             # Zod schemas (orders, TradingView signals, webhook bot config + DCA/breakeven/partial-TP)
│   ├── exchange-core/         # Canonical exchange types/errors/adapter interface
│   ├── exchange-adapters/     # ccxt Bybit adapter (recvWindow 30000, time-sync enabled)
│   ├── trading-core/          # Order sizing, precision alignment, PnL/position math
│   ├── risk-engine/           # evaluateOrder (risk checks), min-notional, sizing
│   ├── bot-engine/            # Webhook strategy: buildWebhookOrders (entry + SL/TP brackets)
│   ├── webhook/               # TradingViewVerifier (HMAC, timestamp, replay)
│   └── commands/              # ALL domain logic: accounts, bots, bot-trade, manage (DCA/breakeven/TP), markets (cached), orders, execute, portfolio, settings
└── scripts/vercel-build.mjs   # Vercel build hook (copies Prisma engine into .next)
```

All packages are bundled into the `.next` build — after editing a package you must rebuild its dist (`node_modules/.bin/tsc -p packages/<pkg>/tsconfig.json`) **and** rerun `next build`.

## Architecture and data model

- **Persistence**: MongoDB, single database `tradingbot`. Prisma models: `ExchangeAccount` (encrypted `apiSecret`, `isPrimary`, `testnet`), `Bot` (bound `exchangeAccountId`, JSON config, versions), `BotRun` (metrics incl. the management pass), `BotState` (per-bot DCA/breakeven/TP progress), `OrderIntent` (exchangeAccountId + `source` records origin: webhook/MCP/manual/bot-manage), `Execution`, `Position`, `WebhookEndpoint` (+ signing secret), `WebhookDelivery` (nonce replay claims), `Notification`, `Settings` (kill switch, daily loss limit, equity/peak), `MarketCache` (15-min markets cache).
- **Position management** (`manageBotPositions`, `packages/commands/src/manage.ts`): runs automatically at the end of every bot run and on demand via the MCP `manageBot` tool. State (DCA step count, breakeven-applied flag, claimed/placed TP levels) persists per bot in `BotState`, so steps don't repeat across runs. Management orders use `btdc-`/`btbr-`/`bttp-`/`btcl-` clientOrderId prefixes and `source.kind: bot-manage`.
- **Clock handling**: this VM drifts; the Bybit adapter always sets `recvWindow: 30000` + `adjustForTimeDifference: true` — requests fail with 10002 otherwise. Never disable.
- **Risk pipeline** (`evaluateOrder`): trading enablement → daily-loss breaker → margin vs. equity → min-notional ($10 futures / $5 spot floor) → leverage bounds → size alignment to exchange precision (`alignAmount`/`alignPrice`, `PRECISION_REJECTED` below `amountMin`).
- **Futures details**: the adapter auto-detects each account's position mode — one-way accounts place orders **without** `positionIdx` (Bybit rejects hedge `positionIdx 1/2` with `10001` on one-way accounts), hedged accounts use `positionIdx 1/2`; SL/TP brackets are reduce-only conditional trigger orders (`orderType: Market`, `triggerPrice`, `triggerDirection`, `triggerBy: LastPrice`); only **ISOLATED** margin is accepted.

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

The production site is deployed from this repo to Vercel. The Vercel project is **connected to GitHub** — every `git push` to `main` triggers a cloud build and auto-deploys to prod:

1. **Automatic deploys** — push to `main`, Vercel builds and deploys. Manual `vercel deploy --prod` from the repo root is only needed for immediate deploys or env-var-only changes (never use `--prebuilt` — cloud assembly fails on missing filePathMap refs; never deploy from `apps/web` — rootDirectory would double-append).
2. **Environment** — set all vars in the Vercel project dashboard (same as `.env`; `DATABASE_URL` pointing at Atlas). Env changes require a manual redeploy to take effect.
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
- Monitor webhook deliveries and bot runs (Bots page) — `routed`/`failed` and `skipped` reasons tell you what actually happened.
- The MCP write tools are live-fire: do not hand the `MCP_PASSWORD` to an untrusted agent.
- Cryptocurrency and leveraged derivatives can cause rapid, total, or greater-than-deposit losses. Software controls reduce operational risk, not market risk.
