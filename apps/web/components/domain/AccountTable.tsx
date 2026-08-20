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
                  <Td>
                    <b>{account.label ?? `${account.exchange} ${account.marketType}`}</b>
                    {account.testnet && (
                      <StatusBadge tone="warn" title="Bybit testnet account — test funds only">
                        TESTNET
                      </StatusBadge>
                    )}
                  </Td>
                  <Td>{account.exchange}</Td>
                  <Td>{account.marketType}</Td>
                  <Td>
                    <code>{account.keyPreview}</code>
                  </Td>
                  <Td>{account.botCount}</Td>
                  <Td>
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
                  <Td>{formatTime(account.createdAt)}</Td>
                  <Td>
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
    </div>
  );
}