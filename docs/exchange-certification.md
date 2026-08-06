# Exchange Capability and Certification

All adapters implement the common interface through `packages/exchange-core` and normalize provider behavior through `packages/exchange-adapters`. The current capability matrix covers Binance Spot, USDT-M and COIN-M; Bybit; OKX; KuCoin; Kraken; Coinbase; MEXC; and Hyperliquid. Capabilities are explicit data and unsupported operations fail before submission.

Certification levels are: contract-tested against the deterministic adapter harness; sandbox-tested where the provider offers a representative environment; and live-smoke-tested with user-supplied restricted credentials. A provider is not described as live-certified until connection, balance, precision, order placement, cancellation, position, leverage, margin mode, rate-limit, timeout ambiguity, and reconciliation scenarios pass for the relevant market type.

Provider APIs evolve. Pin and audit the CCXT version, run adapter contract suites on every dependency update, review upstream exchange notices, and require a capability report before promotion. Credential-gated smoke tests must use minimal notional, dedicated accounts, IP allowlists, and immediate cleanup.
