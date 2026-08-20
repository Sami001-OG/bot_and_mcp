'use client';

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Market } from '../../lib/types';

export function SymbolPicker({ markets, marketsError, onRetryMarkets, selected, onChange, marketType }: { markets: Market[] | null; marketsError: string | null; onRetryMarkets: () => void; selected: string[]; onChange: (next: string[]) => void; marketType?: string }) {
  const [query, setQuery] = useState('');
  const [custom, setCustom] = useState('');

  const typeFilter = marketType?.toUpperCase() === 'SPOT' ? 'spot' : 'swap';
  const scoped = (markets ?? []).filter((market) => market.type === typeFilter);

  const toggle = (symbol: string) => onChange(selected.includes(symbol) ? selected.filter((item) => item !== symbol) : [...selected, symbol]);
  const queryUpper = query.trim().toUpperCase();
  const known = new Set(scoped.map((market) => market.symbol));
  const matching = scoped.filter((market) => market.symbol.toUpperCase().includes(queryUpper));
  const orphaned = selected.filter((symbol) => !known.has(symbol));
  const addMatches = () => onChange([...selected, ...matching.map((market) => market.symbol).filter((symbol) => !selected.includes(symbol))]);
  const addAll = () => onChange([...selected, ...scoped.map((market) => market.symbol).filter((symbol) => !selected.includes(symbol))]);
  const addCustom = () => {
    const trimmed = custom.trim().toUpperCase();
    if (trimmed && !selected.includes(trimmed)) onChange([...selected, trimmed]);
    setCustom('');
  };

  return (
    <label className="symbol-picker">
      <span>Symbols — {selected.length} selected</span>
      <div className="symbol-tools">
        <input className="symbol-search" onChange={(event) => setQuery(event.target.value)} placeholder="Search pairs (BTC, ETH, DOGE…)" type="search" value={query} />
        <div className="symbol-actions">
          <button disabled={!queryUpper} onClick={addMatches} type="button">Add all matches</button>
          <button disabled={scoped.length === 0} onClick={addAll} type="button">Select all</button>
          <button disabled={selected.length === 0} onClick={() => onChange([])} type="button">Clear</button>
        </div>
      </div>
      <div className="symbol-list">
        {!markets && !marketsError && <p className="muted small">Loading markets from the exchange…</p>}
        {!markets && marketsError && (
          <div className="symbol-error">
            <p className="muted small">{marketsError}</p>
            <button className="secondary" onClick={onRetryMarkets} type="button"><RefreshCw size={13} /> Retry</button>
          </div>
        )}
        {markets && scoped.length === 0 && <p className="muted small">No markets of this type returned by the exchange.</p>}
        {markets && matching.length === 0 && queryUpper && <p className="muted small">No matching markets.</p>}
        {orphaned.map((symbol) => (
          <label className="symbol-row orphan" key={`custom-${symbol}`}>
            <input checked onChange={() => toggle(symbol)} type="checkbox" />
            <span><b>{symbol}</b><em>custom pair</em></span>
          </label>
        ))}
        {matching.slice(0, 200).map((market) => (
          <label className="symbol-row" key={market.symbol}>
            <input checked={selected.includes(market.symbol)} onChange={() => toggle(market.symbol)} type="checkbox" />
            <span><b>{market.symbol}</b><em>{market.base} · {market.quote}</em></span>
          </label>
        ))}
        {matching.length > 200 && <p className="muted small">Showing first 200 matches — refine your search.</p>}
      </div>
      <div className="symbol-custom">
        <input onChange={(event) => setCustom(event.target.value)} placeholder="Add custom pair not listed, e.g. BTCUSD" type="text" value={custom} />
        <button disabled={!custom.trim()} onClick={addCustom} type="button">Add</button>
      </div>
      <input name="symbols" readOnly type="hidden" value={selected.join(', ')} />
    </label>
  );
}