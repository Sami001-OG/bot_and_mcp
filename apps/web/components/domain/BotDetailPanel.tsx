'use client';

import { Bot, Copy, X } from 'lucide-react';
import { formatConfig, formatTime } from '../../lib/format';
import type { BotDetail } from '../../lib/types';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { StatusBadge } from '../ui/StatusBadge';
import { copyText, botMcpUrl, webhookUrl } from './botUrls';

export function BotDetailPanel({ bot, onClose }: { bot: BotDetail; onClose: () => void }) {
  return (
    <div>
      <div className="detail-head">
        <div>
          <p className="eyebrow">BOT DETAIL</p>
          <h3>
            {bot.name} <small className="muted">v{bot.activeVersion}</small>
          </h3>
        </div>
        <button aria-label="Close detail" className="icon-btn" onClick={onClose} type="button">
          <X size={16} />
        </button>
      </div>
      <p className="muted small config-line">{formatConfig(bot.config)}</p>
      {bot.webhook && (
        <div className="bot-webhook">
          <p className="eyebrow">WEBHOOK ENDPOINT</p>
          <div className="wh-row">
            <code className="wh-url">{webhookUrl(bot.webhook.id)}</code>
            <Button onClick={() => void copyText(webhookUrl(bot.webhook!.id))} size="sm" variant="secondary">
              <Copy size={14} /> Copy URL
            </Button>
          </div>
          <p className="muted small">
            TradingView strategy alerts sent to this URL run <b>only this bot</b> · leverage {bot.config.leverage ?? '1'}x
          </p>
          <p className="eyebrow" style={{ marginTop: '0.75rem' }}>MCP ENDPOINT</p>
          <div className="wh-row">
            <code className="wh-url">{botMcpUrl(bot.id)}</code>
            <Button onClick={() => void copyText(botMcpUrl(bot.id))} size="sm" variant="secondary">
              <Copy size={14} /> Copy URL
            </Button>
          </div>
          <p className="muted small">
            MCP client: <code>npx mcp-remote {botMcpUrl(bot.id)}</code> — authenticate with the bot&apos;s webhook signing secret.
          </p>
        </div>
      )}
      <h3 className="section-title">Runs <span className="muted">(last {bot.runs.length})</span></h3>
      {bot.runs.length === 0 && <EmptyState>No runs yet — every routed webhook signal records a run.</EmptyState>}
      <div className="timeline">
        {bot.runs.map((run) => (
          <div className="timeline-item" key={run.id}>
            <span className={`dot ${run.status === 'ERROR' ? 'warn' : 'ok'}`} />
            <div className="timeline-body">
              <div className="timeline-head">
                <b>{String(run.metrics.action ?? run.status)}</b>
                <StatusBadge tone={run.status === 'ERROR' ? 'bad' : 'ok'}>{run.status}</StatusBadge>
                <em>{formatTime(run.startedAt)}</em>
              </div>
              <div className="timeline-meta">
                {typeof run.metrics.symbol === 'string' && <span>{run.metrics.symbol}</span>}
                {typeof run.metrics.price === 'string' && <span>mark {run.metrics.price}</span>}
                {Array.isArray(run.metrics.orders) && <span>{run.metrics.orders.length} orders</span>}
                {Array.isArray(run.metrics.skipped) && run.metrics.skipped.length > 0 && <span className="loss">{run.metrics.skipped.length} skipped</span>}
                {typeof run.metrics.error === 'string' && <span className="loss">{run.metrics.error}</span>}
              </div>
              {Array.isArray(run.metrics.skipped) && run.metrics.skipped.length > 0 && <p className="muted small line-clamp">{String(run.metrics.skipped.join(' · '))}</p>}
            </div>
          </div>
        ))}
      </div>
      <h3 className="section-title">Versions</h3>
      <div className="versions">
        {bot.versions.map((version) => (
          <div className="version-row" key={version.id}>
            <StatusBadge tone={version.version === bot.activeVersion ? 'ok' : 'muted'}>v{version.version}</StatusBadge>
            <code title={formatConfig(version.config)}>{formatConfig(version.config)}</code>
            <em>{formatTime(version.createdAt)}</em>
          </div>
        ))}
      </div>
    </div>
  );
}

export function BotDetailPlaceholder() {
  return (
    <div className="detail-placeholder">
      <Bot size={28} />
      <p>Select a bot to view its runs timeline and version history.</p>
    </div>
  );
}