'use client';

import { Send } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useApp } from '../layout/AppContext';
import { apiFetch } from '../../lib/session';
import { ALLOCATION_MODES, MARKET_MODES, ORDER_TYPES, POSITION_SIDES, SIDES, SPOT_ORDER_TYPES, type MarketMode } from '../../lib/format';
import type { Balance, Market, PlaceResult } from '../../lib/types';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';

function needsPrice(type: string): boolean {
  return type === 'LIMIT' || type === 'STOP_LIMIT' || type === 'TAKE_PROFIT' || type === 'TRAILING_STOP';
}

function needsStop(type: string): boolean {
  return type === 'STOP' || type === 'STOP_MARKET' || type === 'STOP_LIMIT' || type === 'TAKE_PROFIT' || type === 'TAKE_PROFIT_MARKET';
}

export function OrderForm({
  markets,
  spotBalances,
  spotBalancesError,
  onOrderPlaced,
}: {
  markets: Market[] | null;
  spotBalances: Balance[] | null;
  spotBalancesError: boolean;
  onOrderPlaced: () => void | Promise<void>;
}) {
  const { toast } = useApp();
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
  const [submitting, setSubmitting] = useState(false);

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

  const isFutures = marketMode === 'USDT_FUTURES';
  const sellDisabled = marketMode === 'SPOT' && side === 'SELL' && spotBalances !== null && !spotBalancesError && (spotHoldingBase ?? 0) <= 0;

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

      const result = await apiFetch<PlaceResult>('/api/orders', { method: 'POST', body });
      if (!result.accepted) {
        toast('error', `Order rejected (${result.order.state}) — likely a duplicate idempotency key.`);
      } else {
        const executionNote = result.execution?.error ? ` — ${result.execution.error}` : '';
        const sizingNote = result.sized ? ` — ${result.sized.quantity} @ ${result.marketPrice ?? '?'} (${result.sized.notional} USDT${result.sized.leverage ? `, ${result.sized.leverage}x` : ''})` : '';
        toast('success', `Order ${result.order.state} — ${effectiveSide} ${sizing === 'quantity' ? quantity : `${allocationMode} ${allocationValue}`} ${symbol}${sizingNote}${executionNote}.`);
      }
      setQuantity('');
      setAllocationValue('');
      await onOrderPlaced();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Order placement failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
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
  );
}