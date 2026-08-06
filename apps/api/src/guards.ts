import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { verifyAccessToken, type AuthClaims } from '@platform/auth';
import { prisma } from '@platform/database';

export type AuthedRequest = Request & { user: AuthClaims };

@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');
    const claims = await verifyAccessToken(header.slice(7));
    if (!claims) throw new UnauthorizedException('Invalid or expired token');
    (request as AuthedRequest).user = claims;
    return true;
  }
}

@Injectable()
export class WorkspaceGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    if (!request.user) throw new UnauthorizedException('Not authenticated');
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: request.user.workspaceId, userId: request.user.userId } }
    });
    if (!membership || membership.status !== 'ACTIVE') throw new ForbiddenException('No active membership in this workspace');
    return true;
  }
}
