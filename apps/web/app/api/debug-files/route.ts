import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

export const dynamic = 'force-dynamic';

function walk(dir: string, depth: number, out: { p: string; size: number }[]) {
  if (depth <= 0) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p, depth - 1, out);
    } else {
      let size = 0;
      try {
        size = fs.statSync(p).size;
      } catch { }
      if (size > 4096) out.push({ p, size });
    }
  }
}

export async function GET() {
  const out: { p: string; size: number }[] = [];
  for (const root of ['/var/task', '/tmp']) walk(root, 6, out);
  out.sort((a, b) => b.size - a.size);
  return NextResponse.json({ files: out.slice(0, 200), total: out.length, cwd: process.cwd() });
}