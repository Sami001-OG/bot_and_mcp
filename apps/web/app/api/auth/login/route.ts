import { NextRequest, NextResponse } from 'next/server';
import { checkPassword, SESSION_COOKIE, signSession } from '../../../../lib/auth';

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => ({}))) as { password?: unknown };
    const password = typeof body.password === 'string' ? body.password : '';
    if (!checkPassword(password)) {
      return NextResponse.json({ message: 'Invalid password', code: 'INVALID_CREDENTIALS' }, { status: 401 });
    }
    const response = NextResponse.json({ authenticated: true, email: 'owner' });
    response.cookies.set(SESSION_COOKIE, signSession(), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });
    return response;
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : 'Login failed' }, { status: 500 });
  }
}