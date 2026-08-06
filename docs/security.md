# Security Model

Passwords use Argon2id. OAuth uses authorization code with PKCE and exact redirect URI allowlists. Access JWTs are short-lived; refresh tokens are single-use, hashed at rest, rotated, device-bound where practical, and reuse revokes the session family. TOTP and recovery codes provide step-up authentication for credential changes, live-trading enablement, MCP grants, kill switches, and high-risk admin actions.

Exchange secrets use AES-256-GCM with associated data binding workspace, account, and credential version. The master key is injected from a secret manager and can be replaced by a KMS/HSM envelope provider. Secrets are decrypted only in execution workers, zeroed when possible, excluded from API serializers, and redacted recursively from logs.

Controls cover CSRF, strict CSP and security headers, output encoding, schema validation, parameterized database access, CORS allowlists, SSRF-safe outbound destinations, request/body limits, IP and account rate limiting, webhook HMAC with nonce replay locks, MCP scope enforcement, RBAC, tenant-isolation tests, secret scanning, dependency/SAST/container scanning, and append-only audit records.

Live execution requires verified exchange permissions, configured risk limits, and recorded acknowledgement. Every execution worker re-checks global, workspace, account, bot, and circuit-breaker states immediately before an external mutation.
