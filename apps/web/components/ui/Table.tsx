import { cn } from '../../lib/cn';

export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return <table className={cn(className)}>{children}</table>;
}

export function Th({ children, className, ...rest }: { children?: React.ReactNode; className?: string } & React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th className={cn(className)} {...rest}>
      {children}
    </th>
  );
}

export function Td({ children, className, ...rest }: { children?: React.ReactNode; className?: string } & React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn(className)} {...rest}>
      {children}
    </td>
  );
}

export function TableScroll({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('table-scroll', className)}>{children}</div>;
}