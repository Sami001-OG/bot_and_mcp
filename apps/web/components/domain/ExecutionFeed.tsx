'use client';

import { useState } from 'react';
import { usePolling } from '../../hooks/usePolling';
import { apiFetch } from '../../lib/session';
import { formatNumber, formatTime, STATE_TONES } from '../../lib/format';
import type { ExecutionRow } from '../../lib/types';
import { StatusBadge } from '../ui/StatusBadge';
import { Table, Td, Th, TableScroll } from '../ui/Table';
import { EmptyState } from '../ui/EmptyState';

export function ExecutionFeed({ take = 60 }: { take?: number }) {
  const [executions, setExecutions] = useState<ExecutionRow[] | null>(null);

  usePolling(async () => {
    const data = await apiFetch<{ executions: ExecutionRow[] }>(`/api/portfolio/executions?take=${take}`);
    setExecutions(data.executions);
  }, 15000);

  return (
    <div>
      <div className="table-head-row">
        <p className="eyebrow">ACTIVITY</p>
        <span className="muted small">{executions?.length ?? 0} rows · refresh 15s</span>
      </div>
      <TableScroll>
        {executions !== null && executions.length === 0 && <EmptyState>No orders yet — place an order or trigger a bot run to record activity.</EmptyState>}
        {executions !== null && executions.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>State</Th>
                <Th>Side</Th>
                <Th>Symbol</Th>
                <Th>Qty</Th>
                <Th>Price</Th>
                <Th>Fee</Th>
              </tr>
            </thead>
            <tbody>
              {executions.map((row) => (
                <tr key={`${row.orderId}-${row.executionId ?? 'nofill'}`}>
                  <Td>{formatTime(row.executedAt ?? row.createdAt)}</Td>
                  <Td>
                    <StatusBadge tone={STATE_TONES[row.state] ?? 'muted'}>{row.state}</StatusBadge>
                  </Td>
                  <Td>
                    <span className={row.side === 'BUY' ? 'long' : 'short'}>{row.side}</span>
                    {row.positionSide !== 'BOTH' && <small className="muted block">{row.positionSide}</small>}
                  </Td>
                  <Td>
                    <b>{row.symbol}</b>
                    {row.marketType && <small className="muted block">{row.marketType === 'SPOT' ? 'Spot' : 'Futures'}</small>}
                  </Td>
                  <Td>{formatNumber(row.quantity)}</Td>
                  <Td>{row.price ? formatNumber(row.price, 6) : '…'}</Td>
                  <Td>{row.fee ? `${formatNumber(row.fee, 6)} ${row.feeAsset ?? ''}` : '…'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </TableScroll>
    </div>
  );
}