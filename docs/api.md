# REST, GraphQL, and MCP API

REST commands are versioned under `/api/v1`. Every trading mutation requires bearer authentication, workspace context, and `Idempotency-Key`. Decimal values are strings. Error responses follow RFC 9457 problem details with correlation IDs. Cursor pagination is used for orders, trades, logs, audit records, and webhook deliveries.

Core REST resources: authentication and sessions; workspaces, members, roles, and invitations; exchange accounts, credential tests, rotations, and capabilities; portfolio, balances, positions, orders, executions, trades, transfers, fees, and exports; risk policies, halts, circuit states, and kill switches; bots, versions, schedules, runs, metrics, and logs; TradingView endpoints and deliveries; notification channels; MCP clients and grants; admin users, health, incidents, flags, and audit search.

GraphQL is limited to composed read models such as dashboard, portfolio analytics, exchange capability matrix, bot performance, and admin health. Production enables depth, complexity, and persisted-query controls. Commands remain REST to preserve explicit idempotency and audit semantics.

The MCP server exposes the requested portfolio, balance, position, order, market, indicator, bot, performance, history, and risk tools. Mutations are authorized by a revocable setup-time grant containing tool, workspace, exchange-account, symbol, leverage, notional, and expiry scopes. All MCP mutations use the same command application services and risk checks as REST.
