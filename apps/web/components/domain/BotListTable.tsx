'use client';

import { Copy, Pause, Play, RefreshCw, Settings2, Square, Trash2 } from 'lucide-react';
import { formatConfig, STATUS_TONES } from '../../lib/format';
import type { BotSummary } from '../../lib/types';
import { useApp } from '../layout/AppContext';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { StatusBadge } from '../ui/StatusBadge';
import { Table, Td, Th, TableScroll } from '../ui/Table';
import { copyText, webhookUrl } from './botUrls';

export function BotListTable({
  bots,
  selectedId,
  loading,
  onSelect,
  onRefresh,
  onResume,
  onPause,
  onStop,
  onEdit,
  onDelete,
  onDeleteAll,
}: {
  bots: BotSummary[];
  selectedId: string | null;
  loading: boolean;
  onSelect: (botId: string) => void;
  onRefresh: () => void;
  onResume: (bot: BotSummary) => void;
  onPause: (bot: BotSummary) => void;
  onStop: (bot: BotSummary) => void;
  onEdit: (bot: BotSummary) => void;
  onDelete: (bot: BotSummary) => void;
  onDeleteAll: () => void;
}) {
  const { toast } = useApp();

  return (
    <div>
      <div className="table-head-row">
        <p className="eyebrow">BOTS</p>
        <span className="muted small">{bots.length} configured</span>
        <div className="row-actions">
          {bots.length > 0 && (
            <Button disabled={loading} onClick={onDeleteAll} size="sm" tone="danger" variant="secondary">
              <Trash2 size={13} /> Delete all
            </Button>
          )}
          <Button disabled={loading} onClick={onRefresh} size="sm" variant="secondary">
            <RefreshCw size={13} /> Refresh
          </Button>
        </div>
      </div>
      <TableScroll>
        {!loading && bots.length === 0 && <EmptyState>No bots yet — create one to connect a TradingView webhook.</EmptyState>}
        {bots.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Bot</Th>
                <Th>Webhook</Th>
                <Th>Status</Th>
                <Th>Version</Th>
                <Th>Config</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {bots.map((bot) => (
                <tr className={selectedId === bot.id ? 'selected-row' : ''} key={bot.id} onClick={() => onSelect(bot.id)}>
                  <Td>
                    <b>{bot.name}</b>
                    <small className="muted block">{bot.type}{bot.exchangeAccount ? ` · ${bot.exchangeAccount.label ?? bot.exchangeAccount.exchange} ${bot.exchangeAccount.marketType}` : ''}</small>
                  </Td>
                  <Td className="webhook-cell">
                    {bot.webhook ? (
                      <button
                        className="wh-copy"
                        onClick={async (event) => {
                          event.stopPropagation();
                          const copied = await copyText(webhookUrl(bot.webhook!.id));
                          toast(copied ? 'success' : 'error', copied ? `Webhook URL for "${bot.name}" copied.` : 'Could not copy — select the URL manually.');
                        }}
                        title="Copy webhook URL"
                        type="button"
                      >
                        <code>/{bot.webhook.id.slice(0, 8)}</code><Copy size={13} />
                      </button>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </Td>
                  <Td>
                    <StatusBadge tone={STATUS_TONES[bot.status]}>{bot.status}</StatusBadge>
                  </Td>
                  <Td>v{bot.activeVersion}</Td>
                  <Td className="config-cell" title={formatConfig(bot.config)}>{formatConfig(bot.config)}</Td>
                  <Td className="row-actions" onMouseDown={(event) => event.stopPropagation()}>
                    {bot.status !== 'ACTIVE' && <button className="icon-btn safe" onClick={() => onResume(bot)} title="Resume" type="button"><Play size={14} /></button>}
                    {bot.status === 'ACTIVE' && <button className="icon-btn" onClick={() => onPause(bot)} title="Pause" type="button"><Pause size={14} /></button>}
                    <button className="icon-btn" onClick={() => onEdit(bot)} title="Edit config" type="button"><Settings2 size={14} /></button>
                    {bot.status !== 'STOPPED' && <button className="icon-btn danger" onClick={() => onStop(bot)} title="Stop" type="button"><Square size={14} /></button>}
                    <button className="icon-btn danger" onClick={() => onDelete(bot)} title="Delete permanently" type="button"><Trash2 size={14} /></button>
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