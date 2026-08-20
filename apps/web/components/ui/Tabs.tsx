import { cn } from '../../lib/cn';

export function TabBar({ children, ariaLabel, className }: { children: React.ReactNode; ariaLabel: string; className?: string }) {
  return (
    <div className={cn('window-tabs', className)} role="tablist" aria-label={ariaLabel}>
      {children}
    </div>
  );
}

export function Tab({ active, onClick, children }: { active?: boolean; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button aria-selected={active} className={active ? 'active' : ''} onClick={onClick} role="tab" type="button">
      {children}
    </button>
  );
}