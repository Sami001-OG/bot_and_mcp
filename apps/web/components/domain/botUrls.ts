export function webhookUrl(id: string): string {
  return `${window.location.origin}/api/webhooks/tradingview/${id}`;
}

export function botMcpUrl(botId: string): string {
  return `${window.location.origin}/api/mcp/bots/${botId}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}