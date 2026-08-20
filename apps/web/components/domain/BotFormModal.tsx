'use client';

import { useApp } from '../layout/AppContext';
import { apiFetch } from '../../lib/session';
import { ALLOCATION_OPTIONS } from '../../lib/format';
import type { Allocation, BotConfig, BotCreateResult, BotDetail, BotSecretReveal, ExchangeAccountRef, Market } from '../../lib/types';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { SymbolPicker } from './SymbolPicker';
import { botMcpUrl, webhookUrl } from './botUrls';

const ACTION_OPTIONS = ['BUY', 'SELL', 'LONG', 'SHORT', 'CLOSE_LONG', 'CLOSE_SHORT', 'REVERSE', 'PARTIAL_EXIT'] as const;

type EditTarget = { id: string; name: string; config: BotConfig };

export function BotFormModal({
  open,
  editTarget,
  accounts,
  markets,
  marketsError,
  selectedAccountId,
  onAccountChange,
  symbols,
  onSymbolsChange,
  selected,
  onClose,
  onSaved,
  onRetryMarkets,
}: {
  open: boolean;
  editTarget: EditTarget | null;
  accounts: ExchangeAccountRef[];
  markets: Market[] | null;
  marketsError: string | null;
  selectedAccountId: string;
  onAccountChange: (id: string) => void;
  symbols: string[];
  onSymbolsChange: (symbols: string[]) => void;
  selected: BotDetail | null;
  onClose: () => void;
  onSaved: (reveal: BotSecretReveal | null) => Promise<void>;
  onRetryMarkets: () => void;
}) {
  const { toast } = useApp();
  const prefill = editTarget?.config;

  const persistBot = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsedSymbols = String(form.get('symbols') ?? '')
      .split(',')
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean);
    if (parsedSymbols.length === 0) {
      toast('error', 'Enter at least one symbol, e.g. BTC/USDT.');
      return;
    }
    if (!editTarget && !selectedAccountId) {
      toast('error', 'Choose the exchange API this bot trades with.');
      return;
    }
    const config: BotConfig = { symbols: parsedSymbols };
    const allocationMode = String(form.get('allocationMode') ?? 'NONE');
    const allocationValue = String(form.get('allocationValue') ?? '').trim();
    if (allocationMode !== 'NONE' && allocationValue) {
      config.allocation = allocationMode === 'FIXED_AMOUNT'
        ? { mode: 'FIXED_AMOUNT', amount: allocationValue }
        : { mode: allocationMode as Allocation['mode'], percent: Number(allocationValue) };
    }
    const leverage = Number(form.get('leverage'));
    if (leverage >= 1) config.leverage = leverage;
    const stopLoss = String(form.get('stopLoss') ?? '').trim();
    if (stopLoss) config.stopLoss = stopLoss;
    const takeProfits = String(form.get('takeProfits') ?? '')
      .split(',')
      .map((target) => target.trim())
      .filter(Boolean);
    if (takeProfits.length > 0) config.takeProfits = takeProfits;
    config.requireSignalStopLoss = form.get('requireSignalStopLoss') === 'on';
    const actions = form.getAll('actions') as string[];
    if (actions.length > 0) config.actions = actions;
    if (form.get('dcaEnabled') === 'on') {
      config.dca = {
        enabled: true,
        triggerDropPercent: Number(form.get('dcaTriggerDropPercent')),
        ...(Number(form.get('dcaStepDropPercent')) > 0 ? { stepDropPercent: Number(form.get('dcaStepDropPercent')) } : {}),
        amountMode: String(form.get('dcaAmountMode')) as 'FIXED' | 'PERCENT_EQUITY',
        amount: Number(form.get('dcaAmount')),
        maxSteps: Number(form.get('dcaMaxSteps')),
      };
    }
    if (form.get('breakevenEnabled') === 'on') {
      config.breakeven = {
        enabled: true,
        moveAtProfitPercent: Number(form.get('breakevenMoveAtProfitPercent')),
        ...(Number(form.get('breakevenSafeProfitPercent')) > 0 ? { safeProfitPercent: Number(form.get('breakevenSafeProfitPercent')) } : {}),
      };
    }
    if (form.get('partialTpsEnabled') === 'on') {
      const levels = String(form.get('partialTpLevels') ?? '')
        .split(',')
        .map((pair) => pair.trim())
        .filter(Boolean)
        .map((pair) => pair.split(':'))
        .map(([priceRaw, closeRaw]) => ({ pricePercent: Number(priceRaw), closePercent: Number(closeRaw) }))
        .filter((level) => Number.isFinite(level.pricePercent) && level.pricePercent > 0 && Number.isFinite(level.closePercent) && level.closePercent > 0);
      if (levels.length > 0) config.partialTps = { enabled: true, levels };
    }
    if (form.get('trailingEnabled') === 'on') {
      config.trailing = { enabled: true, callbackPercent: Number(form.get('trailingCallbackPercent')) };
    }

    try {
      let reveal: BotSecretReveal | null = null;
      if (editTarget) {
        await apiFetch(`/api/bots/${editTarget.id}`, { method: 'PATCH', body: { config } });
        toast('success', `Bot "${editTarget.name}" updated (new version created).`);
      } else {
        const name = String(form.get('name') ?? '').trim();
        const password = String(form.get('password') ?? '').trim();
        const result = await apiFetch<BotCreateResult>('/api/bots', { method: 'POST', body: { name, exchangeAccountId: selectedAccountId, ...(password ? { password } : {}), config } });
        reveal = {
          botName: result.bot.name,
          url: webhookUrl(result.webhook.id),
          signingSecret: result.webhook.signingSecret,
          mcpUrl: botMcpUrl(result.bot.id),
        };
        toast('success', `Bot "${result.bot.name}" created and ACTIVE.`);
      }
      await onSaved(reveal);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Failed to save bot.');
    }
  };

  const marketType = editTarget
    ? (selected?.exchangeAccount?.marketType ?? undefined)
    : (accounts.find((account) => account.id === selectedAccountId)?.marketType ?? undefined);

  return (
    <Modal open wide eyebrow={editTarget ? 'EDIT CONFIG' : 'AUTOMATION'} title={editTarget ? `Edit ${editTarget.name}` : 'New webhook bot'} onClose={onClose}>
      <form key={`${editTarget?.id ?? 'new'}:${open}`} onSubmit={persistBot}>
        {!editTarget && (
          <>
            <label>Name<input minLength={1} name="name" placeholder="e.g. btc-breakout" required /></label>
            <label>Webhook / MCP password<input autoComplete="new-password" minLength={12} name="password" placeholder="12+ chars — leave empty to auto-generate" type="text" /></label>
            <p className="muted small pad-top">This password is the webhook HMAC signing secret <b>and</b> the MCP Bearer token — shown once after creation.</p>
            <label>
              Exchange API (credentials)
              <select name="exchangeAccountId" onChange={(event) => onAccountChange(event.target.value)} required value={selectedAccountId}>
                {accounts.length === 0 && <option value="">No APIs — add one in Exchange APIs first</option>}
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.label ?? `${account.exchange} ${account.marketType}`}{account.isPrimary ? ' (primary)' : ''}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {editTarget && (
          <p className="muted small pad-top">
            Trading API: {selected && selected.exchangeAccount ? `${selected.exchangeAccount.label ?? selected.exchangeAccount.exchange} ${selected.exchangeAccount.marketType}` : 'bound at creation'}
          </p>
        )}
        <SymbolPicker
          markets={markets}
          marketsError={marketsError}
          onRetryMarkets={onRetryMarkets}
          onChange={onSymbolsChange}
          selected={symbols}
          {...(marketType ? { marketType } : {})}
        />
        <div className="form-row">
          <label>Allocation mode<select defaultValue={prefill?.allocation?.mode ?? 'NONE'} name="allocationMode">{ALLOCATION_OPTIONS.map((mode) => <option key={mode} value={mode}>{mode === 'NONE' ? 'Use signal size' : mode}</option>)}</select></label>
          <label>Amount / percent<input defaultValue={prefill?.allocation?.mode === 'FIXED_AMOUNT' ? prefill.allocation.amount : prefill?.allocation?.percent ?? ''} min="0.001" name="allocationValue" step="any" type="number" /></label>
        </div>
        <div className="form-row">
          <label>Leverage<input defaultValue={prefill?.leverage ?? ''} min="1" max="200" name="leverage" type="number" /></label>
          <label>Stop loss price<input defaultValue={prefill?.stopLoss ?? ''} name="stopLoss" placeholder="90000" type="text" /></label>
        </div>
        <label>Take profits (comma separated)<input defaultValue={prefill?.takeProfits?.join(', ') ?? ''} name="takeProfits" placeholder="100000, 110000" type="text" /></label>
        <label className="checkbox"><input defaultChecked={prefill?.requireSignalStopLoss} name="requireSignalStopLoss" type="checkbox" /> Require a stop loss before entering</label>
        <fieldset className="action-field">
          <legend>Allowed signal actions</legend>
          <div className="action-grid">
            {ACTION_OPTIONS.map((action) => (
              <label key={action}><input defaultChecked={prefill?.actions?.includes(action) ?? false} name="actions" type="checkbox" value={action} /> {action}</label>
            ))}
          </div>
        </fieldset>

        <fieldset className="action-field">
          <legend>DCA — average down</legend>
          <label className="checkbox"><input defaultChecked={prefill?.dca?.enabled ?? false} name="dcaEnabled" type="checkbox" /> Automatically add to a losing position</label>
          <div className="form-row">
            <label>Trigger drop %<input defaultValue={prefill?.dca?.triggerDropPercent ?? 3} min="0.1" name="dcaTriggerDropPercent" step="any" type="number" /></label>
            <label>Step drop % (optional)<input defaultValue={prefill?.dca?.stepDropPercent ?? ''} min="0.1" name="dcaStepDropPercent" step="any" type="number" /></label>
          </div>
          <div className="form-row">
            <label>Amount mode<select defaultValue={prefill?.dca?.amountMode ?? 'FIXED'} name="dcaAmountMode"><option value="FIXED">Fixed $ amount</option><option value="PERCENT_EQUITY">% of equity</option></select></label>
            <label>Amount per step<input defaultValue={prefill?.dca?.amount ?? 50} min="0.01" name="dcaAmount" step="any" type="number" /></label>
            <label>Max steps<input defaultValue={prefill?.dca?.maxSteps ?? 3} min="1" max="20" name="dcaMaxSteps" type="number" /></label>
          </div>
          <p className="muted small">Evaluated on every run: when price drops {prefill?.dca?.triggerDropPercent ?? 3}% below entry, an extra entry is added (one step per run, up to max steps).</p>
        </fieldset>

        <fieldset className="action-field">
          <legend>Breakeven stop-loss move</legend>
          <label className="checkbox"><input defaultChecked={prefill?.breakeven?.enabled ?? false} name="breakevenEnabled" type="checkbox" /> Move the stop loss to breakeven when in profit</label>
          <div className="form-row">
            <label>Move at profit %<input defaultValue={prefill?.breakeven?.moveAtProfitPercent ?? 2} min="0.1" name="breakevenMoveAtProfitPercent" step="any" type="number" /></label>
            <label>Safe profit % (optional)<input defaultValue={prefill?.breakeven?.safeProfitPercent ?? ''} min="0.01" name="breakevenSafeProfitPercent" step="any" type="number" /></label>
          </div>
          <p className="muted small">When price moves {prefill?.breakeven?.moveAtProfitPercent ?? 2}% in favor, the stop loss moves to entry (or entry + safe profit %).</p>
        </fieldset>

        <fieldset className="action-field">
          <legend>Partial take-profit claims</legend>
          <label className="checkbox"><input defaultChecked={prefill?.partialTps?.enabled ?? false} name="partialTpsEnabled" type="checkbox" /> Claim a percentage of the position at each TP level</label>
          <label>TP levels (price% : close%)<input defaultValue={prefill?.partialTps?.levels.map((level) => `${level.pricePercent}:${level.closePercent}`).join(', ') ?? ''} name="partialTpLevels" placeholder="2:30, 5:30, 10:40" type="text" /></label>
          <p className="muted small">Comma separated, e.g. <code>2:30, 5:40, 10:30</code> closes 30% at +2%, 40% at +5%, 30% at +10%. Levels must sum to 100% or less.</p>
        </fieldset>

        <fieldset className="action-field">
          <legend>Trailing stop</legend>
          <label className="checkbox"><input defaultChecked={prefill?.trailing?.enabled ?? false} name="trailingEnabled" type="checkbox" /> Attach a trailing stop to every entry</label>
          <label>Callback %<input defaultValue={prefill?.trailing?.callbackPercent ?? 1.5} min="0.01" name="trailingCallbackPercent" step="any" type="number" /></label>
          <p className="muted small">A reduce-only trailing stop activates at the entry price. Once price moves {prefill?.trailing?.callbackPercent ?? 1.5}% past the highest point, the stop follows the price. Can be combined with a fixed stop loss.</p>
        </fieldset>
        <div className="modal-actions">
          <Button onClick={onClose} variant="secondary">
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            {editTarget ? 'Save config' : 'Create bot'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}