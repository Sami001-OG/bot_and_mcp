# Software Architecture

The system separates the control plane, execution plane, and market-data plane. Stateless NestJS API replicas own authentication, tenancy, command validation, GraphQL read models, OpenAPI, and realtime subscriptions. They never call an exchange during a request. Accepted commands are committed with an outbox event and consumed by isolated BullMQ workers. Execution workers decrypt credentials only immediately before exchange access, re-check every kill switch and risk limit, apply exchange rate limits, and reconcile ambiguous outcomes before retrying.

PostgreSQL is authoritative for identity, configuration, orders, positions, bots, grants, and audit records. Redis supplies queues, distributed coordination, replay locks, hot market snapshots, and WebSocket fan-out. Market collectors maintain exchange streams, detect sequence gaps, restore from snapshots, and publish canonical decimal-string events. Services are horizontally scalable; queue pools can scale independently by workload and exchange.

Security uses tenant-scoped RBAC, short access JWTs, rotating hashed refresh tokens, TOTP step-up for sensitive operations, AES-256-GCM envelope encryption, redacted structured logs, HMAC webhooks, revocable MCP grants, rate controls, and append-only audit events. HSM/KMS integration is represented by the envelope key provider boundary.

Reliability controls include idempotency records, transactional outbox/inbox, dead-letter queues, circuit breakers, exponential backoff with jitter, exchange-specific rate buckets, worker leases with fencing tokens, reconciliation loops, readiness checks, graceful shutdown, and global/workspace/account/bot kill switches.
