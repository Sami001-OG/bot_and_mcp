import { cn } from '../../lib/cn';

export function Field({ label, htmlFor, className, children }: { label?: React.ReactNode; htmlFor?: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={cn(className)} htmlFor={htmlFor}>
      {label}
      {children}
    </label>
  );
}

export function Checkbox({ label, className, ...rest }: { label: React.ReactNode; className?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={cn('checkbox', className)}>
      <input type="checkbox" {...rest} />
      {label}
    </label>
  );
}