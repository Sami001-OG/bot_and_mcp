'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from './Button';

export function CopyButton({
  text,
  label = 'Copy',
  onCopied,
}: {
  text: string;
  label?: string;
  onCopied?: (ok: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = false;
    }
    setCopied(ok);
    onCopied?.(ok);
    if (ok) setTimeout(() => setCopied(false), 1600);
  };

  return (
    <Button onClick={() => void copy()} variant="secondary" size="sm">
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? 'Copied' : label}
    </Button>
  );
}