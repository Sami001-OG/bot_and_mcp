import { cn } from '../../lib/cn';

export function EmptyState({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn('muted empty', className)}>{children}</p>;
}