import { cn } from '../../lib/cn';

export function Card({ className, children, ...rest }: { className?: string; children?: React.ReactNode } & React.HTMLAttributes<HTMLElement>) {
  return (
    <article className={cn(className)} {...rest}>
      {children}
    </article>
  );
}

export function CardHeader({
  eyebrow,
  title,
  right,
  children,
  className,
}: {
  eyebrow?: string;
  title?: React.ReactNode;
  right?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('card-head', className)}>
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        {title && (typeof title === 'string' ? <h3>{title}</h3> : title)}
        {children}
      </div>
      {right}
    </div>
  );
}