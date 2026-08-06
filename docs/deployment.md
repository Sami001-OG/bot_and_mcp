# Deployment Guide

Render is the staging target through `infra/render/render.yaml`. Production images are built from `infra/docker/Dockerfile` and deployed to Kubernetes using `infra/kubernetes/platform.yaml` as the base. Use managed PostgreSQL with point-in-time recovery, managed Redis with persistence and no-eviction policy, an ingress with TLS, private service networking, and an external KMS/secret manager.

Before deployment, create independent 32-byte JWT and encryption secrets, configure OAuth callbacks, SMTP, CORS, DNS, and exchange egress IPs. Run Prisma migrations as a single controlled pre-deploy job, then deploy workers, API, MCP, web, admin, and market collectors. Never run concurrent schema migrations from application replicas.

Scale webhook/API replicas by request latency and admission rate; scale order workers by queue age and exchange-specific limits; scale market collectors by exchange and symbol partitions. Configure PodDisruptionBudgets, anti-affinity, HPA, network policies, termination grace periods, and readiness gates. Keep exchange execution concurrency below provider limits even when worker replicas increase.

Monitor queue lag, webhook p95/p99, order acknowledgement and reconciliation latency, stale market feeds, exchange error classes, circuit states, database saturation, Redis memory, WebSocket fan-out, authentication anomalies, and risk halts. Backups and restores, key rotation, kill switch, exchange outage, queue replay, and rollback procedures must be exercised before production enablement.
