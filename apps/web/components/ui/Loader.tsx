import { Activity } from 'lucide-react';

export function Loader({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="terminal-loader">
      <Activity size={18} />
      <span>{label}</span>
    </div>
  );
}