-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- required for User.email @db.Citext (trusted extension, DB owner can create)
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateEnum
CREATE TYPE "WorkspaceType" AS ENUM ('PERSONAL', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ExchangeName" AS ENUM ('BINANCE', 'BYBIT', 'OKX', 'KUCOIN', 'KRAKEN', 'COINBASE', 'MEXC', 'HYPERLIQUID');

-- CreateEnum
CREATE TYPE "MarketType" AS ENUM ('SPOT', 'MARGIN', 'USDT_FUTURES', 'COIN_FUTURES', 'PERPETUAL');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('PENDING', 'VERIFIED', 'ROTATING', 'REVOKED', 'FAILED');

-- CreateEnum
CREATE TYPE "OrderState" AS ENUM ('RECEIVED', 'VALIDATED', 'RISK_APPROVED', 'QUEUED', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'CANCELED', 'REJECTED', 'RECONCILING', 'FAILED');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "PositionSide" AS ENUM ('LONG', 'SHORT', 'BOTH');

-- CreateEnum
CREATE TYPE "MarginMode" AS ENUM ('CROSS', 'ISOLATED');

-- CreateEnum
CREATE TYPE "BotType" AS ENUM ('WEBHOOK', 'INDICATOR', 'DCA', 'GRID', 'SCALPING', 'TREND', 'BREAKOUT', 'MEAN_REVERSION', 'ARBITRAGE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "BotStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'STOPPED', 'ERROR');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "displayName" TEXT,
    "passwordHash" TEXT,
    "emailVerifiedAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityProvider" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerSubject" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TotpCredential" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "encryptedSecret" JSONB NOT NULL,
    "enabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TotpCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" UUID NOT NULL,
    "type" "WorkspaceType" NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "liveTradingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "liveTradingAcknowledgedAt" TIMESTAMP(3),
    "dailyLossLimit" DECIMAL(20,8),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "status" "MemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeAccount" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "exchange" "ExchangeName" NOT NULL,
    "marketType" "MarketType" NOT NULL,
    "label" TEXT NOT NULL,
    "externalAccountId" TEXT,
    "credentialStatus" "CredentialStatus" NOT NULL DEFAULT 'PENDING',
    "tradingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "equity" DECIMAL(36,18),
    "peakEquity" DECIMAL(36,18),
    "lastConnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExchangeAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CertificationRun" (
    "id" UUID NOT NULL,
    "exchangeAccountId" UUID NOT NULL,
    "credentialVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "checks" JSONB NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CertificationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeCredential" (
    "id" UUID NOT NULL,
    "exchangeAccountId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "keyId" TEXT NOT NULL,
    "encryptedPayload" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "permissions" TEXT[],
    "status" "CredentialStatus" NOT NULL DEFAULT 'PENDING',
    "activatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskPolicy" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "maxDailyLoss" DECIMAL(36,18) NOT NULL,
    "maxWeeklyLoss" DECIMAL(36,18) NOT NULL,
    "maxMonthlyLoss" DECIMAL(36,18) NOT NULL,
    "maxDrawdownPercent" DECIMAL(10,4) NOT NULL,
    "maxConcurrentPositions" INTEGER NOT NULL,
    "maxExposure" DECIMAL(36,18) NOT NULL,
    "maxLeverage" INTEGER NOT NULL,
    "maxRiskPerTrade" DECIMAL(36,18) NOT NULL,
    "maxPositionSize" DECIMAL(36,18) NOT NULL,
    "consecutiveLossCooldown" INTEGER NOT NULL,
    "tradingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderIntent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "exchangeAccountId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "clientOrderId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "positionSide" "PositionSide" NOT NULL,
    "orderType" TEXT NOT NULL,
    "marketType" "MarketType" NOT NULL,
    "quantity" DECIMAL(36,18) NOT NULL,
    "price" DECIMAL(36,18),
    "stopPrice" DECIMAL(36,18),
    "leverage" INTEGER,
    "marginMode" "MarginMode",
    "reduceOnly" BOOLEAN NOT NULL DEFAULT false,
    "postOnly" BOOLEAN NOT NULL DEFAULT false,
    "allocation" JSONB,
    "state" "OrderState" NOT NULL DEFAULT 'RECEIVED',
    "rejectionReason" TEXT,
    "exchangeOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Execution" (
    "id" UUID NOT NULL,
    "orderIntentId" UUID NOT NULL,
    "exchangeExecutionId" TEXT NOT NULL,
    "quantity" DECIMAL(36,18) NOT NULL,
    "price" DECIMAL(36,18) NOT NULL,
    "fee" DECIMAL(36,18) NOT NULL,
    "feeAsset" TEXT,
    "executedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "exchangeAccountId" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "PositionSide" NOT NULL,
    "marginMode" "MarginMode" NOT NULL,
    "quantity" DECIMAL(36,18) NOT NULL,
    "averageEntryPrice" DECIMAL(36,18) NOT NULL,
    "markPrice" DECIMAL(36,18) NOT NULL,
    "liquidationPrice" DECIMAL(36,18),
    "leverage" INTEGER NOT NULL,
    "unrealizedPnl" DECIMAL(36,18) NOT NULL,
    "realizedPnl" DECIMAL(36,18) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bot" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "exchangeAccountId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "BotType" NOT NULL,
    "status" "BotStatus" NOT NULL DEFAULT 'DRAFT',
    "activeVersion" INTEGER NOT NULL DEFAULT 1,
    "schedule" TEXT,
    "config" JSONB NOT NULL,
    "lastHeartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotVersion" (
    "id" UUID NOT NULL,
    "botId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotRun" (
    "id" UUID NOT NULL,
    "botId" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),
    "status" "BotStatus" NOT NULL,
    "metrics" JSONB NOT NULL,

    CONSTRAINT "BotRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "encryptedSigningSecret" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" UUID NOT NULL,
    "endpointId" UUID NOT NULL,
    "nonce" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "severity" "Severity" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "message" TEXT,
    "payload" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpClient" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "allowedTools" TEXT[],
    "allowedExchangeAccountIds" TEXT[],
    "allowedSymbols" TEXT[],
    "maxLeverage" INTEGER NOT NULL,
    "maxNotional" DECIMAL(36,18) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpInvocation" (
    "id" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "tool" TEXT NOT NULL,
    "argumentsHash" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "resultCode" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "correlationId" TEXT NOT NULL,
    "invokedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpInvocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID,
    "actorUserId" UUID,
    "actorType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "severity" "Severity" NOT NULL DEFAULT 'INFO',
    "correlationId" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "IdentityProvider_provider_providerSubject_key" ON "IdentityProvider"("provider", "providerSubject");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshTokenHash_key" ON "Session"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "TotpCredential_userId_key" ON "TotpCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE INDEX "WorkspaceMember_userId_status_idx" ON "WorkspaceMember"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_userId_key" ON "WorkspaceMember"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "ExchangeAccount_workspaceId_exchange_idx" ON "ExchangeAccount"("workspaceId", "exchange");

-- CreateIndex
CREATE INDEX "CertificationRun_exchangeAccountId_startedAt_idx" ON "CertificationRun"("exchangeAccountId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeCredential_exchangeAccountId_version_key" ON "ExchangeCredential"("exchangeAccountId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "RiskPolicy_workspaceId_key" ON "RiskPolicy"("workspaceId");

-- CreateIndex
CREATE INDEX "OrderIntent_workspaceId_state_createdAt_idx" ON "OrderIntent"("workspaceId", "state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderIntent_workspaceId_idempotencyKey_key" ON "OrderIntent"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "OrderIntent_exchangeAccountId_clientOrderId_key" ON "OrderIntent"("exchangeAccountId", "clientOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Execution_orderIntentId_exchangeExecutionId_key" ON "Execution"("orderIntentId", "exchangeExecutionId");

-- CreateIndex
CREATE INDEX "Position_workspaceId_updatedAt_idx" ON "Position"("workspaceId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Position_exchangeAccountId_symbol_side_key" ON "Position"("exchangeAccountId", "symbol", "side");

-- CreateIndex
CREATE INDEX "Bot_workspaceId_status_idx" ON "Bot"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BotVersion_botId_version_key" ON "BotVersion"("botId", "version");

-- CreateIndex
CREATE INDEX "BotRun_botId_startedAt_idx" ON "BotRun"("botId", "startedAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_receivedAt_idx" ON "WebhookDelivery"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_endpointId_nonce_key" ON "WebhookDelivery"("endpointId", "nonce");

-- CreateIndex
CREATE INDEX "Notification_workspaceId_createdAt_idx" ON "Notification"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpClient_tokenHash_key" ON "McpClient"("tokenHash");

-- CreateIndex
CREATE INDEX "McpClient_workspaceId_expiresAt_idx" ON "McpClient"("workspaceId", "expiresAt");

-- CreateIndex
CREATE INDEX "McpInvocation_clientId_invokedAt_idx" ON "McpInvocation"("clientId", "invokedAt");

-- CreateIndex
CREATE INDEX "AuditEvent_workspaceId_occurredAt_idx" ON "AuditEvent"("workspaceId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_action_occurredAt_idx" ON "AuditEvent"("action", "occurredAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_occurredAt_idx" ON "OutboxEvent"("publishedAt", "occurredAt");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_workspaceId_key_key" ON "IdempotencyRecord"("workspaceId", "key");

-- AddForeignKey
ALTER TABLE "IdentityProvider" ADD CONSTRAINT "IdentityProvider_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TotpCredential" ADD CONSTRAINT "TotpCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExchangeAccount" ADD CONSTRAINT "ExchangeAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CertificationRun" ADD CONSTRAINT "CertificationRun_exchangeAccountId_fkey" FOREIGN KEY ("exchangeAccountId") REFERENCES "ExchangeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExchangeCredential" ADD CONSTRAINT "ExchangeCredential_exchangeAccountId_fkey" FOREIGN KEY ("exchangeAccountId") REFERENCES "ExchangeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskPolicy" ADD CONSTRAINT "RiskPolicy_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderIntent" ADD CONSTRAINT "OrderIntent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderIntent" ADD CONSTRAINT "OrderIntent_exchangeAccountId_fkey" FOREIGN KEY ("exchangeAccountId") REFERENCES "ExchangeAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_orderIntentId_fkey" FOREIGN KEY ("orderIntentId") REFERENCES "OrderIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_exchangeAccountId_fkey" FOREIGN KEY ("exchangeAccountId") REFERENCES "ExchangeAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bot" ADD CONSTRAINT "Bot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bot" ADD CONSTRAINT "Bot_exchangeAccountId_fkey" FOREIGN KEY ("exchangeAccountId") REFERENCES "ExchangeAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotVersion" ADD CONSTRAINT "BotVersion_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotRun" ADD CONSTRAINT "BotRun_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpClient" ADD CONSTRAINT "McpClient_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpInvocation" ADD CONSTRAINT "McpInvocation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "McpClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

