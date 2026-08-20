'use client';

import { ArrowLeftRight, Ban } from 'lucide-react';
import { useMemo, useState } from 'react';
import { formatNumber, formatTime, STATE_TONES, TERMINAL_STATES } from '../../lib/format';
import type { OrderRow } from '../../lib/types';
import { StatusBadge } from '../ui/StatusBadge';
import { Table, Td, Th, TableScroll } from '../ui/Table';
import { Tab, TabBar } from '../ui/Tabs';
import { EmptyState } from '../ui/EmptyState';

const ORDER_FILTERS: Array<{ id: 'SPOT' | 'USDT_FUTURES' | 'ALL'; label: string }> = [
  { id: 'ALL', label: 'All markets' },
  { id: 'USDT_FUTURES', label: 'Futures' },
  { id: 'SPOT', label: 'Spot' },
];

type OrderFilter = (typeof ORDER_FILTERS)[number]['id'];
type StatusFilter = 'open' | 'closed' | 'all';

export function OrderBookTable({ orders, loading, onCancel }: { orders: OrderRow[]; loading: boolean; onCancel: (order: OrderRow) => void }) {
  const [orderFilter, setOrderFilter] = useState<OrderFilter>('ALL');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const visibleOrders = useMemo(() => {
    return orders.filter((order) => {
      if (orderFilter !== 'ALL' && (order.marketType ?? '').toUpperCase() !== orderFilter) return false;
      const isOpen = !TERMINAL_STATES.has(order.state);
      if (statusFilter === 'open' && !isOpen) return false;
      if (statusFilter === 'closed' && isOpen) return false;
      return true;
    });
  }, [orders, orderFilter, statusFilter]);

  const openCount = useMemo(() => orders.filter((order) => !TERMINAL_STATES.has(order.state)).length, [orders]);
  const spotCount = useMemo(() => orders.filter((order) => (order.marketType ?? '').toUpperCase() === 'SPOT').length, [orders]);
  const futuresCount = useMemo(() => orders.filter((order) => (order.marketType ?? '').toUpperCase() !== 'SPOT').length, [orders]);

  return (
    <div>
      <div className="table-head-row">
        <p className="eyebrow">ORDER BOOK</p>
        <span className="muted small">{visibleOrders.length} shown — {openCount} open</span>
        <ArrowLeftRight size={16} className="muted" />
      </div>
      <TabBar ariaLabel="Order market filter">
        {ORDER_FILTERS.map((filter) => (
          <Tab key={filter.id} active={orderFilter === filter.id} onClick={() => setOrderFilter(filter.id)}>
            {filter.label}
            {filter.id === 'SPOT' ? ` (${spotCount})` : filter.id === 'USDT_FUTURES' ? ` (${futuresCount})` : ''}
          </Tab>
        ))}
      </TabBar>
      <TabBar ariaLabel="Order status filter">
        {(['open', 'closed', 'all'] as StatusFilter[]).map((status) => (
          <Tab key={status} active={statusFilter === status} onClick={() => setStatusFilter(status)}>
            {status === 'open' ? 'Open' : status === 'closed' ? 'Closed' : 'All'}
          </Tab>
        ))}
      </TabBar>
      <TableScroll>
        {!loading && visibleOrders.length === 0 && <EmptyState>No orders match this filter — place one to see it here with executions and fees.</EmptyState>}
        {visibleOrders.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>State</Th>
                <Th>Side</Th>
                <Th>Symbol</Th>
                <Th>Qty</Th>
                <Th>Price</Th>
                <Th>Fill</Th>
                <Th>Fee</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {visibleOrders.map((order) => {
                const filled = order.executions.reduce((sum, execution) => sum + Number(execution.quantity), 0);
                const fees = order.executions.reduce((sum, execution) => sum + Number(execution.fee), 0);
                return (
                  <tr key={order.id}>
                    <Td>{formatTime(order.createdAt)}</Td>
                    <Td>
                      <StatusBadge tone={STATE_TONES[order.state] ?? 'muted'}>{order.state}</StatusBadge>
                    </Td>
                    <Td>
                      <span className={order.side === 'BUY' ? 'long' : 'short'}>{order.side}</span>
                      {order.positionSide !== 'BOTH' && <small className="muted block">{order.positionSide}</small>}
                    </Td>
                    <Td>
                      <b>{order.symbol}</b>
                      <small className="muted block">{order.orderType}{order.reduceOnly ? ' — RO' : ''}</small>
                      <small className="muted block">{order.marketType === 'SPOT' ? 'Spot' : 'Futures'}</small>
                    </Td>
                    <Td>{formatNumber(order.quantity)}</Td>
                    <Td>{order.price ? formatNumber(order.price) : order.stopPrice ? `~${formatNumber(order.stopPrice)}` : '…'}</Td>
                    <Td>{filled > 0 ? formatNumber(String(filled)) : '…'}</Td>
                    <Td>{fees > 0 ? `${formatNumber(String(fees))} ${order.executions[0]?.feeAsset ?? ''}` : '…'}</Td>
                    <Td>
                      <div className="row-actions">
                        {!TERMINAL_STATES.has(order.state) && (
                          <button className="icon-btn danger" onClick={() => onCancel(order)} title="Cancel order" type="button">
                            <Ban size={13} />
                          </button>
                        )}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </TableScroll>
    </div>
  );
}