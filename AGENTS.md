## Objective
- Multi-tenant live-trading SaaS at `D:\crypto_data\Trading bot mcp`: Binance + Bybit (spot + USDT_FUTURES), TradingView webhooks, auth/tenancy done; **Phase 4 (webhook bots + strategy engine) core is now implemented and E2E-verified.**

## Important Details
- Live/mainnet: Bybit + Binance market scope only; keys in `.env` (gitignored, never echo). Live trading gated by per-account risk acknowledgment; certification = read-only suite.
- **Margin is always ISOLATED** (user requirement): `CROSS` requests → 400 "Only ISOLATED margin mode is supported"; omitted defaults to `ISOLATED` on leveraged accounts; worker always calls `setMarginMode(symbol, order.marginMode ?? 'ISOLATED')` for non-spot.
- Hard-coded minimums live in contracts: `MIN_ORDER_NOTIONAL_USD` = SPOT/MARGIN `'5'`, USDT_FUTURES/COIN_FUTURES/PERPETUAL `'10'`; enforced in both `evaluateOrder` and `sizeOrder` (skip only for reduceOnly / `enforceMinimumNotional: false`).
- Allocation modes (contracts `AllocationSchema`): `PERCENT_EQUITY`, `PERCENT_MAX_EQUITY`, `FIXED_AMOUNT`, `RISK_PERCENT` (needs stopPrice). `OrderRequestSchema` enforces exactly one of `quantity`/`allocation` via superRefine; `ResolvedOrderRequest = Omit<OrderRequest,'quantity'> & {quantity: string}`.
- Redis: BullMQ 5.x needs ≥5.0 — portable **tporadowski Redis 5.0.14.1** at `C:\Users\saifs\AppData\Local\Redis-5`, running on **port 6380** (`.env REDIS_URL=redis://localhost:6380`), no admin/service needed (Memurai winget failed 1603).
- Shell: use `pnpm.cmd`, PowerShell only, no docker, no admin for Program Files/services; each new shell must reload `.env` vars via `Get-Content .env | ForEach-Object { if ($_ -match '^([A-Z0-9_]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') } }`.
- Test user for API smoke tests: `cert@example.com` / `supersecret123` (certified accounts: bybit spot `c951b5b0-e623-44e5-a78c-9325f1bb642f` trading=True, binance spot `92afcb85-25cf-4d15-926c-fd67ceab6980`, bybit usdt-futures `ac99fccd-4598-4a4a-92aa-5ce879d86e69` trading=True; also `alice@example.com`/`supersecret123`, `bob@example.com`/`supersecret456` exist).
- Binance from this machine is intermittently ISP-blocked (`Connect Timeout Error api.binance.com:443`) — environmental; adapter `connect()` retries 3× network errors so transient failures pass.
- Running processes: Redis 6380 (PID 13088), API PID 7736, worker PID 1780, web `next start` PID 9932 (port 3000); logs `C:\Users\saifs\AppData\Local\Temp\opencode\api-p4.log` / `worker-p4.log` / `web-p4.log` (+ `-err`). API/worker run as `node --env-file=../../.env dist/main.js` from `apps/api` / `apps/worker`; web as `node node_modules/next/dist/bin/next start -p 3000` from `apps/web`. Web dashboard `/bots` is the Bots console (client-side; login via `apps/web/lib/session.ts` `apiFetch`).
- **Prisma gotcha:** this Prisma 6.19 wasm validator **rejects string-literal defaults** (`@default('info')` → P1012 "not a valid field or attribute definition"); use existing enums (e.g. `Severity`) or `@default(INFO)` style instead.
- Notification model: `channel`, `severity` (Severity enum), `title`, `message?`, `payload?`, `readAt?` — written by the worker `notifications` queue (`notify` jobs, 30s window dedup + jobId dedup); API `NotificationsController` (`GET /notifications`, `GET /notifications/unread/count`, `POST /notifications/:id/read`, `POST /notifications/read-all`).
- Webhook signature scheme (TradingView standard): HMAC-SHA256 hex of the **raw body** with endpoint signing secret, sent as `x-tradingview-signature` header; verifier also enforces ±5-min timestamp tolerance and Redis replay claim (`wh:replay:{endpointId}:{exchange}:{nonce}` NX/EX 300s). **Signing secret is returned once at endpoint creation** (`signingSecret` field) and never again — store it.

## Work State
### Completed
- Phase 2: Bybit `getPositions` spot → `[]`; `connect()` 3-attempt network retry; `getOrder(orderId, symbol)` + `getPrice(symbol)` on adapters; certification suite + `CertificationRun` model (smoke: both spot accounts VERIFIED, gates opened).
- Phase 3: worker execution hardening — idempotent execute (existing `exchangeOrderId` → reconcile, dedup by `exchangeExecutionId`), `handleOrderError` returns final state (no spurious retries), redundant-cancel guard, per-account close-all, reconciliation queue (resync + 30s stale scan). Verified: exactly one job result per order.
- Allocation sizing `sizeOrder()` in `packages/trading-core` (4 modes, margin-aware, min-notional); DB `equity`/`peakEquity`/`allocation`/`leverage`/`marginMode`; API `resolveMarketSnapshot` live price+balance; 409/400/503 handling; worker re-sizes allocations at execution with fresh price/balance + `setLeverage`.
- **Phase 4 core (this session):**
  - `WebhookBotConfigSchema` in contracts (`symbols`, `allocation`, `leverage`, `stopLoss`, `takeProfits`, `requireSignalStopLoss`, `actions` filter).
  - `packages/bot-engine/src/strategy.ts`: `buildWebhookOrders()` pure engine — actions BUY/SELL/LONG/SHORT (entry + SL + TP bracket), CLOSE_LONG/CLOSE_SHORT (reduceOnly close), REVERSE (close + open opposite, needs live position side), PARTIAL_EXIT (size × close_percentage), SET_LEVERAGE/MOVE_STOP skipped as unsupported; config overrides signal SL/TPs; allocation sizing with `sizeOrder`; per-bot idempotency keys `${nonce}:{entry|sl|tp:i|close|partial}:{botId}`, clientOrderIds `wh-*`. `WebhookSignalStrategy` implements `TradingStrategy`. **14 unit tests green.** (Also fixed latent bug: TP orders now use `stopPrice` not `price`.)
  - API: `POST /bots` (validates config, requires VERIFIED + tradingEnabled account, creates BotVersion v1 + checksum, status ACTIVE), `GET /bots/:id` (versions + last 20 runs), `PATCH /bots/:id/config` (bumps `activeVersion`, new version row), `POST /bots/:id/stop`, existing pause/resume. Webhook ingress now runs real `TradingViewWebhookVerifier` with rawBody when signature present (else accepts unsigned).
  - Worker `processWebhook` rewritten: routes signal to ACTIVE WEBHOOK bots in workspace; per bot: connect adapter → live price + quote-currency free balance (equity) + position side (for REVERSE/PARTIAL_EXIT) → `buildWebhookOrders` → risk-check entries (`evaluateOrder` w/ live equity, skips min-notional when price unresolved) → persist orders + enqueue execute → `BotRun` STOPPED with metrics {price, orders, skipped, notes, positionSide}; per-bot failures → run ERROR; delivery FAILED only if any run failed, else DELIVERED with `routed`/`failed`/`bots` summary.
  - `@platform/bot-engine` added to worker + `@platform/webhook` to API deps.
- Full build/lint/typecheck green; all unit tests pass (security 2, auth 4, risk 3, trading-core 10, adapters 2, bot-engine 14).
- **Live E2E smoke (Bybit mainnet, empty accounts):** signed BUY → 202 → bot run STOPPED with 3 orders (entry+SL+TP) → executed → REJECTED InsufficientFunds (expected); allocation FIXED_AMOUNT 100/10x correctly skipped with "Order margin exceeds available equity" (0 equity); corrupted signature → 401 "Invalid webhook signature"; replayed nonce → 401 "Webhook replay detected"; 11-min-old timestamp → 401 "Webhook timestamp outside tolerance"; fresh nonce → 202; CLOSE_LONG → single reduceOnly SELL order persisted+executed (REJECTED InsufficientFunds). Versioning: PATCH config → activeVersion 2.
- **UI + real workers (this session):**
  - Bots console in `apps/web`: `/bots` page (login gate, bot list w/ resume/pause/stop, detail panel w/ runs timeline + versions, create-bot modal w/ symbol array, allocation modes, leverage/SL/TP, allowed-action checkboxes) wired to API via `apiFetch<T>`; home sidebar "Bots" now navigates to `/bots`. Fixed `exactOptionalPropertyTypes` bug in `apiFetch` (conditional `init.body`). Build/lint/typecheck green; `/bots` serves 200 on :3000.
  - Worker: extracted `runBotEvaluation()` (connect → live price/equity/positionSide → `buildWebhookOrders` → risk → persist + enqueue → BotRun STOPPED/ERROR) shared by `processWebhook` and the **now-real `bots` queue** (`run` job: evaluate an ACTIVE bot on demand). `notifications` queue real: `createNotification` processor (30s dedup) + `queueNotification` producer; webhook pipeline emits per-bot-run + per-delivery notifications.
  - DB: new `Notification` model (channel/severity/title/message/payload/readAt, workspace cascade) via `prisma db push`.
  - API: `NotificationsController` — GET list, GET unread/count, POST `:id/read`, POST `read-all`.
  - Live smoke: signed BUY → 202 → routed 1/failed 0, runId recorded, 3 orders REJECTED InsufficientFunds, **2 notifications created** (bot + webhook channels), read-all → unread 0, single-read → already-read.
- Smoke artifacts (persist for reuse): endpoint `000b6de0-1c14-46b8-8991-e39cba7de7ce` (name smoke-p4), signing secret `60784fc0-bb7e-4758-812c-a1356c9b195b`, bot `4adadf7b-de8f-4ecb-a3bc-cd2ddacae174` (btc-entry-bot, ACTIVE, v2 config = signal.size path).

### Active
- Phase 4 core done; no outstanding blockers.

### Blocked
- (none) — mainnet accounts are empty (orders reject with InsufficientFunds / below-min / margin-exceeds-equity), so filled-order/reconciliation/partial-exit paths can only be unit-tested until funded. REVERSE/PARTIAL_EXIT need a live position (`positionSide` in run metrics shows it being fetched).

## Next Move
1. Fill/partial-fill E2E once accounts funded; then reconciliation + stop-loss ladder verification (STOP_MARKET/TAKE_PROFIT_MARKET brackets with real positions).
2. Wire `notifications` into the web console UI (unread badge / list) — endpoints are live.
3. Optional: schedule bots (`bots` queue `run` job exists; add a cron/scheduler producer).

## Relevant Files
- `packages/bot-engine/src/strategy.ts` (+ `strategy.test.ts`) — NEW: signal→order engine, 14 tests.
- `apps/worker/src/main.ts` — `runBotEvaluation`, `processWebhook` bot routing, `createNotification`/`queueNotification`, `persistOrder`, execution pipeline.
- `apps/api/src/modules.ts` — `BotsController` (create/get/config/pause/resume/stop), `NotificationsController`, `WebhookIngressController` (HMAC verify + Redis replay), webhook create returns `signingSecret`.
- `apps/web/app/bots/page.tsx` + `apps/web/lib/session.ts` + `apps/web/app/styles.css` — Bots console.
- `packages/contracts/src/index.ts` — `WebhookBotConfigSchema`, `AllocationSchema`, `OrderRequestSchema`, `MIN_ORDER_NOTIONAL_USD`, `TradingViewSignalSchema` (requires `exchange`/`size`/`timestamp`).
- `packages/trading-core/src/index.ts` — `sizeOrder`, bracket builder.
- `packages/risk-engine/src/index.ts` — `evaluateOrder`.
- `packages/webhook/src/index.ts` (+ tests) — `TradingViewWebhookVerifier`.
- `packages/database/prisma/schema.prisma` — Bot/BotVersion/BotRun/WebhookEndpoint/WebhookDelivery/Notification, certification, equity/peakEquity.
- `.env` — mainnet keys, `REDIS_URL=redis://localhost:6380`, `ENCRYPTION_KEY`, JWT secrets.
