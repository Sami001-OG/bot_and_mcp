'use client';

import { X } from 'lucide-react';
import { cn } from '../../lib/cn';

export function Modal({
  open,
  wide,
  eyebrow,
  title,
  onClose,
  children,
  footer,
  className,
}: {
  open: boolean;
  wide?: boolean;
  eyebrow?: string;
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={onClose} role="presentation">
      <section aria-modal="true" className={cn('modal', wide && 'wide', className)} onMouseDown={(event) => event.stopPropagation()} role="dialog">
        <div className="card-head">
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            <h2>{title}</h2>
          </div>
          <button aria-label="Close" onClick={onClose} type="button">
            <X size={18} />
          </button>
        </div>
        {children}
        {footer && <div className="modal-actions">{footer}</div>}
      </section>
    </div>
  );
}