# Database Schema

`packages/database/prisma/schema.prisma` is the executable schema. Monetary values use PostgreSQL `DECIMAL(36,18)` and API boundaries use decimal strings. Tenant-owned records carry `workspaceId`; uniqueness constraints protect idempotency, exchange client IDs, webhook nonces, credential versions, bot versions, and external executions.

Identity data is isolated from encrypted exchange credentials. Credential payloads contain AES-256-GCM envelopes and key identifiers, while fingerprints and verified permissions remain queryable. Orders are modeled as durable intents with a strict state machine and immutable executions. Positions are reconciled snapshots rather than assumptions derived only from local fills. Audit events capture actor, workspace, action, target, severity, correlation, and redacted metadata.

High-volume production installations should partition `AuditEvent`, `WebhookDelivery`, executions, and market aggregates by month through SQL migrations, retain only required candle intervals, and archive cold data to object storage. PgBouncer must use transaction pooling only after verifying prepared-statement behavior of the selected Prisma deployment mode.
