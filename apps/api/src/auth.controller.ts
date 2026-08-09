import { randomBytes } from 'node:crypto';
import { Body, Controller, Get, Headers, HttpCode, HttpException, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Prisma, prisma, type User } from '@platform/database';
import { workspaceHandleFromEmail } from '@platform/contracts';
import { createAccessToken, generateRefreshToken, hashPassword, hashRefreshToken, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, verifyPassword } from '@platform/auth';
import { AuthGuard, type AuthedRequest } from './guards.js';

const EmailSchema = z.string().trim().toLowerCase().email('Valid email required');
const PasswordSchema = z.string().min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`).max(MAX_PASSWORD_LENGTH);
const RegisterSchema = z.object({ email: EmailSchema, password: PasswordSchema, displayName: z.string().trim().min(1).max(80).optional() });
const LoginSchema = z.object({ email: EmailSchema, password: z.string().min(1) });
const RefreshSchema = z.object({ refreshToken: z.string().min(32).max(256) });

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const DEFAULT_RISK_POLICY = {
  maxDailyLoss: '1000',
  maxWeeklyLoss: '3000',
  maxMonthlyLoss: '10000',
  maxDrawdownPercent: '20',
  maxConcurrentPositions: 10,
  maxExposure: '100000',
  maxLeverage: 20,
  maxRiskPerTrade: '500',
  maxPositionSize: '25000',
  consecutiveLossCooldown: 3,
  tradingEnabled: true
};

function publicUser(user: User) {
  return { id: user.id, email: user.email, displayName: user.displayName ?? null, emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null };
}

function publicWorkspace(workspace: { id: string; name: string; slug: string; handle: string; liveTradingEnabled: boolean; liveTradingAcknowledgedAt: Date | null }) {
  return { id: workspace.id, name: workspace.name, slug: workspace.slug, handle: workspace.handle, liveTradingEnabled: workspace.liveTradingEnabled, liveTradingAcknowledgedAt: workspace.liveTradingAcknowledgedAt?.toISOString() ?? null };
}

async function uniqueWorkspaceHandle(tx: Prisma.TransactionClient, email: string): Promise<string> {
  const base = workspaceHandleFromEmail(email);
  let candidate = base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const taken = await tx.workspace.findUnique({ where: { handle: candidate }, select: { id: true } });
    if (!taken) return candidate;
    const head = base.slice(0, 31 - String(suffix).length);
    candidate = `${head}-${suffix}`;
  }
  throw new HttpException('Could not allocate a unique workspace handle', HttpStatus.CONFLICT);
}

function clientIp(request: AuthedRequest): string {
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
}

async function defaultMembership(userId: string) {
  const membership = await prisma.workspaceMember.findFirst({ where: { userId, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' }, include: { workspace: true, user: true } });
  if (!membership) throw new HttpException('No active workspace for this account', HttpStatus.FORBIDDEN);
  return membership;
}

async function issueSession(membership: Awaited<ReturnType<typeof defaultMembership>>, userAgent?: string, ipAddress?: string) {
  const refreshToken = generateRefreshToken();
  await prisma.session.create({
    data: {
      userId: membership.userId,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      userAgent: userAgent?.slice(0, 300) ?? null,
      ipAddress: ipAddress?.slice(0, 64) ?? null
    }
  });
  const accessToken = await createAccessToken({ userId: membership.userId, workspaceId: membership.workspaceId, email: membership.user.email, role: membership.role });
  return { accessToken, refreshToken, expiresIn: Math.floor(REFRESH_TTL_MS / 1000) };
}

@Controller('auth')
export class AuthController {
  @Post('register')
  @HttpCode(201)
  async register(@Body() body: unknown, @Headers('user-agent') userAgent: string | undefined, @Req() request: AuthedRequest) {
    const { email, password, displayName } = RegisterSchema.parse(body);
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new HttpException('Email already registered', HttpStatus.CONFLICT);
    const passwordHash = hashPassword(password);
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({ data: { email, passwordHash, ...(displayName === undefined ? {} : { displayName }) } });
      const workspace = await tx.workspace.create({
        data: {
          type: 'PERSONAL',
          name: displayName ? `${displayName}'s workspace` : 'My workspace',
          slug: `ws-${randomBytes(8).toString('hex')}`,
          handle: await uniqueWorkspaceHandle(tx, email),
          liveTradingEnabled: false
        }
      });
      await tx.workspaceMember.create({ data: { workspaceId: workspace.id, userId: created.id, role: 'OWNER' } });
      await tx.riskPolicy.create({
        data: {
          workspaceId: workspace.id,
          maxDailyLoss: new Prisma.Decimal(DEFAULT_RISK_POLICY.maxDailyLoss),
          maxWeeklyLoss: new Prisma.Decimal(DEFAULT_RISK_POLICY.maxWeeklyLoss),
          maxMonthlyLoss: new Prisma.Decimal(DEFAULT_RISK_POLICY.maxMonthlyLoss),
          maxDrawdownPercent: new Prisma.Decimal(DEFAULT_RISK_POLICY.maxDrawdownPercent),
          maxConcurrentPositions: DEFAULT_RISK_POLICY.maxConcurrentPositions,
          maxExposure: new Prisma.Decimal(DEFAULT_RISK_POLICY.maxExposure),
          maxLeverage: DEFAULT_RISK_POLICY.maxLeverage,
          maxRiskPerTrade: new Prisma.Decimal(DEFAULT_RISK_POLICY.maxRiskPerTrade),
          maxPositionSize: new Prisma.Decimal(DEFAULT_RISK_POLICY.maxPositionSize),
          consecutiveLossCooldown: DEFAULT_RISK_POLICY.consecutiveLossCooldown,
          tradingEnabled: DEFAULT_RISK_POLICY.tradingEnabled
        }
      });
      return created;
    });
    const membership = await defaultMembership(user.id);
    const session = await issueSession(membership, userAgent, clientIp(request));
    return { user: publicUser(user), workspace: publicWorkspace(membership.workspace), ...session };
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Headers('user-agent') userAgent: string | undefined, @Req() request: AuthedRequest) {
    const { email, password } = LoginSchema.parse(body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) throw new HttpException('Invalid email or password', HttpStatus.UNAUTHORIZED);
    if (user.disabledAt) throw new HttpException('Account is disabled', HttpStatus.FORBIDDEN);
    const membership = await defaultMembership(user.id);
    const session = await issueSession(membership, userAgent, clientIp(request));
    return { user: publicUser(user), workspace: publicWorkspace(membership.workspace), ...session };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() body: unknown, @Headers('user-agent') userAgent: string | undefined, @Req() request: AuthedRequest) {
    const { refreshToken } = RefreshSchema.parse(body);
    const tokenHash = hashRefreshToken(refreshToken);
    const session = await prisma.session.findUnique({ where: { refreshTokenHash: tokenHash }, include: { user: true } });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) throw new HttpException('Refresh token is invalid or expired', HttpStatus.UNAUTHORIZED);
    if (session.user.disabledAt) throw new HttpException('Account is disabled', HttpStatus.FORBIDDEN);
    await prisma.$transaction([
      prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } }),
      prisma.session.create({
        data: {
          userId: session.userId,
          refreshTokenHash: hashRefreshToken(generateRefreshToken()),
          expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
          userAgent: userAgent?.slice(0, 300) ?? session.userAgent,
          ipAddress: clientIp(request)
        }
      })
    ]);
    const membership = await defaultMembership(session.userId);
    const next = await issueSession(membership, userAgent, clientIp(request));
    return { user: publicUser(session.user), workspace: publicWorkspace(membership.workspace), ...next };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body() body: unknown) {
    const { refreshToken } = RefreshSchema.parse(body);
    await prisma.session.updateMany({ where: { refreshTokenHash: hashRefreshToken(refreshToken), revokedAt: null }, data: { revokedAt: new Date() } });
    return undefined;
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@Req() request: AuthedRequest) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user.userId } });
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: request.user.workspaceId, userId: request.user.userId } },
      include: { workspace: true }
    });
    if (!membership) throw new HttpException('No membership in this workspace', HttpStatus.FORBIDDEN);
    return { user: publicUser(user), role: membership.role, workspace: publicWorkspace(membership.workspace) };
  }
}
