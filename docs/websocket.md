# WebSocket Specification

Endpoint: `/realtime`, Socket.IO transport with bearer authentication during connection. Clients send `{ "event": "subscribe", "data": { "topics": ["portfolio", "orders", "positions"] } }`. Topics include portfolio, balances, positions, orders, executions, bots, webhooks, notifications, market data, and system status.

Every server envelope contains version, topic, monotonically increasing sequence, timestamp, correlation ID, and data. Clients persist the latest sequence per topic and send resume cursors when reconnecting. If history is unavailable or a sequence gap is detected, the server sends a fresh snapshot before deltas. Heartbeats run every 20 seconds, slow clients receive a backpressure warning, and connections that exceed bounded buffers are closed with a resumable error code.

Authorization is re-evaluated on subscription and workspace changes. Market topics enforce symbol and rate quotas. Credential data, raw webhook secrets, authentication tokens, and private exchange payloads are never sent over realtime channels.
