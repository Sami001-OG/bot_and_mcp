'use client';

import { cn } from '../../lib/cn';

type Variant = 'primary' | 'secondary' | 'danger' | 'icon' | 'link';
type Tone = 'default' | 'safe' | 'danger';

type ButtonProps = {
  variant?: Variant;
  size?: 'sm';
  tone?: Tone;
  className?: string;
  children?: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

export function Button({ variant = 'secondary', size, tone = 'default', className, children, ...rest }: ButtonProps) {
  const classes = cn(
    variant === 'icon' ? 'icon-btn' : variant,
    variant === 'icon' && tone === 'safe' ? 'safe' : '',
    variant === 'icon' && tone === 'danger' ? 'danger' : '',
    variant !== 'icon' && tone === 'danger' && variant !== 'danger' ? 'danger' : '',
    size === 'sm' ? 'sm' : '',
    className,
  );
  return (
    <button className={classes} {...rest}>
      {children}
    </button>
  );
}