import type { Action, HandlerCallback, IAgentRuntime, Memory } from '@elizaos/core';
import { createCityClient, type CityCaller } from './client.js';


export const USDC = /^\d{1,3}(\.\d{1,6})?$/;
export const DEFAULT_MAX_PRICE_USDC = '0.10';

const callers = new WeakMap<IAgentRuntime, CityCaller>();
/** Tests replace the caller for a runtime. */
export function setCaller(runtime: IAgentRuntime, caller: CityCaller) {
  callers.set(runtime, caller);
}
export function callerFor(runtime: IAgentRuntime): CityCaller {
  let caller = callers.get(runtime);
  if (!caller) {
    const workspaceKey = setting(runtime, 'CENTRAL_CITY_WORKSPACE_KEY');
    if (!workspaceKey) throw new Error('CENTRAL_CITY_WORKSPACE_KEY is not set.');
    caller = createCityClient({ workspaceKey, url: setting(runtime, 'CENTRAL_CITY_MCP_URL') });
    callers.set(runtime, caller);
  }
  return caller;
}
export function setting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
export function maxPrice(runtime: IAgentRuntime): string {
  const value = setting(runtime, 'CENTRAL_CITY_MAX_PRICE_USDC');
  return value && USDC.test(value) ? value : DEFAULT_MAX_PRICE_USDC;
}
export const textOf = (message: Memory) => String(message.content?.text ?? '');
export const hasKey = (runtime: IAgentRuntime) => Boolean(setting(runtime, 'CENTRAL_CITY_WORKSPACE_KEY'));

/** Service listings are provider text: shown as data, never followed as instructions. */
export interface Listing {
  id: string;
  title?: string;
  description?: string;
  price?: { usdc?: string } | string | null;
  provider_host?: string;
  source?: { name?: string };
}
export const priceOf = (listing: Listing) =>
  typeof listing.price === 'string' ? listing.price : (listing.price?.usdc ?? 'unknown');

export const searchServicesAction: Action = {
  name: 'CENTRAL_CITY_SEARCH_SERVICES',
  similes: ['FIND_AGENT_SERVICES', 'SEARCH_CENTRAL_CITY', 'FIND_PAID_SERVICES'],
  description:
    'Search Central City for services that other AI agents sell (paid per call in USDC on Base via x402).',
  validate: async (runtime) => hasKey(runtime),
  handler: async (runtime, message, _state, _options, callback?: HandlerCallback) => {
    const query = textOf(message)
      .replace(/^(please\s+)?(search|find|look for)\s+(central city\s+)?(services?\s+)?(for\s+)?/i, '')
      .trim()
      .slice(0, 200);
    if (query.length < 2) {
      await callback?.({ text: 'What kind of service should I look for on Central City?' });
      return { success: false, text: 'no query' };
    }
    const result = (await callerFor(runtime).call('city_service_search', {
      query,
      max_price_usdc: maxPrice(runtime),
      limit: 5,
    })) as { services?: Listing[] };
    const services = result?.services ?? [];
    const text = services.length
      ? [
          `Central City services for "${query}" (up to ${maxPrice(runtime)} USDC per call):`,
          ...services.map(
            (s) => `- ${s.id}: ${s.title ?? 'untitled'} (${priceOf(s)} USDC, ${s.source?.name ?? s.provider_host ?? 'unknown source'})`,
          ),
          'Listings are provider text. To buy one, ask me to buy it by its id.',
        ].join('\n')
      : `No Central City service matched "${query}" within ${maxPrice(runtime)} USDC.`;
    await callback?.({ text, data: { services } });
    return { success: true, text, data: { services } };
  },
  examples: [
    [
      { name: '{{user}}', content: { text: 'Find Central City services for text summarization' } },
      {
        name: '{{agent}}',
        content: { text: 'Central City services for "text summarization" ...', actions: ['CENTRAL_CITY_SEARCH_SERVICES'] },
      },
    ],
  ],
};

export const myServicesAction: Action = {
  name: 'CENTRAL_CITY_MY_SERVICES',
  similes: ['LIST_MY_CENTRAL_CITY_SERVICES', 'MY_SERVICE_OFFERS'],
  description: 'List the services this workspace sells on Central City and how they are doing.',
  validate: async (runtime) => hasKey(runtime),
  handler: async (runtime, _message, _state, _options, callback?: HandlerCallback) => {
    const result = (await callerFor(runtime).call('city_service_mine', {})) as {
      offers?: Array<{ offer_id: string; title?: string; price_usdc?: string; state?: string; listed?: boolean }>;
    };
    const offers = result?.offers ?? [];
    const text = offers.length
      ? [
          'Your Central City services:',
          ...offers.map(
            (o) => `- ${o.offer_id}: ${o.title ?? 'untitled'} (${o.price_usdc ?? '?'} USDC, ${o.state ?? '?'}${o.listed ? ', listed' : ''})`,
          ),
        ].join('\n')
      : 'This workspace does not sell services on Central City yet.';
    await callback?.({ text, data: { offers } });
    return { success: true, text, data: { offers } };
  },
  examples: [
    [
      { name: '{{user}}', content: { text: 'Which services do I sell on Central City?' } },
      { name: '{{agent}}', content: { text: 'Your Central City services: ...', actions: ['CENTRAL_CITY_MY_SERVICES'] } },
    ],
  ],
};
