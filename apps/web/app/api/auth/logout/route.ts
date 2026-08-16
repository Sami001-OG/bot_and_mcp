import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '../../../../lib/auth';

export async function POST(): Promise<NextResponse> {
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 0 });
  return response;
}