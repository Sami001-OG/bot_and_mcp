# Crypto Trading SaaS Platform

A TypeScript monorepo for building a multi-tenant cryptocurrency trading service with exchange adapters, spot and derivatives order models, risk controls, automated bots, TradingView webhook verification, a remote Model Context Protocol (MCP) endpoint, customer/admin interfaces, PostgreSQL, Redis/BullMQ, and container deployment assets.

> [!IMPORTANT]
> This repository is **build-clean but not yet certified for real-money production trading**. The domain primitives, schemas, service entry points, dashboards, infrastructure bases, and documentation compile and test successfully. Several application flows are currently transport/foundation implementations rather than fully persistent production services. Read [Current implementation status](#current-implementation-status) before supplying exchange credentials or enabling live trading.

## Contents

- [What is in the repository](#what-is-in-the-repository)
- [System architecture](#system-architecture)
- [How a trade is intended to flow](#how-a-trade-is-intended-to-flow)
- [Repository map](#repository-map)
- [Applications](#applications)
- [Shared packages](#shared-packages)
- [Database model](#database-model)
- [Exchange integration](#exchange-integration)
- [Trading and futures behavior](#trading-and-futures-behavior)
- [Risk controls](#risk-controls)
- [TradingView webhooks](#tradingview-webhooks)
- [Bots](#bots)
- [MCP server](#mcp-server)
- [REST, GraphQL, and WebSockets](#rest-graphql-and-websockets)
- [Security model](#security-model)
- [Configuration](#configuration)
- [Local development](#local-development)
- [Commands and quality gates](#commands-and-quality-gates)
- [Deployment](#deployment)
- [Observability and operations](#observability-and-operations)
- [Current implementation status](#current-implementation-status)
- [Documentation index](#documentation-index)

## What is in the repository

The platform is organized as five deployable applications and nine shared packages:

| Area | Path | Purpose |
|---|---|---|
| Control-plane API | `apps/api` | NestJS REST endpoints, generated Swagger UI, and Socket.IO realtime namespace |
| Asynchronous workers | `apps/worker` | BullMQ workers for orders, webhooks, bots, reconciliation, and notifications |
| Remote agent interface | `apps/mcp-server` | HTTP MCP server with read and mutation tools |
| Customer interface | `apps/web` | Next.js customer portfolio/trading dashboard |
| Operations interface | `apps/admin` | Next.js admin/security/operations dashboard |
| Runtime contracts | `packages/contracts` | Zod schemas, shared enums, decimal-string rules, and API envelope types |
| Exchange abstraction | `packages/exchange-core` | Canonical exchange types, capabilities, errors, and adapter interface |
| Exchange implementations | `packages/exchange-adapters` | CCXT-backed adapters and exchange capability matrix |
| Trading domain | `packages/trading-core` | Order state machine, position accounting, PnL, and bracket-order generation |
| Risk domain | `packages/risk-engine` | Pre-trade limits, drawdown calculations, liquidation estimates, and circuit breaker |
| Security | `packages/security` | AES-256-GCM envelope encryption, hashing, constant-time comparison, and redaction |
| Webhook verification | `packages/webhook` | TradingView HMAC, timestamp, schema, and replay verification |
| Bot runtime | `packages/bot-engine` | Bot lifecycle and strategy execution contracts |
| Persistence | `packages/database` | Prisma PostgreSQL schema and generated client |

The monorepo uses pnpm workspaces and Turborepo. Node.js 22 is the supported runtime and the package manager is pinned through the root `packageManager` field.

## System architecture

The target architecture separates work into three logical planes.

### Control plane

The control plane accepts users, organization/workspace context, configuration, read requests, and commands. In the target production flow it validates authentication, tenancy, payloads, idempotency, and risk, then commits commands to PostgreSQL with an outbox event. It does **not** wait for an exchange during an HTTP request.

Current control-plane entry points:

- `apps/api/src/main.ts` boots NestJS, Helmet, CORS, validation, correlation IDs, the `/api/v1` prefix, and Swagger at `/docs`.
- `apps/api/src/modules.ts` provides initial health, portfolio, order, bot, webhook, and realtime transports.
- `apps/mcp-server/src/main.ts` exposes an MCP-over-HTTP endpoint for authorized agents.

### Execution plane

The execution plane is responsible for durable work that may be retried, reconciled, rate-limited, or isolated by exchange.

- Redis carries BullMQ jobs.
- `apps/worker/src/main.ts` starts workers for `orders`, `webhooks`, `bots`, `reconciliation`, and `notifications`.
- Exchange workers are intended to decrypt credentials only immediately before an exchange request.
- An ambiguous exchange timeout must enter `RECONCILING`; it must not be blindly submitted again.

The current worker starts and consumes these queues, but its processors return job metadata and are not yet wired to Prisma application services or live adapters.

### Data and market-data plane

PostgreSQL is the authoritative store for identities, workspaces, credentials, policies, orders, executions, positions, bots, webhook deliveries, MCP grants, audit records, outbox records, and idempotency records. Redis is intended for queues, replay claims, coordination, caches, and realtime fan-out.

Canonical market collectors, sequence-gap restoration, persistent OHLCV, order books, funding, open interest, mark/index price, and liquidation streams are architectural targets documented in `docs/architecture.md`; they are not yet running services in this repository.

## How a trade is intended to flow

The production design uses this lifecycle:

1. A REST client, webhook, bot, or MCP client creates an order command.
2. Shared Zod contracts normalize the exchange, market, symbol, side, position side, quantity, prices, time-in-force, leverage, margin mode, client order ID, and idempotency key.
3. Authentication and workspace authorization establish who may act on which exchange account.
4. The risk engine evaluates trading enablement, loss limits, drawdown, exposure, leverage, size, open-position count, and cooldown state.
5. PostgreSQL commits the `OrderIntent`, idempotency response, audit event, and outbox event atomically.
6. An outbox publisher adds an `orders` job to BullMQ.
7. A worker rechecks workspace/account/bot/global kill switches and risk immediately before execution.
8. The worker decrypts the active credential envelope, creates the correct exchange adapter, checks capability support, applies exchange precision/rate rules, and submits.
9. A clear exchange response advances the order state. A timeout or uncertain response advances it to `RECONCILING`.
10. Reconciliation queries orders, client order IDs, fills, and positions before deciding whether a retry is safe.
11. Executions update position quantity, weighted average entry, realized PnL, and audit/realtime events.
12. WebSocket and read-model consumers receive ordered events with sequence numbers and correlation IDs.

Steps 1-4 have executable primitives and initial transports. The atomic persistence, outbox publisher, real execution processor, and reconciliation service described in steps 5-12 remain production work.

## Repository map

```text
.
├── apps/
│   ├── api/                 NestJS API and Socket.IO gateway
│   ├── worker/              BullMQ worker host
│   ├── mcp-server/          Streamable HTTP MCP endpoint
│   ├── web/                 Customer Next.js dashboard
│   └── admin/               Operations Next.js dashboard
├── packages/
│   ├── contracts/           Shared validation and transport types
│   ├── exchange-core/       Exchange abstraction
│   ├── exchange-adapters/   CCXT adapter implementation
│   ├── trading-core/        Order and position domain logic
│   ├── risk-engine/         Risk limits and circuit breaker
│   ├── security/            Encryption and secret-safe helpers
│   ├── webhook/             TradingView verification
│   ├── bot-engine/          Bot lifecycle and strategy contracts
│   └── database/            Prisma schema and generated client
├── docs/                    Architecture and protocol specifications
├── infra/
│   ├── docker/Dockerfile    Multi-stage service image
│   ├── render/render.yaml   Staging service blueprint
│   └── kubernetes/          Initial production Kubernetes base
├── scripts/check-docs.mjs   Required-document validator
├── docker-compose.yml       Local PostgreSQL, Redis, and Mailpit
├── eslint.config.mjs        Flat ESLint configuration
├── tsconfig.base.json       Strict shared TypeScript configuration
├── turbo.json               Monorepo task graph
├── pnpm-workspace.yaml      Workspace and dependency build allowlist
└── .github/workflows/ci.yml CI, scanning, and image publication
```

Build output (`dist`, `.next`), installed dependencies (`node_modules`), the generated Prisma client, and `.workbuddy-ai` project continuity data are not authored source code.

## Applications

### `apps/api`

`apps/api/src/main.ts` performs the HTTP bootstrap:

- enables NestJS raw-body support for future signed-webhook verification;
- prefixes application routes with `/api/v1`;
- applies Helmet security headers;
- enables credentialed CORS for configured origins;
- adds or propagates `x-correlation-id`;
- installs a global validation pipe;
- publishes generated Swagger UI at `/docs`;
- listens on `PORT`, defaulting to `4000`.

`apps/api/src/modules.ts` currently exposes:

| Method | Route | Current behavior |
|---|---|---|
| `GET` | `/api/v1/health` | Returns service status and configured dependency labels |
| `GET` | `/api/v1/portfolio/summary` | Returns an empty decimal-string portfolio summary |
| `GET` | `/api/v1/portfolio/positions` | Returns an empty list |
| `GET` | `/api/v1/portfolio/orders` | Returns an empty list |
| `POST` | `/api/v1/orders` | Parses the canonical order, applies an in-memory demonstration policy, and returns accepted/denied status |
| `POST` | `/api/v1/orders/:id/cancel` | Returns a `CANCEL_PENDING` acknowledgement |
| `POST` | `/api/v1/orders/emergency/close-all` | Returns an emergency-operation acknowledgement |
| `GET` | `/api/v1/bots` | Returns an empty list |
| `POST` | `/api/v1/bots/:id/pause` | Returns `PAUSED` |
| `POST` | `/api/v1/bots/:id/resume` | Returns `ACTIVE` |
| `POST` | `/api/v1/webhooks/tradingview/:endpointId` | Parses a TradingView payload and returns acceptance |

These controllers are deliberately visible as initial transports: they do not currently authenticate, query Prisma, persist idempotency, publish BullMQ jobs, verify the reusable HMAC verifier, or call exchanges.

### `apps/worker`

The worker connects to `REDIS_URL` and starts one BullMQ worker per queue:

- `orders`
- `webhooks`
- `bots`
- `reconciliation`
- `notifications`

Concurrency defaults to `25` and can be set with `WORKER_CONCURRENCY`. Failed jobs produce structured JSON logs. `SIGINT` and `SIGTERM` close workers and Redis cleanly.

The current processors are transport smoke implementations. They must be replaced with durable application services before production use.

### `apps/mcp-server`

The MCP service listens on `MCP_PORT`, defaulting to `4002`.

- `POST /mcp` accepts MCP traffic.
- `GET /health` returns service status.
- Requests require `Authorization: Bearer <token>`.
- Tokens shorter than 32 characters are rejected.
- `MCP_REVOKED_TOKEN_HASHES` can hold comma-separated SHA-256 token hashes that must be denied.
- A new MCP server and streamable HTTP transport are created for each request and closed with the response.

The current token check proves the transport/revocation shape but does not query the `McpClient` table or enforce stored workspace, tool, symbol, exchange-account, notional, leverage, or expiry scopes.

### `apps/web`

The customer Next.js application is a responsive dark dashboard showing portfolio value, PnL, active bots, exchange connectivity, running trades, bot/webhook activity, risk-engine status, and a live-trading indicator. It is currently a static UI model, not a completed authenticated product flow.

Default development URL: `http://localhost:3000`.

### `apps/admin`

The admin Next.js application is an operations view showing active users, order throughput, queue depth, latency, a global kill-switch control, service health, security events, exchange traffic, and incident data. It is currently a static UI model and its controls are not connected to backend mutation services.

Default development URL: `http://localhost:3001`.

## Shared packages

### `packages/contracts`

This package is the canonical boundary for data entering the domain.

- Monetary and quantity values are strings matching decimal syntax. JavaScript floating-point values are not used at the persisted/domain boundary.
- Positive values reject negative strings and zero.
- Supported exchange IDs are `binance`, `bybit`, `okx`, `kucoin`, `kraken`, `coinbase`, `mexc`, and `hyperliquid`.
- Market types are `SPOT`, `MARGIN`, `USDT_FUTURES`, `COIN_FUTURES`, and `PERPETUAL`.
- Position sides are `LONG`, `SHORT`, and `BOTH`.
- Order types include market, limit, stop, stop-market, stop-limit, take-profit, take-profit-market, and trailing-stop.
- The order schema requires `price` or `stopPrice` when the selected order type needs it.
- `clientOrderId` and `idempotencyKey` are mandatory.
- TradingView signals include a nonce and ISO timestamp for replay controls.
- `ApiProblem` models RFC 9457-style errors.
- `RealtimeEnvelope` models versioned, sequenced, correlated events.

### `packages/exchange-core`

This package prevents API and worker code from depending directly on one exchange SDK.

`ExchangeAdapter` requires implementations for connecting, balances, positions, open orders, placement, cancellation, modification, leverage, and margin mode. `AdapterCapabilities` makes unsupported behavior explicit. `ExchangeError` records a stable code plus `retryable` and `ambiguous` flags. The ambiguity flag is important: a request timeout may mean the exchange accepted the order even though the response was lost.

### `packages/exchange-adapters`

`CcxtExchangeAdapter` maps the common interface to CCXT.

Implemented behavior:

- loads exchange markets and verifies a balance request during connection;
- normalizes balance, position, and order records;
- creates, cancels, and conditionally edits orders;
- gets/sets leverage and margin mode when CCXT reports support;
- maps spot/margin/future/delivery/swap defaults from the canonical market type;
- converts exchange network/rate-limit failures into retryable errors;
- marks request timeouts as ambiguous;
- rejects market types that the capability matrix does not claim.

The matrix currently models Binance, Bybit, OKX, KuCoin, Kraken, Coinbase, MEXC, and Hyperliquid. Binance Spot, USDT-M, and COIN-M share the Binance adapter with different `MarketType` values.

Important limitation: generic CCXT support is not the same as live certification. Precision, minimum notional, position mode, account mode, advanced order parameters, and permission behavior must be contract- and sandbox-tested per exchange before enabling funds.

### `packages/trading-core`

The order state machine permits only declared transitions between:

`RECEIVED → VALIDATED → RISK_APPROVED → QUEUED → SUBMITTING → ACKNOWLEDGED → PARTIALLY_FILLED/FILLED`

Cancellation, rejection, failure, and reconciliation branches are also explicit. Invalid transitions throw immediately.

Position accounting:

- represents the current direction as signed quantity;
- computes weighted average entry when scaling in;
- computes realized PnL when reducing or reversing;
- resets average entry when flat;
- computes direction-aware unrealized PnL;
- creates a stop plus percentage-sized take-profit orders for bracket structures.

Percentages supplied to `buildBracketOrders` are not currently checked to total 100; orchestration validation must enforce that in production.

### `packages/risk-engine`

`evaluateOrder` calculates notional and drawdown with `decimal.js`, then checks:

- global/workspace trading enablement;
- daily, weekly, and monthly loss limits;
- maximum drawdown;
- concurrent-position count;
- total exposure;
- leverage;
- position size;
- consecutive-loss cooldown.

Reduce-only orders bypass controls that would otherwise prevent risk reduction. The package also provides a simplified long/short liquidation estimate and an in-memory circuit breaker that opens after a configured number of failures and resets after a configured interval.

The liquidation formula is an estimate, not a substitute for exchange-specific maintenance-margin tiers, fees, funding, and portfolio-margin rules.

### `packages/security`

`EnvelopeEncryption` uses AES-256-GCM:

- the master key must be exactly 32 bytes;
- each encryption uses a random 12-byte IV;
- ciphertext is authenticated with a GCM tag;
- caller-supplied context is bound as additional authenticated data (AAD), preventing an envelope from being moved to a different record/context undetected;
- envelopes record algorithm, version, IV, tag, ciphertext, and key ID.

Additional helpers hash tokens with SHA-256, compare equal-length strings using constant-time comparison, and recursively redact keys matching secret/token/password/private-key/API-key patterns.

Production should source the master key from KMS/HSM or a managed secret store rather than a checked-in environment file.

### `packages/webhook`

`TradingViewWebhookVerifier`:

1. computes an HMAC-SHA256 over the exact raw request body;
2. compares the supplied signature in constant time;
3. parses the shared TradingView signal schema;
4. rejects timestamps outside a default five-minute tolerance;
5. atomically claims `<exchange>:<nonce>` through a caller-provided replay store;
6. rejects a duplicate claim.

A production replay store should use Redis `SET NX EX` semantics or an equivalent atomic operation. The current API webhook controller does not yet invoke this verifier.

### `packages/bot-engine`

The bot package defines ten strategy families: webhook, indicator, DCA, grid, scalping, trend, breakout, mean reversion, arbitrage, and custom.

`BotRuntime` controls lifecycle transitions:

- `DRAFT`, `PAUSED`, or `STOPPED` can activate;
- only `ACTIVE` can pause;
- any state can stop;
- inactive bots ignore ticks and emit no orders;
- active bots delegate to a `TradingStrategy` implementation.

The strategy algorithms, persistent state, schedules, version rollout, market subscriptions, and execution dispatch are not implemented yet.

### `packages/database`

The Prisma schema uses PostgreSQL and stores monetary fields as `DECIMAL(36,18)`. Core models are described below. The generated client is emitted to `packages/database/generated/client` and should be regenerated after schema changes.

## Database model

| Model | Role and important constraints |
|---|---|
| `User` | Email identity, optional password, verification/disable timestamps, sessions, TOTP, memberships, audit relation |
| `IdentityProvider` | Google/GitHub-style subject mapping; unique provider + subject |
| `Session` | Hashed refresh token, device/IP data, expiry and revocation |
| `TotpCredential` | One encrypted TOTP secret per user |
| `Workspace` | Personal or organization tenant; live-trading flag and acknowledgement |
| `WorkspaceMember` | User/workspace role and invite/active/suspended status; unique membership |
| `ExchangeAccount` | Tenant-owned exchange + market account and connection/trading state |
| `ExchangeCredential` | Versioned encrypted credential envelope, fingerprint, permissions, lifecycle |
| `RiskPolicy` | One workspace policy for losses, drawdown, exposure, leverage, size, cooldown, and trading status |
| `OrderIntent` | Canonical order command and state; unique workspace idempotency key and exchange client order ID |
| `Execution` | Fill record; unique exchange execution ID per order |
| `Position` | One exchange-account/symbol/side position with entry, mark, liquidation, leverage, and PnL |
| `Bot` | Strategy identity, status, configuration, schedule, active version, and heartbeat |
| `BotVersion` | Immutable version/checksum record |
| `BotRun` | Runtime interval and metrics |
| `WebhookEndpoint` | Tenant endpoint, token hash, encrypted signing secret, active state |
| `WebhookDelivery` | Nonce, payload hash, attempts, state, and error; nonce unique per endpoint |
| `McpClient` | Hashed token and scoped tools/accounts/symbols/leverage/notional/expiry/revocation |
| `McpInvocation` | Tool invocation decision, result, latency, and correlation audit |
| `AuditEvent` | Actor, action, resource, severity, correlation, request metadata, and timestamp |
| `OutboxEvent` | Durable event awaiting publication |
| `IdempotencyRecord` | Request hash and cached response with expiry; unique key per workspace |

Tenant-owned aggregates carry `workspaceId`. Service code must always authorize the requested workspace and must never accept tenant ownership solely from an untrusted body.

The repository currently contains the schema but not a checked-in SQL migration history. Create and review migrations before staging deployment.

## Exchange integration

To instantiate an adapter:

```ts
import { createExchangeAdapter } from "@platform/exchange-adapters";

const adapter = createExchangeAdapter("binance", "USDT_FUTURES");
await adapter.connect({ apiKey, secret });
```

Exchange credentials can include API key, secret, passphrase, wallet address, and private key. Only fields needed by the selected exchange should be supplied.

The adapter boundary uses decimal strings in canonical records, but CCXT order submission currently converts quantity and price to JavaScript numbers because CCXT's unified method expects numeric arguments. Before production, each adapter must apply exchange precision using loaded market metadata and verify that conversion cannot exceed permitted precision or safe numeric range.

Recommended certification levels are defined in `docs/exchange-certification.md`:

1. contract-tested;
2. sandbox/testnet-tested;
3. live smoke-tested with restricted credentials and minimal notional.

No adapter should be advertised at a higher level without stored evidence.

## Trading and futures behavior

The canonical model supports:

- spot, margin, USDT futures, COIN futures, and perpetual markets;
- buy/sell orders;
- `LONG`, `SHORT`, and `BOTH` position sides;
- cross and isolated margin;
- optional leverage up to the schema limit of 200;
- reduce-only and post-only flags;
- market, limit, stop, take-profit, and trailing-stop families;
- scaling, partial reduction, flattening, and reversal accounting;
- stop-loss and multiple percentage-based take-profit children.

Exchange reality differs. Hedge mode, one-way mode, leverage scope, margin-mode transition rules, reduce-only behavior, trigger direction, and conditional-order parameters must be normalized per exchange. Capability flags should fail unsupported operations before submission.

## Risk controls

Risk checks must occur twice in the target design:

- at command acceptance, giving the user a fast deterministic answer;
- immediately before exchange execution, preventing a stale queued command from bypassing a new halt or changed exposure.

The `RiskPolicy` table and domain function cover numerical limits. Global, workspace, account, and bot kill switches are part of the architecture, but only workspace `tradingEnabled` and bot lifecycle primitives are currently modeled/executable. The admin dashboard kill-switch button is not connected.

## TradingView webhooks

Canonical signal fields include:

- `exchange`
- `symbol`
- `action`: buy, sell, long, short, close long/short, reverse, set leverage, move stop, or partial exit
- `size`
- optional leverage, stop loss, take-profit array, reduce-only, and close percentage
- required `nonce`
- required ISO `timestamp`

The production endpoint should preserve the raw body, load the endpoint signing secret, verify HMAC and replay claims, persist a `WebhookDelivery`, return `202` quickly, and process the signal asynchronously. The existing API route only parses and echoes the signal; use it for transport development, not public internet ingestion.

## Bots

Bots are scoped to a workspace and exchange account. Configuration is stored as JSON with immutable versions and checksums. A production scheduler should enqueue a bot tick/run with a version identifier, acquire a lease/fencing token, load canonical market data, execute the selected strategy, run every proposed order through the shared command/risk path, and update heartbeat/run metrics.

Pause and stop must be checked before each tick and again before each order reaches an exchange. Setup-time authorization does not eliminate the need for these runtime toggles.

## MCP server

The MCP server currently registers these read tools:

- `getPortfolio`
- `getBalance`
- `getPositions`
- `getOrders`
- `getMarketData`
- `getOHLCV`
- `getFundingRate`
- `getOpenInterest`
- `getIndicators`
- `getPerformance`
- `getTradeHistory`
- `getRiskMetrics`

Mutation tools:

- `placeOrder`
- `cancelOrder`
- `closePosition`
- `modifyPosition`
- `changeLeverage`
- `createBot`
- `pauseBot`
- `resumeBot`
- `deleteBot`

The product authorization rule is setup-time approval rather than approval for every trade. The corresponding persisted grant model is `McpClient`: it can restrict tools, exchange accounts, symbols, leverage, notional, expiration, and revocation. The current service does not yet load that model or call shared order services; read tools return empty data and mutations return acceptance envelopes.

## REST, GraphQL, and WebSockets

### REST

REST commands live under `/api/v1`. The intended production convention is:

- bearer authentication;
- explicit workspace context;
- `Idempotency-Key` on trading mutations;
- decimal strings;
- correlation IDs;
- RFC 9457 problem responses;
- cursor pagination for mutable/high-volume collections.

The checked-in contract is `docs/openapi.yaml`; generated Swagger from current controllers is served at `/docs` while the API runs.

### GraphQL

`docs/schema.graphql` defines planned read models for dashboards, portfolios, exchange capabilities, bot performance, and system health. GraphQL dependencies are present in the API package, but no GraphQL module/resolvers are currently registered. Commands should remain REST/MCP because their idempotency and audit semantics must be explicit.

### WebSockets

Socket.IO uses the `/realtime` namespace. The current gateway acknowledges a `subscribe` message containing topic names. The production protocol in `docs/websocket.md` defines authentication, versioned envelopes, sequence numbers, resume cursors, snapshots, heartbeat, and backpressure. Redis fan-out and persisted/resumable delivery are not yet implemented.

## Security model

Implemented primitives:

- Helmet headers and configured CORS;
- AES-256-GCM envelope encryption with AAD context binding;
- hashed MCP revocation matching;
- constant-time signature comparison;
- recursive log redaction;
- signed/replay-protected webhook verifier;
- token/session/credential/grant fields in the data model;
- explicit idempotency and audit models;
- strict TypeScript and payload schemas.

Designed but not yet fully wired:

- Argon2id password hashing;
- Google/GitHub OAuth with PKCE;
- email verification and password reset;
- rotating hashed refresh tokens;
- TOTP enrollment, step-up, and recovery;
- RBAC guards and organization invitations;
- credential create/test/rotate/revoke services;
- KMS/HSM key provider;
- persisted MCP grant authorization;
- rate limiting and abuse controls;
- append-only audit application service;
- secret-safe structured telemetry.

Never commit `.env`, exchange credentials, signing secrets, JWT secrets, or real MCP bearer tokens.

## Configuration

Copy `.env.example` to `.env` for local development and replace all examples.

| Variable | Used/intended by | Meaning |
|---|---|---|
| `NODE_ENV` | All services | Runtime mode |
| `DATABASE_URL` | Prisma/API/workers | PostgreSQL connection string |
| `REDIS_URL` | Workers/queues/replay | Redis connection string |
| `JWT_ACCESS_SECRET` | Planned auth service | Access-token signing secret; use at least 32 random characters |
| `JWT_REFRESH_SECRET` | Planned auth service | Separate refresh-token signing secret |
| `ENCRYPTION_MASTER_KEY_BASE64` | Security/credential service | Base64 encoding of exactly 32 random bytes |
| `WEBHOOK_SIGNING_SECRET` | Webhook service | Local/default signing secret; production endpoints should have independent secrets |
| `API_URL` | Server-side clients | API origin |
| `NEXT_PUBLIC_API_URL` | Browser UI | Public REST base URL |
| `NEXT_PUBLIC_WS_URL` | Browser UI | Public realtime URL |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Planned OAuth | Google application credentials |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Planned OAuth | GitHub OAuth credentials |
| `SMTP_URL` | Planned email service | SMTP endpoint; Mailpit is local default |
| `MCP_PORT` | MCP server | Listening port, default `4002` |
| `MCP_REVOKED_TOKEN_HASHES` | MCP server | Comma-separated SHA-256 hashes denied by the initial transport |
| `PORT` | API | API listening port, default `4000` |
| `CORS_ORIGINS` | API | Comma-separated allowed browser origins |
| `WORKER_CONCURRENCY` | Worker | Per-queue concurrency, default `25` |

Generate a local encryption key with a cryptographically secure tool, for example Node.js:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Do not reuse development secrets in staging or production.

## Local development

### Prerequisites

- Node.js 22 or newer
- pnpm 11.18.0 through Corepack
- Docker with Compose
- available ports: `3000`, `3001`, `4000`, `4002`, `5432`, `6379`, `8025`, and `1025`

### Start dependencies

```bash
corepack enable
cp .env.example .env
docker compose up -d postgres redis mailpit
pnpm install
pnpm db:generate
pnpm db:validate
```

`pnpm-workspace.yaml` includes an explicit dependency build-script allowlist. Prisma, CCXT, esbuild, Sharp, and selected optional native performance packages are allowed; Scarf is explicitly denied.

### Database setup

The schema validates and the client generates, but there is no committed migration history yet. For disposable local development only, you may create a development migration after reviewing the schema:

```bash
pnpm --filter @platform/database exec prisma migrate dev --schema prisma/schema.prisma --name initial
```

For staging/production, generate migrations in a controlled branch, review the SQL, test forward/backward compatibility, and deploy with `prisma migrate deploy` rather than `db push`.

### Run services

```bash
pnpm dev
```

Expected local endpoints:

- Customer UI: `http://localhost:3000`
- Admin UI: `http://localhost:3001`
- API: `http://localhost:4000/api/v1`
- Swagger UI: `http://localhost:4000/docs`
- MCP: `http://localhost:4002/mcp`
- MCP health: `http://localhost:4002/health`
- Mailpit UI: `http://localhost:8025`

Because the API/worker transports are not yet persistent, these services demonstrate the architecture but do not constitute a complete trading environment.

### Stop dependencies

```bash
docker compose down
```

Add `-v` only when you intentionally want to remove the local PostgreSQL and Redis volumes.

## Commands and quality gates

Root commands:

| Command | Purpose |
|---|---|
| `pnpm dev` | Run all development tasks in parallel |
| `pnpm build` | Build the workspace through Turborepo |
| `pnpm lint` | Run package lint tasks |
| `pnpm typecheck` | Run strict TypeScript checks |
| `pnpm test` | Run package unit tests |
| `pnpm test:coverage` | Run coverage variants |
| `pnpm db:generate` | Generate Prisma Client |
| `pnpm db:validate` | Validate the Prisma schema |
| `pnpm docs:check` | Check that required documents exist and are substantive |
| `pnpm quality` | Lint, type-check, test, validate Prisma/docs, and build |

Current verified baseline:

- Prisma schema valid and client generated;
- ESLint passes for first-party apps and packages;
- strict TypeScript passes for all projects;
- 3 test files and 8 unit tests pass;
- all shared packages and backend services compile;
- customer and admin Next.js production builds pass;
- 12 required documentation artifacts pass `scripts/check-docs.mjs`.

Unit tests currently cover encryption/context binding and redaction, order-state/position/PnL behavior, and risk/liquidation behavior. They do not yet cover the full service integration surface.

## Deployment

### Docker

`infra/docker/Dockerfile` builds the whole monorepo, creates an unprivileged `platform` user, and defaults to starting `apps/api/dist/main.js`. Render overrides the command for the worker and MCP server.

The current runtime stage copies the complete build tree, including development dependencies. Before production, split service-specific runtime images or use pnpm deploy/pruning, add a read-only filesystem where possible, pin image digests, and run an image vulnerability/license/SBOM gate.

### Render staging

`infra/render/render.yaml` defines:

- `trading-api-staging`
- `trading-worker-staging`
- `trading-mcp-staging`
- `trading-redis-staging`
- `trading-postgres-staging`

The API health path is `/api/v1/health`; the MCP health path is `/health`. The worker and MCP definitions currently need complete shared environment/secrets wiring before deployment. Customer/admin Render services are not defined yet.

### Kubernetes production base

`infra/kubernetes/platform.yaml` currently supplies:

- namespace `trading-platform`;
- API deployment with three replicas;
- readiness and liveness probes;
- service;
- CPU HPA from 3 to 50 replicas;
- PodDisruptionBudget with two minimum available;
- default-deny ingress and egress policy.

It is a base, not a complete production manifest. Replace the example image, add worker/MCP/web/admin deployments, secrets/config, service accounts, ingress/TLS, explicit network-policy allows, topology spread/anti-affinity, graceful termination, migration jobs, observability agents, and managed database/Redis access.

### CI/CD

`.github/workflows/ci.yml`:

1. starts PostgreSQL and Redis service containers;
2. installs pnpm 11.18.0 and Node.js 22;
3. installs with a frozen lockfile;
4. generates Prisma Client;
5. runs the quality gate;
6. scans the filesystem with Trivy for high/critical findings;
7. on `main`, builds and publishes the image to GitHub Container Registry.

Before production, pin third-party actions by commit SHA, configure environments/approvals, sign images, generate provenance/SBOM, scan the built image, run migrations as a controlled job, deploy progressively, and verify rollback.

## Observability and operations

The target stack is Prometheus, Grafana, and OpenTelemetry. Correlation IDs and some structured worker logs exist, but metrics exporters, traces, dashboards, alert rules, SLOs, and collector deployment files are not yet implemented.

Production operations should monitor at minimum:

- API latency/error/saturation;
- queue depth, age, retries, dead letters, and reconciliation backlog;
- exchange request latency, rate-limit headroom, ambiguous errors, and credential failures;
- webhook acceptance, signature failures, replay attempts, and processing latency;
- order-state age and transition anomalies;
- position divergence and stale market data;
- bot heartbeat/state/version;
- risk denials and kill-switch transitions;
- PostgreSQL connections/locks/replication/backup age;
- Redis memory, persistence, evictions, and failover;
- MCP denials, mutation volume, latency, and grant expiry.

Backups, point-in-time recovery, key rotation, credential rotation, exchange outage, Redis failover, queue poison-message, database restore, and regional recovery need rehearsed runbooks and evidence.

## Current implementation status

### Implemented and validated

- pnpm/Turborepo monorepo and strict TypeScript configuration;
- canonical Zod order and webhook contracts;
- common exchange adapter and CCXT implementation for the requested exchange families;
- order state machine and long/short position/PnL primitives;
- bracket-order generation;
- risk checks, liquidation estimate, and circuit breaker;
- AES-256-GCM envelope encryption and redaction primitives;
- TradingView HMAC/timestamp/replay verifier;
- bot lifecycle and strategy interface;
- multi-tenant Prisma schema;
- initial NestJS, worker, MCP, customer, and admin applications;
- local Docker dependencies, Docker image, Render staging base, Kubernetes base, and CI;
- OpenAPI, AsyncAPI, GraphQL SDL, WebSocket, security, database, deployment, and architecture documentation;
- clean lint, type checks, unit tests, package/backend builds, and Next.js production builds.

### Not yet production-complete

- working email/password authentication;
- Google/GitHub OAuth;
- TOTP enrollment/recovery and step-up;
- verification/reset emails and session rotation;
- persistent RBAC/invitations and tenant guards;
- Prisma-backed controllers/read models;
- SQL migration history;
- transactional idempotency/outbox/audit application services;
- real BullMQ order execution and reconciliation;
- credential create/test/permission/rotation/revoke flows;
- per-exchange precision and live certification;
- complete advanced-order orchestration;
- persisted signed webhook ingestion;
- actual bot strategies and scheduler;
- market-data collectors and indicators;
- GraphQL server/resolvers;
- resumable realtime fan-out;
- persisted scoped MCP authorization and shared command-service integration;
- customer/admin interactive product flows;
- notifications and portfolio exports;
- integration and end-to-end suites;
- performance, 100,000-webhook, and chaos evidence;
- Prometheus/Grafana/OpenTelemetry runtime assets;
- complete Render/Kubernetes production configuration;
- backup/restore, failover, security review, and operational certification.

### Live-trading gate

Do not enable real funds merely because the project compiles. A workspace should be allowed to trade only after all of the following are true:

1. authentication, authorization, audit, and tenant isolation are integration-tested;
2. credentials are encrypted, permission-checked, rotation-tested, and restricted from withdrawals;
3. risk policy and layered kill switches are persisted and rechecked in workers;
4. idempotency and reconciliation have passed outage/timeout tests;
5. the selected exchange/market/account mode is sandbox- and live-smoke-certified;
6. precision, notional, fee, funding, liquidation, and position-mode behavior is verified;
7. alerts, backups, restores, incident procedures, and rollback have been exercised;
8. the user has explicitly acknowledged live trading and enabled the workspace/account/bot toggles.

Until then, use development mocks or a purpose-built paper/testnet execution adapter.

## Documentation index

| File | Content |
|---|---|
| `docs/architecture.md` | Control/execution/data planes, reliability, scale, and security design |
| `docs/architecture-overview.html` | Visual architecture overview |
| `docs/database.md` | Decimal, tenancy, credential, order, partition, and pooling decisions |
| `docs/er-diagram.md` | Mermaid entity-relationship diagram |
| `docs/api.md` | REST, GraphQL, and MCP design responsibilities |
| `docs/openapi.yaml` | Checked-in OpenAPI 3.1 contract |
| `docs/schema.graphql` | Planned GraphQL read schema |
| `docs/websocket.md` | Realtime authentication, topics, sequence/resume, heartbeat, and backpressure |
| `docs/asyncapi.yaml` | Realtime channel contract |
| `docs/security.md` | Identity, encryption, webhook, MCP, and execution security design |
| `docs/deployment.md` | Render staging and Kubernetes production guidance |
| `docs/exchange-certification.md` | Contract, sandbox, and live-smoke certification levels |

## Final safety note

Cryptocurrency trading and leveraged derivatives can cause rapid, total, or greater-than-deposit losses depending on venue and jurisdiction. Software controls reduce operational risk but do not remove market, exchange, custody, liquidity, model, or legal risk. Treat every live-trading release as a security- and safety-critical system change.
