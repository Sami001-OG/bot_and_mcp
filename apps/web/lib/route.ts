import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { CommandError } from '@platform/commands';

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof CommandError) {
    return NextResponse.json({ message: error.message, code: error.code }, { status: error.statusCode });
  }
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    return NextResponse.json(
      { message: issue ? `${issue.path.join('.')}: ${issue.message}` : 'Validation failed', code: 'VALIDATION_ERROR' },
      { status: 400 },
    );
  }
  if (error instanceof Error && error.message === 'UNAUTHORIZED') {
    return NextResponse.json({ message: 'Not authenticated', code: 'UNAUTHORIZED' }, { status: 401 });
  }
  console.error('[api] unhandled error', error);
  return NextResponse.json({ message: error instanceof Error ? error.message : String(error), code: 'INTERNAL_ERROR' }, { status: 500 });
}