'use client';

import { Layers, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import AppShell from '../../components/layout/AppShell';
import { useApp } from '../../components/layout/AppContext';
import { ApiHttpError, apiFetch } from '../../lib/session';
import type { Balance, Market, OrderRow } from '../../lib/types';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Tab, TabBar } from '../../components/ui/Tabs';
import { OrderForm } from '../../components/domain/OrderForm';
import { OrderBookTable } from '../../components/domain/OrderBookTable';
import { ExecutionFeed } from '../../components/domain/ExecutionFeed';

export default function OrdersPage() {
  return (
    <AppShell active="orders">
      <OrdersBody />
    </AppShell>
  );
}

function OrdersBody() {
  const { toast, signOut } = useApp();
  const [tab, setTab] = useState<'trade' | 'activity'>('trade');
  const [markets, setMarkets] = useState<Market[] | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(false);
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
    const timer = setInterval(() => {
      void loadOrders(true);
      void loadSpotBalances();
    }, 15000);
    return () => clearInterval(timer);
  }, [loadOrders, loadSpotBalances]);

  const reloadAfterTrade = useCallback(async () => {
    await Promise.all([loadOrders(), loadSpotBalances()]);
  }, [loadOrders, loadSpotBalances]);

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
      toast('info', `Close-all: canceled ${result.canceled}, closed ${result.closed}/${result.positionsToClose} positions${result.closeFailures.length > 0 ? ` — ${result.closeFailures.length} failed` : ''}.`);
      await loadOrders();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Close-all failed.');
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
          <Button disabled={loadingOrders} onClick={() => void loadOrders()} variant="secondary">
            <RefreshCw size={14} /> Refresh
          </Button>
          <Button onClick={() => void closeAll()} variant="danger" tone="danger">
            <Layers size={14} /> Close all
          </Button>
        </div>
      </header>

      <TabBar ariaLabel="Orders view">
        <Tab active={tab === 'trade'} onClick={() => setTab('trade')}>
          Trade
        </Tab>
        <Tab active={tab === 'activity'} onClick={() => setTab('activity')}>
          Activity
        </Tab>
      </TabBar>

      {tab === 'trade' ? (
        <div className="orders-layout">
          <OrderForm markets={markets} onOrderPlaced={reloadAfterTrade} spotBalances={spotBalances} spotBalancesError={spotBalancesError} />
          <Card>
            <OrderBookTable loading={loadingOrders} onCancel={(order) => void cancelOrder(order)} orders={orders} />
          </Card>
        </div>
      ) : (
        <Card>
          <ExecutionFeed take={60} />
        </Card>
      )}
    </>
  );
}