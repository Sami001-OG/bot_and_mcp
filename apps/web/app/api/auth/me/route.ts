import { NextRequest, NextResponse } from 'next/server';
import { verifySession, SESSION_COOKIE } from '../../../../lib/auth';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!verifySession(token)) {
    return NextResponse.json({ authenticated: false });
  }
  return NextResponse.json({ authenticated: true, email: 'owner' });
}