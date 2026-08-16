'use client';

import { ArrowLeftRight, Ban, Layers, RefreshCw, Send } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import AppShell, { type ShellContext } from '../components/AppShell';
import { ApiHttpError, apiFetch, type AuthSession } from '../../lib/session';

type Market = { symbol: string; base: string; quote: string; type: string; active: boolean };

type Execution = { id: string; exchangeExecutionId: string | null; quantity: string; price: string; fee: string; feeAsset: string | null; executedAt: string | null };
type OrderRow = {
  id: string;
  state: string;
  side: string;
  positionSide: string;
  symbol: string;
  orderType: string;
  quantity: string;
  price: string | null;
  stopPrice: string | null;
  reduceOnly: boolean;
  rejectionReason: string | null;
  createdAt: string;
  executions: Execution[];
};

type PlaceResult = { accepted: boolean; order: { id: string; state: string; symbol: string; side: string; quantity: string }; marketPrice?: string; sized?: { quantity: string; notional: string; leverage?: number }; execution?: { state: string; exchangeOrderId?: string; filled?: number; error?: string }; duplicate?: boolean };

const ORDER_TYPES = ['MARKET', 'LIMIT', 'STOP', 'STOP_MARKET', 'STOP_LIMIT', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET', 'TRAILING_STOP'] as const;
const SIDES = ['BUY', 'SELL'] as const;
const POSITION_SIDES = ['BOTH', 'LONG', 'SHORT'] as const;
const ALLOCATION_MODES = ['FIXED_AMOUNT', 'PERCENT_EQUITY', 'PERCENT_MAX_EQUITY', 'RISK_PERCENT'] as const;

const TERMINAL_STATES = new Set(['FILLED', 'REJECTED', 'CANCELED', 'FAILED', 'EXPIRED']);
const STATE_TONES: Record<string, string> = { FILLED: 'ok', QUEUED: 'ok', RECEIVED: 'muted', PLACED: 'warn', OPEN: 'warn', PARTIALLY_FILLED: 'warn', REJECTED: 'bad', CANCELED: 'muted', FAILED: 'bad', EXPIRED: 'muted' };

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatNumber(value: string, digits = 6): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return amount.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function needsPrice(type: string): boolean {
  return type === 'LIMIT' || type === 'STOP_LIMIT' || type === 'TAKE_PROFIT' || type === 'TRAILING_STOP';
}

function needsStop(type: string): boolean {
  return type === 'STOP' || type === 'STOP_MARKET' || type === 'STOP_LIMIT' || type === 'TAKE_PROFIT' || type === 'TAKE_PROFIT_MARKET';
}

export default function OrdersPage() {
  return (
    <AppShell active="orders">
      {({ session, setNotice, signOut }) => <OrdersBody session={session} setNotice={setNotice} signOut={signOut} />}
    </AppShell>
  );
}

function OrdersBody({ session, setNotice, signOut }: { session: AuthSession; setNotice: ShellContext['setNotice']; signOut: ShellContext['signOut'] }) {
  const [markets, setMarkets] = useState<Market[] | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [symbol, setSymbol] = useState('');
  const [side, setSide] = useState<string>('BUY');
  const [type, setType] = useState<string>('MARKET');
  const [positionSide, setPositionSide] = useState<string>('BOTH');
  const [sizing, setSizing] = useState<'quantity' | 'allocation'>('quantity');
  const [allocationMode, setAllocationMode] = useState<string>('FIXED_AMOUNT');
  const [quantity, setQuantity] = useState('');
  const [allocationValue, setAllocationValue] = useState('');
  const [price, setPrice] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [leverage, setLeverage] = useState('');

  const loadMarkets = useCallback(async () => {
    try {
      const data = await apiFetch<{ symbols: Market[] }>('/api/markets?quote=USDT', session);
      setMarkets(data.symbols);
    } catch {
      setMarkets([]);
    }
  }, [session]);

  const loadOrders = useCallback(async () => {
    setLoadingOrders(true);
    try {
      const data = await apiFetch<{ orders: OrderRow[] }>('/api/orders', session);
      setOrders(data.orders);
    } catch (error) {
      if (error instanceof ApiHttpError && error.status === 401) {
        signOut();
        setNotice({ tone: 'error', message: 'Session expired — sign in again.' });
      } else {
        setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Failed to load orders.' });
      }
    } finally {
      setLoadingOrders(false);
    }
  }, [session, setNotice, signOut]);

  useEffect(() => {
    void loadMarkets();
    void loadOrders();
  }, [loadMarkets, loadOrders]);

  const placeOrder = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const hasQuantity = sizing === 'quantity' && quantity.trim() !== '';
    const hasAllocation = sizing === 'allocation' && allocationValue.trim() !== '';
    if (!hasQuantity && !hasAllocation) {
      setNotice({ tone: 'error', message: 'Provide a quantity or an allocation amount/percent.' });
      return;
    }
    if (needsPrice(type) && !price.trim()) {
      setNotice({ tone: 'error', message: `${type} orders require a limit price.` });
      return;
    }
    if (needsStop(type) && !stopPrice.trim()) {
      setNotice({ tone: 'error', message: `${type} orders require a stop/trigger price.` });
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        symbol,
        side,
        positionSide,
        type,
        reduceOnly,
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
      if (leverageNumber >= 1 && leverageNumber <= 200) body.leverage = leverageNumber;

      const result = await apiFetch<PlaceResult>('/api/orders', session, {
        method: 'POST',
        body,
      });
      if (!result.accepted) {
        setNotice({ tone: 'error', message: `Order rejected (${result.order.state}) — likely a duplicate idempotency key.` });
      } else {
        const executionNote = result.execution?.error ? ` · ${result.execution.error}` : '';
        const sizingNote = result.sized ? ` · ${result.sized.quantity} @ ${result.marketPrice ?? '?'} (${result.sized.notional} USDT${result.sized.leverage ? `, ${result.sized.leverage}x` : ''})` : '';
        setNotice({ tone: 'success', message: `Order ${result.order.state} — ${side} ${sizing === 'quantity' ? quantity : `${allocationMode} ${allocationValue}`} ${symbol}${sizingNote}${executionNote}.` });
      }
      setQuantity('');
      setAllocationValue('');
      await loadOrders();
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Order placement failed.' });
    } finally {
      setSubmitting(false);
    }
  };

  const cancelOrder = async (order: OrderRow) => {
    if (!window.confirm(`Cancel ${order.symbol} ${order.side} ${order.orderType}?`)) return;
    try {
      const result = await apiFetch<{ orderId: string; state: string }>(`/api/orders/${order.id}/cancel`, session, { method: 'POST', body: {} });
      setNotice({ tone: 'info', message: `Cancel result: ${result.state} for ${order.symbol} ${order.side}.` });
      await loadOrders();
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Cancel failed.' });
    }
  };

  const closeAll = async () => {
    if (!window.confirm('Cancel all open orders and place market reduce-only orders to close ALL open positions?')) return;
    try {
      const result = await apiFetch<{ canceled: number; positionsToClose: number; closed: number; closeFailures: string[] }>('/api/orders/emergency/close-all', session, { method: 'POST', body: {} });
      setNotice({ tone: 'info', message: `Close-all: canceled ${result.canceled}, closed ${result.closed}/${result.positionsToClose} positions${result.closeFailures.length > 0 ? ` · ${result.closeFailures.length} failed` : ''}.` });
      await loadOrders();
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Close-all failed.' });
    }
  };

  return (
    <>
      <header>
        <div>
          <p className="eyebrow">EXECUTION</p>
          <h1>Orders</h1>
          <p className="muted">Place orders through the risk engine, or cancel and close positions.</p>
        </div>
        <div className="header-actions">
          <button className="secondary" disabled={loadingOrders} onClick={() => void loadOrders()} type="button">
            <RefreshCw size={14} /> Refresh
          </button>
          <button className="danger" onClick={() => void closeAll()} type="button">
            <Layers size={14} /> Close all
          </button>
        </div>
      </header>

      <div className="orders-layout">
        <article className="order-form-card">
          <div className="card-head">
            <div>
              <p>NEW ORDER</p>
              <h3>Place on Bybit</h3>
            </div>
            <span className="status-label warn">CONFIGURED ACCOUNT</span>
          </div>
          <form onSubmit={placeOrder}>
            <div className="form-row">
              <label>
                Symbol
                <input list="order-markets" onChange={(event) => setSymbol(event.target.value)} placeholder="e.g. BTC/USDT:USDT" required value={symbol} />
                <datalist id="order-markets">
                  {(markets ?? []).slice(0, 500).map((market) => (
                    <option key={market.symbol} value={market.symbol} />
                  ))}
                </datalist>
              </label>
              <label>
                Type
                <select onChange={(event) => setType(event.target.value)} value={type}>
                  {ORDER_TYPES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="form-row">
              <label>
                Side
                <select onChange={(event) => setSide(event.target.value)} value={side}>
                  {SIDES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Position side
                <select onChange={(event) => setPositionSide(event.target.value)} value={positionSide}>
                  {POSITION_SIDES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
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
              <div className="sizing-toggle">
                <button className={sizing === 'quantity' ? 'active' : ''} onClick={() => setSizing('quantity')} type="button">
                  Use quantity
                </button>
                <button className={sizing === 'allocation' ? 'active' : ''} onClick={() => setSizing('allocation')} type="button">
                  Use allocation
                </button>
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
            <div className="form-row">
              <label>
                Leverage (futures)
                <input max="200" min="1" onChange={(event) => setLeverage(event.target.value)} placeholder="1–200" type="number" value={leverage} />
              </label>
              <label className="checkbox">
                <input checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} type="checkbox" /> Reduce-only close
              </label>
            </div>
            <div className="modal-actions">
              <button className="primary" disabled={submitting} type="submit">
                <Send size={14} /> {submitting ? 'Submitting…' : 'Place order'}
              </button>
            </div>
          </form>
        </article>

        <article>
          <div className="card-head">
            <div>
              <p>ORDER BOOK</p>
              <h3>{orders.length} recent intents</h3>
            </div>
            <ArrowLeftRight size={16} className="muted" />
          </div>
          <div className="table-scroll">
            {!loadingOrders && orders.length === 0 && <p className="muted empty">No orders yet — place one to see it here with executions and fees.</p>}
            {orders.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>State</th>
                    <th>Side</th>
                    <th>Symbol</th>
                    <th>Qty</th>
                    <th>Price</th>
                    <th>Fill</th>
                    <th>Fee</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => {
                    const filled = order.executions.reduce((sum, execution) => sum + Number(execution.quantity), 0);
                    const fees = order.executions.reduce((sum, execution) => sum + Number(execution.fee), 0);
                    return (
                      <tr key={order.id}>
                        <td>{formatTime(order.createdAt)}</td>
                        <td>
                          <span className={`status-label ${STATE_TONES[order.state] ?? 'muted'}`}>{order.state}</span>
                        </td>
                        <td>
                          <span className={order.side === 'BUY' ? 'long' : 'short'}>{order.side}</span>
                          {order.positionSide !== 'BOTH' && <small className="muted block">{order.positionSide}</small>}
                        </td>
                        <td>
                          <b>{order.symbol}</b>
                          <small className="muted block">{order.orderType}{order.reduceOnly ? ' · RO' : ''}</small>
                        </td>
                        <td>{formatNumber(order.quantity)}</td>
                        <td>{order.price ? formatNumber(order.price) : order.stopPrice ? `~${formatNumber(order.stopPrice)}` : '—'}</td>
                        <td>{filled > 0 ? formatNumber(String(filled)) : '—'}</td>
                        <td>{fees > 0 ? `${formatNumber(String(fees))} ${order.executions[0]?.feeAsset ?? ''}` : '—'}</td>
                        <td>
                          <div className="row-actions">
                            {!TERMINAL_STATES.has(order.state) && (
                              <button className="icon-btn danger" onClick={() => void cancelOrder(order)} title="Cancel order" type="button">
                                <Ban size={13} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </article>
      </div>
    </>
  );
}