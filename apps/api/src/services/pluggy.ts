import { config } from '../config.js';

const PLUGGY_BASE = 'https://api.pluggy.ai';

let _apiKeyCache: { key: string; expiresAt: number } | null = null;

async function getApiKey(): Promise<string> {
  const now = Date.now();
  if (_apiKeyCache && _apiKeyCache.expiresAt > now + 60_000) {
    return _apiKeyCache.key;
  }

  const res = await fetch(`${PLUGGY_BASE}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: config.pluggyClientId,
      clientSecret: config.pluggyClientSecret,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Pluggy auth failed ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { apiKey: string; expiresIn?: number };
  _apiKeyCache = {
    key: data.apiKey,
    expiresAt: now + (data.expiresIn ?? 7200) * 1000,
  };
  return data.apiKey;
}

async function pluggyFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const apiKey = await getApiKey();
  const res = await fetch(`${PLUGGY_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Pluggy ${path} failed ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

export type PluggyConnectToken = { accessToken: string };

export async function createConnectToken(options?: {
  itemId?: string;
  webhookUrl?: string;
}): Promise<string> {
  const body: Record<string, unknown> = {};
  if (options?.itemId) body.itemId = options.itemId;
  if (options?.webhookUrl) body.webhookUrl = options.webhookUrl;

  const data = await pluggyFetch<PluggyConnectToken>('/connect_token', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data.accessToken;
}

export type PluggyAccount = {
  id: string;
  itemId: string;
  name: string;
  type: string;
  balance: number;
  currencyCode: string;
};

export type PluggyItem = {
  id: string;
  status: string;
  connector: { name: string };
  createdAt: string;
  updatedAt: string;
};

export async function getItem(itemId: string): Promise<PluggyItem> {
  return pluggyFetch<PluggyItem>(`/items/${itemId}`);
}

export async function deleteItem(itemId: string): Promise<void> {
  const apiKey = await getApiKey();
  await fetch(`${PLUGGY_BASE}/items/${itemId}`, {
    method: 'DELETE',
    headers: { 'X-API-KEY': apiKey },
  });
}

export type PluggyTransaction = {
  id: string;
  accountId: string;
  date: string;
  description: string;
  amount: number;
  type: 'DEBIT' | 'CREDIT';
  category?: string;
  currencyCode: string;
};

export type PluggyTransactionsPage = {
  results: PluggyTransaction[];
  total: number;
  page: number;
  totalPages: number;
};

export async function getTransactions(
  accountId: string,
  from?: string,
  to?: string,
  page = 1
): Promise<PluggyTransactionsPage> {
  const params = new URLSearchParams({ accountId, page: String(page) });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return pluggyFetch<PluggyTransactionsPage>(`/transactions?${params.toString()}`);
}

export async function getAccounts(itemId: string): Promise<PluggyAccount[]> {
  const data = await pluggyFetch<{ results: PluggyAccount[] }>(`/accounts?itemId=${itemId}`);
  return data.results;
}

export function isPluggyConfigured(): boolean {
  return Boolean(config.pluggyClientId && config.pluggyClientSecret);
}
