import { cn } from '../../lib/cn';
import type { Tone } from '../../lib/types';

export { type Tone };

export function StatusBadge({ tone = 'muted', title, children, className }: { tone?: Tone; title?: string; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('status-label', tone, className)} title={title}>
      {children}
    </span>
  );
}