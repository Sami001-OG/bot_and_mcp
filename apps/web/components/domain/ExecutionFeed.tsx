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
                  <Td data-label="Time">{formatTime(row.executedAt ?? row.createdAt)}</Td>
                  <Td data-label="State">
                    <StatusBadge tone={STATE_TONES[row.state] ?? 'muted'}>{row.state}</StatusBadge>
                  </Td>
                  <Td data-label="Side">
                    <span className={row.side === 'BUY' ? 'long' : 'short'}>{row.side}</span>
                    {row.positionSide !== 'BOTH' && <small className="muted block">{row.positionSide}</small>}
                  </Td>
                  <Td data-label="Symbol">
                    <b>{row.symbol}</b>
                    {row.marketType && <small className="muted block">{row.marketType === 'SPOT' ? 'Spot' : 'Futures'}</small>}
                  </Td>
                  <Td data-label="Qty">{formatNumber(row.quantity)}</Td>
                  <Td data-label="Price">{row.price ? formatNumber(row.price, 6) : '…'}</Td>
                  <Td data-label="Fee">{row.fee ? `${formatNumber(row.fee, 6)} ${row.feeAsset ?? ''}` : '…'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </TableScroll>
      {executions !== null && executions.length > 0 && (
        <div className="mobile-cards">
          {executions.map((row) => (
            <div className="mc" key={`${row.orderId}-${row.executionId ?? 'nofill'}`}>
              <div className="mc-header">
                <strong>{row.symbol}</strong>
                <StatusBadge tone={STATE_TONES[row.state] ?? 'muted'}>{row.state}</StatusBadge>
              </div>
              <div className="mc-row"><span className="mc-label">Side</span><span className={`mc-value ${row.side === 'BUY' ? 'long' : 'short'}`}>{row.side}{row.positionSide !== 'BOTH' ? ` ${row.positionSide}` : ''}</span></div>
              <div className="mc-row"><span className="mc-label">Type</span><span className="mc-value">{row.marketType === 'SPOT' ? 'Spot' : 'Futures'}</span></div>
              <div className="mc-row"><span className="mc-label">Qty</span><span className="mc-value">{formatNumber(row.quantity)}</span></div>
              <div className="mc-row"><span className="mc-label">Price</span><span className="mc-value">{row.price ? formatNumber(row.price, 6) : '…'}</span></div>
              {row.fee ? <div className="mc-row"><span className="mc-label">Fee</span><span className="mc-value">{formatNumber(row.fee, 6)} {row.feeAsset ?? ''}</span></div> : null}
              <div className="mc-row"><span className="mc-label">Time</span><span className="mc-value">{formatTime(row.executedAt ?? row.createdAt)}</span></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}