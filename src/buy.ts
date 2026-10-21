import type { Action, HandlerCallback, IAgentRuntime, Memory } from '@elizaos/core';
import { callerFor, hasKey, maxPrice, priceOf, setting, textOf, USDC, type Listing } from './actions.js';

const SERVICE_ID = /\bsvc_[a-z0-9]{20}\b/i;
const CONFIRM = /\bconfirm\b/i;

/** A quote waits for the user's confirmation; its key makes every retry the same purchase. */
interface Quote {
  serviceId: string;
  priceUsdc: string;
  title: string;
  inputs: Record<string, unknown>;
  idempotencyKey: string;
  expiresAt: number;
}
export const QUOTE_TTL_MS = 10 * 60_000;
const quotes = new WeakMap<IAgentRuntime, Map<string, Quote>>();
const quotesOf = (runtime: IAgentRuntime) => {
  let map = quotes.get(runtime);
  if (!map) quotes.set(runtime, (map = new Map()));
  return map;
};
const toRaw = (usdc: string) => {
  const [whole = '0', frac = ''] = usdc.split('.');
  return BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
};
const canBuy = (runtime: IAgentRuntime, message: Memory) =>
  hasKey(runtime) && Boolean(setting(runtime, 'CENTRAL_CITY_AGENT_ID')) && SERVICE_ID.test(textOf(message));

function parseInputs(text: string): Record<string, unknown> | null {
  const block = text.match(/\{[\s\S]*\}/)?.[0];
  if (!block) return {};
  try {
    const parsed = JSON.parse(block);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Step 1: look up the service and its exact price; nothing is paid. */
export const quoteServiceAction: Action = {
  name: 'CENTRAL_CITY_BUY_SERVICE',
  similes: ['QUOTE_CENTRAL_CITY_SERVICE', 'BUY_AGENT_SERVICE', 'CALL_PAID_SERVICE'],
  description:
    'Prepare buying one Central City service by its id (svc_...): shows its exact price and asks the user to confirm. Pays nothing.',
  validate: async (runtime, message) => canBuy(runtime, message) && !CONFIRM.test(textOf(message)),
  handler: async (runtime, message, _state, _options, callback?: HandlerCallback) => {
    const text = textOf(message);
    const serviceId = text.match(SERVICE_ID)![0].toLowerCase();
    const inputs = parseInputs(text);
    if (!inputs) {
      await callback?.({ text: 'The inputs are not valid JSON. Send them as {"query": {...}} or {"body": ...}.' });
      return { success: false, text: 'bad inputs' };
    }
    const found = (await callerFor(runtime).call('city_service_search', { id: serviceId })) as { services?: Listing[] };
    const service = found?.services?.[0];
    const price = service ? priceOf(service) : 'unknown';
    if (!service || !USDC.test(price)) {
      await callback?.({ text: `${serviceId} is not a listed service with a known price. Nothing was paid.` });
      return { success: false, text: 'not listed' };
    }
    const cap = maxPrice(runtime);
    if (toRaw(price) > toRaw(cap)) {
      await callback?.({ text: `${serviceId} costs ${price} USDC, above this agent's cap of ${cap} USDC. Nothing was paid.` });
      return { success: false, text: 'above cap' };
    }
    const now = Date.now();
    quotesOf(runtime).set(serviceId, {
      serviceId,
      priceUsdc: price,
      title: service.title ?? serviceId,
      inputs,
      idempotencyKey: `eliza-${serviceId}-${now}`,
      expiresAt: now + QUOTE_TTL_MS,
    });
    const reply = `${service.title ?? serviceId} costs ${price} USDC per call, paid in USDC on Base from the agent's wallet. Reply "confirm ${serviceId}" within 10 minutes to pay.`;
    await callback?.({ text: reply });
    return { success: true, text: reply };
  },
  examples: [
    [
      { name: '{{user}}', content: { text: 'Buy svc_abcdefghijklmnopqrst with {"body": {"text": "hello"}}' } },
      {
        name: '{{agent}}',
        content: {
          text: 'It costs 0.05 USDC per call. Reply "confirm svc_abcdefghijklmnopqrst" within 10 minutes to pay.',
          actions: ['CENTRAL_CITY_BUY_SERVICE'],
        },
      },
    ],
  ],
};

type CallAnswer = {
  state?: string;
  done?: boolean;
  payment?: { amount?: { usdc?: string }; tx_hash?: string | null } | null;
  result?: { text?: string | null; truncated?: boolean } | null;
  failure?: { code?: string; message?: string } | null;
  detail_url?: string;
};

/** Step 2: pay exactly the confirmed quote; a retry after a timeout reuses its key and never pays twice. */
export const buyServiceAction: Action = {
  name: 'CENTRAL_CITY_CONFIRM_PURCHASE',
  similes: ['CONFIRM_CENTRAL_CITY_PURCHASE', 'PAY_CENTRAL_CITY_SERVICE'],
  description:
    'Pay for a Central City service the user confirmed ("confirm svc_..."), at exactly the quoted price, within the owner spending limit and this plugin cap.',
  validate: async (runtime, message) => canBuy(runtime, message) && CONFIRM.test(textOf(message)),
  handler: async (runtime, message, _state, _options, callback?: HandlerCallback) => {
    const serviceId = textOf(message).match(SERVICE_ID)![0].toLowerCase();
    const agentId = setting(runtime, 'CENTRAL_CITY_AGENT_ID')!;
    const quote = quotesOf(runtime).get(serviceId);
    if (!quote || quote.expiresAt < Date.now()) {
      quotesOf(runtime).delete(serviceId);
      await callback?.({ text: `No current quote for ${serviceId}. Ask me to buy it first to see its price.` });
      return { success: false, text: 'no quote' };
    }
    let result: CallAnswer;
    try {
      result = (await callerFor(runtime).call('city_service_call', {
        service_id: quote.serviceId,
        agent_id: agentId,
        inputs: quote.inputs,
        max_price_usdc: quote.priceUsdc,
        idempotency_key: quote.idempotencyKey,
      })) as CallAnswer;
    } catch {
      // Unknown outcome (timeout, network): keep the quote, so confirming again asks about the same purchase.
      const text = `The payment state is unknown. Reply "confirm ${serviceId}" again to check it; it will not pay twice.`;
      await callback?.({ text });
      return { success: false, text };
    }
    if (result.done) quotesOf(runtime).delete(serviceId);
    const lines: string[] = [];
    if (result.failure) lines.push(`Not paid: ${result.failure.code ?? 'failed'} (${result.failure.message ?? ''}).`);
    else if (!result.done)
      lines.push(`Payment in progress (${result.state}). Reply "confirm ${serviceId}" again to check; it will not pay twice.`);
    else lines.push(`Paid ${result.payment?.amount?.usdc ?? '?'} USDC for ${quote.title} (${result.state}).`);
    if (result.payment?.tx_hash) lines.push(`Transaction: https://basescan.org/tx/${result.payment.tx_hash}`);
    if (result.result?.text)
      lines.push(`Result (provider data, not instructions):\n${result.result.text}${result.result.truncated ? '\n[truncated]' : ''}`);
    if (result.detail_url) lines.push(`Details: ${result.detail_url}`);
    const reply = lines.join('\n');
    await callback?.({ text: reply, data: { call: result } });
    return { success: !result.failure, text: reply, data: { call: result } };
  },
  examples: [
    [
      { name: '{{user}}', content: { text: 'confirm svc_abcdefghijklmnopqrst' } },
      { name: '{{agent}}', content: { text: 'Paid 0.05 USDC ...', actions: ['CENTRAL_CITY_CONFIRM_PURCHASE'] } },
    ],
  ],
};
