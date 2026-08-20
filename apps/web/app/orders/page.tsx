'use client';

import { ArrowLeftRight, Ban, Layers, RefreshCw, Send } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import AppShell from '../../components/layout/AppShell';
import { useApp } from '../../components/layout/AppContext';
import { ApiHttpError, apiFetch } from '../../lib/session';
import { formatNumber, formatTime, MARKET_MODES, ORDER_TYPES, POSITION_SIDES, SIDES, SPOT_ORDER_TYPES, ALLOCATION_MODES, STATE_TONES, TERMINAL_STATES, type MarketMode } from '../../lib/format';
import type { Balance, Market, OrderRow, PlaceResult } from '../../lib/types';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Table, Td, Th, TableScroll } from '../../components/ui/Table';
import { Tab, TabBar } from '../../components/ui/Tabs';
import { EmptyState } from '../../components/ui/EmptyState';

const ORDER_FILTERS: Array<{ id: 'SPOT' | 'USDT_FUTURES' | 'ALL'; label: string }> = [
  { id: 'ALL', label: 'All markets' },
  { id: 'USDT_FUTURES', label: 'Futures' },
  { id: 'SPOT', label: 'Spot' },
];

type OrderFilter = (typeof ORDER_FILTERS)[number]['id'];
type StatusFilter = 'open' | 'closed' | 'all';

function needsPrice(type: string): boolean {
  return type === 'LIMIT' || type === 'STOP_LIMIT' || type === 'TAKE_PROFIT' || type === 'TRAILING_STOP';
}

function needsStop(type: string): boolean {
  return type === 'STOP' || type === 'STOP_MARKET' || type === 'STOP_LIMIT' || type === 'TAKE_PROFIT' || type === 'TAKE_PROFIT_MARKET';
}

export default function OrdersPage() {
  return (
    <AppShell active="orders">
      <OrdersBody />
    </AppShell>
  );
}

function OrdersBody() {
  const { toast, signOut } = useApp();
  const [markets, setMarkets] = useState<Market[] | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [orderFilter, setOrderFilter] = useState<OrderFilter>('ALL');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const [marketMode, setMarketMode] = useState<MarketMode>('USDT_FUTURES');
  const [symbol, setSymbol] = useState('');
  const [side, setSide] = useState<string>('BUY');
  const [positionSide, setPositionSide] = useState<string>('LONG');
  const [type, setType] = useState<string>('MARKET');
  const [sizing, setSizing] = useState<'quantity' | 'allocation'>('quantity');
  const [allocationMode, setAllocationMode] = useState<string>('FIXED_AMOUNT');
  const [quantity, setQuantity] = useState('');
  const [allocationValue, setAllocationValue] = useState('');
  const [price, setPrice] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [leverage, setLeverage] = useState('');
  const [spotBalances, setSpotBalances] = useState<Balance[] | null>(null);
  const [spotBalancesError, setSpotBalancesError] = useState(false);

  const loadMarkets = useCallback(async () => {
    try {
      const data = await apiFetch<{ symbols: Market[] }>('/api/markets?quote=USDT');
      setMarkets(data.symbols);
    } catch {
      setMarkets([]);
    }
  }, []);

  const loadSpotBalances = useCallback(async () => {
    try {
      const data = await apiFetch<{ balances: Balance[] }>('/api/portfolio/summary?marketType=SPOT');
      setSpotBalances(data.balances ?? []);
      setSpotBalancesError(false);
    } catch {
      setSpotBalances(null);
      setSpotBalancesError(true);
    }
  }, []);

  const loadOrders = useCallback(
    async (silent = false) => {
      if (!silent) setLoadingOrders(true);
      try {
        const data = await apiFetch<{ orders: OrderRow[] }>('/api/orders');
        setOrders(data.orders);
      } catch (error) {
        if (error instanceof ApiHttpError && error.status === 401) {
          signOut();
          toast('error', 'Session expired — sign in again.');
        } else {
          toast('error', error instanceof Error ? error.message : 'Failed to load orders.');
        }
      } finally {
        if (!silent) setLoadingOrders(false);
      }
    },
    [toast, signOut],
  );

  useEffect(() => {
    void loadMarkets();
    void loadSpotBalances();
    void loadOrders();
  }, [loadMarkets, loadSpotBalances, loadOrders]);

  useEffect(() => {
    const timer = setInterval(() => void loadOrders(true), 15000);
    return () => clearInterval(timer);
  }, [loadOrders]);

  const modeSymbols = useMemo(() => {
    const want = marketMode === 'SPOT' ? 'spot' : 'swap';
    return (markets ?? []).filter((market) => market.type === want);
  }, [markets, marketMode]);

  const spotHoldingBase = useMemo(() => {
    if (marketMode !== 'SPOT' || !spotBalances) return null;
    const base = (symbol.split('/')[0] ?? '').toUpperCase();
    const balance = spotBalances.find((entry) => entry.asset.toUpperCase() === base);
    return balance ? Number(balance.total) : 0;
  }, [marketMode, spotBalances, symbol]);

  const switchMode = (mode: MarketMode) => {
    setMarketMode(mode);
    setSymbol((current) => {
      const hasSuffix = current.includes(':');
      if (mode === 'SPOT' && hasSuffix) return current.split(':')[0] ?? current;
      if (mode === 'USDT_FUTURES' && !hasSuffix && current) return `${current}:USDT`;
      return current;
    });
  };

  const placeOrder = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const hasQuantity = sizing === 'quantity' && quantity.trim() !== '';
    const hasAllocation = sizing === 'allocation' && allocationValue.trim() !== '';
    if (!hasQuantity && !hasAllocation) {
      toast('error', 'Provide a quantity or an allocation amount/percent.');
      return;
    }
    if (needsPrice(type) && !price.trim()) {
      toast('error', `${type} orders require a limit price.`);
      return;
    }
    if (needsStop(type) && !stopPrice.trim()) {
      toast('error', `${type} orders require a stop/trigger price.`);
      return;
    }
    setSubmitting(true);
    try {
      const isFutures = marketMode === 'USDT_FUTURES';
      const effectiveSide = isFutures ? (positionSide === 'LONG' ? 'BUY' : 'SELL') : side;
      const body: Record<string, unknown> = {
        symbol,
        side: effectiveSide,
        positionSide: isFutures ? positionSide : 'BOTH',
        type,
        marketType: marketMode,
        reduceOnly: isFutures && reduceOnly,
        clientOrderId: `ui-${Math.random().toString(36).slice(2, 12)}`,
        idempotencyKey: crypto.randomUUID(),
      };
      if (sizing === 'quantity') {
        body.quantity = quantity.trim();
      } else {
        body.allocation = allocationMode === 'FIXED_AMOUNT' ? { mode: 'FIXED_AMOUNT', amount: allocationValue.trim() } : { mode: allocationMode, percent: Number(allocationValue) };
      }
      if (price.trim()) body.price = price.trim();
      if (stopPrice.trim()) body.stopPrice = stopPrice.trim();
      const leverageNumber = Number(leverage);
      if (isFutures && leverageNumber >= 1 && leverageNumber <= 200) body.leverage = leverageNumber;

      const result = await apiFetch<PlaceResult>('/api/orders', {
        method: 'POST',
        body,
      });
      if (!result.accepted) {
        toast('error', `Order rejected (${result.order.state}) — likely a duplicate idempotency key.`);
      } else {
        const executionNote = result.execution?.error ? ` · ${result.execution.error}` : '';
        const sizingNote = result.sized ? ` · ${result.sized.quantity} @ ${result.marketPrice ?? '?'} (${result.sized.notional} USDT${result.sized.leverage ? `, ${result.sized.leverage}x` : ''})` : '';
        toast('success', `Order ${result.order.state} — ${effectiveSide} ${sizing === 'quantity' ? quantity : `${allocationMode} ${allocationValue}`} ${symbol}${sizingNote}${executionNote}.`);
      }
      setQuantity('');
      setAllocationValue('');
      await loadOrders();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Order placement failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const cancelOrder = async (order: OrderRow) => {
    try {
      const result = await apiFetch<{ orderId: string; state: string }>(`/api/orders/${order.id}/cancel`, { method: 'POST', body: {} });
      toast('info', `Cancel result: ${result.state} for ${order.symbol} ${order.side}.`);
      await loadOrders();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Cancel failed.');
    }
  };

  const closeAll = async () => {
    try {
      const result = await apiFetch<{ canceled: number; positionsToClose: number; closed: number; closeFailures: string[] }>('/api/orders/emergency/close-all', { method: 'POST', body: {} });
      toast('info', `Close-all: canceled ${result.canceled}, closed ${result.closed}/${result.positionsToClose} positions${result.closeFailures.length > 0 ? ` · ${result.closeFailures.length} failed` : ''}.`);
      await loadOrders();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Close-all failed.');
    }
  };

  const [submitting, setSubmitting] = useState(false);

  const isFutures = marketMode === 'USDT_FUTURES';
  const sellDisabled = marketMode === 'SPOT' && side === 'SELL' && spotBalances !== null && !spotBalancesError && (spotHoldingBase ?? 0) <= 0;

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
    <>
      <header>
        <div>
          <p className="eyebrow">EXECUTION</p>
          <h1>Orders</h1>
          <p className="muted">Place orders through the risk engine, or cancel and close positions.</p>
        </div>
        <div className="header-actions">
          <Button disabled={loadingOrders} onClick={() => void loadOrders()} variant="secondary">
            <RefreshCw size={14} /> Refresh
          </Button>
          {isFutures && (
            <Button onClick={() => void closeAll()} variant="danger" tone="danger">
              <Layers size={14} /> Close all
            </Button>
          )}
        </div>
      </header>

      <div className="orders-layout">
        <Card className="order-form-card">
          <CardHeader
            eyebrow="NEW ORDER"
            title="Place on Bybit"
            right={<span className="status-label warn">{isFutures ? 'FUTURES' : 'SPOT'}</span>}
          >
            <p className="muted small">One unified account trades both spot and futures.</p>
          </CardHeader>
          <div className="sizing-toggle">
            {MARKET_MODES.map((mode) => (
              <button className={marketMode === mode.id ? 'active' : ''} key={mode.id} onClick={() => switchMode(mode.id)} type="button">
                {mode.label}
              </button>
            ))}
          </div>
          <p className="muted small">{isFutures ? MARKET_MODES[1].hint : MARKET_MODES[0].hint}</p>
          <form onSubmit={placeOrder}>
            <div className="form-row">
              <label>
                Symbol
                <input list="order-markets" onChange={(event) => setSymbol(event.target.value)} placeholder={isFutures ? 'e.g. BTC/USDT:USDT' : 'e.g. BTC/USDT'} required value={symbol} />
                <datalist id="order-markets">
                  {modeSymbols.slice(0, 500).map((market) => (
                    <option key={market.symbol} value={market.symbol} />
                  ))}
                </datalist>
              </label>
              <label>
                Type
                <select onChange={(event) => setType(event.target.value)} value={type}>
                  {(isFutures ? ORDER_TYPES : SPOT_ORDER_TYPES).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="form-row">
              <label>
                {isFutures ? 'Position side' : 'Side'}
                <span className="sizing-toggle">
                  {(isFutures ? POSITION_SIDES : SIDES).map((option) => {
                    const selected = isFutures ? positionSide === option : side === option;
                    const disabled = marketMode === 'SPOT' && option === 'SELL' && sellDisabled;
                    return (
                      <button
                        className={selected ? 'active' : ''}
                        disabled={disabled}
                        key={option}
                        onClick={() => (isFutures ? setPositionSide(option) : setSide(option))}
                        title={disabled ? `You have no ${(symbol.split('/')[0] ?? '').toUpperCase()} spot balance — buy first` : undefined}
                        type="button"
                      >
                        {option}
                      </button>
                    );
                  })}
                </span>
              </label>
              <label>
                Sizing
                <span className="sizing-toggle">
                  <button className={sizing === 'quantity' ? 'active' : ''} onClick={() => setSizing('quantity')} type="button">
                    Quantity
                  </button>
                  <button className={sizing === 'allocation' ? 'active' : ''} onClick={() => setSizing('allocation')} type="button">
                    Allocation
                  </button>
                </span>
              </label>
            </div>
            <fieldset className="action-field">
              <legend>Sizing — exactly one</legend>
              <div className="form-row">
                <label>
                  Quantity
                  <input
                    disabled={sizing === 'allocation'}
                    min="0"
                    onChange={(event) => setQuantity(event.target.value)}
                    placeholder={sizing === 'quantity' ? 'e.g. 0.001' : 'switch above'}
                    step="any"
                    type="number"
                    value={quantity}
                  />
                </label>
                <label>
                  Allocation mode
                  <select disabled={sizing === 'quantity'} onChange={(event) => setAllocationMode(event.target.value)} value={allocationMode}>
                    {ALLOCATION_MODES.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                {allocationMode === 'FIXED_AMOUNT' ? 'Amount USDT' : 'Percent'}
                <input
                  disabled={sizing === 'quantity'}
                  max={allocationMode === 'FIXED_AMOUNT' ? undefined : 100}
                  min="0"
                  onChange={(event) => setAllocationValue(event.target.value)}
                  placeholder={allocationMode === 'FIXED_AMOUNT' ? 'e.g. 100' : 'e.g. 10'}
                  step="any"
                  type="number"
                  value={allocationValue}
                />
              </label>
            </fieldset>
            {needsPrice(type) && (
              <label>
                Limit price
                <input min="0" onChange={(event) => setPrice(event.target.value)} placeholder="0.00" step="any" type="number" value={price} />
              </label>
            )}
            {needsStop(type) && (
              <label>
                Stop / trigger price
                <input min="0" onChange={(event) => setStopPrice(event.target.value)} placeholder="0.00" step="any" type="number" value={stopPrice} />
              </label>
            )}
            {isFutures ? (
              <div className="form-row">
                <label>
                  Leverage
                  <input max="200" min="1" onChange={(event) => setLeverage(event.target.value)} placeholder="1–200" type="number" value={leverage} />
                </label>
                <label className="checkbox">
                  <input checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} type="checkbox" /> Reduce-only close
                </label>
              </div>
            ) : (
              spotBalances !== null && (
                <p className="muted small">
                  Spot holdings: {spotBalances.filter((entry) => Number(entry.total) > 0).length} asset{spotBalances.filter((entry) => Number(entry.total) > 0).length === 1 ? '' : 's'} on the account.
                </p>
              )
            )}
            <div className="modal-actions">
              <Button variant="primary" disabled={submitting || sellDisabled} type="submit">
                <Send size={14} /> {submitting ? 'Submitting…' : isFutures ? `Place ${positionSide}` : `Place ${side}`}
              </Button>
            </div>
          </form>
        </Card>

        <Card>
          <CardHeader
            eyebrow="ORDER BOOK"
            title={`${visibleOrders.length} shown · ${openCount} open`}
            right={<ArrowLeftRight size={16} className="muted" />}
          />
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
            {!loadingOrders && visibleOrders.length === 0 && <EmptyState>No orders match this filter — place one to see it here with executions and fees.</EmptyState>}
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
                          <small className="muted block">{order.orderType}{order.reduceOnly ? ' · RO' : ''}</small>
                          <small className="muted block">{order.marketType === 'SPOT' ? 'Spot' : 'Futures'}</small>
                        </Td>
                        <Td>{formatNumber(order.quantity)}</Td>
                        <Td>{order.price ? formatNumber(order.price) : order.stopPrice ? `~${formatNumber(order.stopPrice)}` : '—'}</Td>
                        <Td>{filled > 0 ? formatNumber(String(filled)) : '—'}</Td>
                        <Td>{fees > 0 ? `${formatNumber(String(fees))} ${order.executions[0]?.feeAsset ?? ''}` : '—'}</Td>
                        <Td>
                          <div className="row-actions">
                            {!TERMINAL_STATES.has(order.state) && (
                              <button className="icon-btn danger" onClick={() => void cancelOrder(order)} title="Cancel order" type="button">
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
        </Card>
      </div>
    </>
  );
}