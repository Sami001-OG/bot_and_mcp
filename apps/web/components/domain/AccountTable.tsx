'use client';

import { Star, Trash2 } from 'lucide-react';
import { formatTime } from '../../lib/format';
import type { ExchangeAccount } from '../../lib/types';
import { EmptyState } from '../ui/EmptyState';
import { StatusBadge } from '../ui/StatusBadge';
import { Table, Td, Th, TableScroll } from '../ui/Table';

export function AccountTable({
  accounts,
  loading,
  onSetPrimary,
  onDelete,
}: {
  accounts: ExchangeAccount[];
  loading: boolean;
  onSetPrimary: (id: string, current: boolean) => void;
  onDelete: (account: ExchangeAccount) => void;
}) {
  return (
    <div>
      <div className="table-head-row">
        <p className="eyebrow">ACCOUNTS</p>
        <span className="muted small">{accounts.length} configured · primary is used for manual orders</span>
      </div>
      <TableScroll>
        {!loading && accounts.length === 0 && <EmptyState>No exchange APIs yet — add one above. Bots cannot be created without an API.</EmptyState>}
        {accounts.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Label</Th>
                <Th>Exchange</Th>
                <Th>Market</Th>
                <Th>Key</Th>
                <Th>Bots</Th>
                <Th>Primary</Th>
                <Th>Created</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <Td data-label="Label">
                    <b>{account.label ?? `${account.exchange} ${account.marketType}`}</b>
                    {account.testnet && (
                      <StatusBadge tone="warn" title="Bybit testnet account — test funds only">
                        TESTNET
                      </StatusBadge>
                    )}
                  </Td>
                  <Td data-label="Exchange">{account.exchange}</Td>
                  <Td data-label="Market">{account.marketType}</Td>
                  <Td data-label="Key">
                    <code>{account.keyPreview}</code>
                  </Td>
                  <Td data-label="Bots">{account.botCount}</Td>
                  <Td data-label="Primary">
                    <button className="link-button" disabled={account.isPrimary} onClick={() => onSetPrimary(account.id, account.isPrimary)} type="button">
                      {account.isPrimary ? (
                        <StatusBadge tone="ok">
                          <Star size={12} /> PRIMARY
                        </StatusBadge>
                      ) : (
                        <StatusBadge tone="muted">set primary</StatusBadge>
                      )}
                    </button>
                  </Td>
                  <Td data-label="Created">{formatTime(account.createdAt)}</Td>
                  <Td data-label="">
                    <button aria-label={`Delete ${account.label ?? account.exchange}`} className="icon-btn danger" onClick={() => onDelete(account)} title={account.botCount > 0 ? `Delete account and its ${account.botCount} bot(s)` : 'Delete account'} type="button">
                      <Trash2 size={14} />
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </TableScroll>
      {accounts.length > 0 && (
        <div className="mobile-cards">
          {accounts.map((account) => (
            <div className="mc" key={account.id}>
              <div className="mc-header">
                <strong>{account.label ?? `${account.exchange} ${account.marketType}`}</strong>
                {account.testnet && <StatusBadge tone="warn">TESTNET</StatusBadge>}
                {account.isPrimary && <StatusBadge tone="ok"><Star size={12} /> PRIMARY</StatusBadge>}
              </div>
              <div className="mc-row"><span className="mc-label">Exchange</span><span className="mc-value">{account.exchange}</span></div>
              <div className="mc-row"><span className="mc-label">Market</span><span className="mc-value">{account.marketType}</span></div>
              <div className="mc-row"><span className="mc-label">Key</span><span className="mc-value"><code>{account.keyPreview}</code></span></div>
              <div className="mc-row"><span className="mc-label">Bots</span><span className="mc-value">{account.botCount}</span></div>
              <div className="mc-row"><span className="mc-label">Created</span><span className="mc-value">{formatTime(account.createdAt)}</span></div>
              <div className="mc-actions">
                {!account.isPrimary && <button className="secondary" onClick={() => onSetPrimary(account.id, false)} type="button">Set primary</button>}
                <button className="danger" onClick={() => onDelete(account)} type="button">{account.botCount > 0 ? `Delete (${account.botCount} bots)` : 'Delete'}</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}