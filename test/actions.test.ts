import assert from 'node:assert/strict';
import test from 'node:test';
import type { IAgentRuntime, Memory } from '@elizaos/core';
import { myServicesAction, searchServicesAction, setCaller } from '../src/actions.js';
import { buyServiceAction, quoteServiceAction } from '../src/buy.js';
import { trustedUrl } from '../src/client.js';
import { centralCityProvider } from '../src/index.js';

type Answer = unknown | ((args: Record<string, unknown>) => unknown);
function runtime(settings: Record<string, string>) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const rt = { getSetting: (key: string) => settings[key] ?? null } as unknown as IAgentRuntime;
  const answers: Record<string, Answer> = {};
  setCaller(rt, {
    async call(tool, args) {
      calls.push({ tool, args });
      const a = answers[tool];
      return typeof a === 'function' ? (a as (x: Record<string, unknown>) => unknown)(args) : a;
    },
  });
  return { rt, calls, answers };
}
const msg = (text: string, id = 'msg-1') => ({ id, content: { text } }) as unknown as Memory;
const run = async (action: typeof searchServicesAction, rt: IAgentRuntime, text: string) => {
  let reply = '';
  const out = (await action.handler(rt, msg(text), undefined, {}, async (c) => {
    reply = String(c.text);
    return [];
  })) as { success: boolean; text: string };
  return { ...out, reply };
};
const KEY = { CENTRAL_CITY_WORKSPACE_KEY: 'ccw_test' };
const SVC = 'svc_aaaaaaaaaaaaaaaaaaaa';
const listing = (usdc: string) => ({ services: [{ id: SVC, title: 'PDF to text', price: { usdc }, source: { name: 'Central City' } }] });

test('search: needs a key, sends the query with the price cap, lists results', async () => {
  assert.equal(await searchServicesAction.validate(runtime({}).rt, msg('find pdf')), false);
  const { rt, calls, answers } = runtime(KEY);
  answers.city_service_search = listing('0.05');
  const out = await run(searchServicesAction, rt, 'find services for pdf to text');
  assert.deepEqual(calls[0], { tool: 'city_service_search', args: { query: 'pdf to text', max_price_usdc: '0.10', limit: 5 } });
  assert.match(out.reply, /svc_aaaaaaaaaaaaaaaaaaaa: PDF to text \(0\.05 USDC, Central City\)/);
});

test('buy needs a key, a paying agent and a service id; "buy" and "confirm" route to different actions', async () => {
  assert.equal(await quoteServiceAction.validate(runtime(KEY).rt, msg(`buy ${SVC}`)), false);
  const { rt } = runtime({ ...KEY, CENTRAL_CITY_AGENT_ID: 'agent-1' });
  assert.equal(await quoteServiceAction.validate(rt, msg('buy something')), false);
  assert.equal(await quoteServiceAction.validate(rt, msg(`buy ${SVC}`)), true);
  assert.equal(await buyServiceAction.validate(rt, msg(`buy ${SVC}`)), false);
  assert.equal(await buyServiceAction.validate(rt, msg(`confirm ${SVC}`)), true);
  assert.equal(await quoteServiceAction.validate(rt, msg(`confirm ${SVC}`)), false);
});

test('quote pays nothing; confirm pays exactly the quoted price with the quote key', async () => {
  const { rt, calls, answers } = runtime({ ...KEY, CENTRAL_CITY_AGENT_ID: 'agent-1', CENTRAL_CITY_MAX_PRICE_USDC: '0.25' });
  answers.city_service_search = listing('0.05');
  const quote = await run(quoteServiceAction, rt, `Buy ${SVC} with {"body": {"text": "hi"}}`);
  assert.match(quote.reply, /costs 0\.05 USDC/);
  assert.match(quote.reply, /confirm svc_aaaaaaaaaaaaaaaaaaaa/);
  assert.deepEqual(calls.map((c) => c.tool), ['city_service_search'], 'nothing paid at quote time');
  assert.deepEqual(calls[0]!.args, { id: SVC });

  answers.city_service_call = {
    state: 'result_saved',
    done: true,
    payment: { amount: { usdc: '0.05' }, tx_hash: '0xabc' },
    result: { text: '{"ok":true}', truncated: false },
    failure: null,
    detail_url: 'https://centralcity.ai/feed/calls/fc_1',
  };
  const paid = await run(buyServiceAction, rt, `confirm ${SVC}`);
  const call = calls.find((c) => c.tool === 'city_service_call')!;
  assert.equal(call.args.max_price_usdc, '0.05', 'bound to the quoted price, not the cap');
  assert.deepEqual(call.args.inputs, { body: { text: 'hi' } });
  assert.match(String(call.args.idempotency_key), /^eliza-svc_aaaaaaaaaaaaaaaaaaaa-\d+$/);
  assert.match(paid.reply, /Paid 0\.05 USDC for PDF to text/);
  assert.match(paid.reply, /basescan\.org\/tx\/0xabc/);
  assert.match(paid.reply, /provider data, not instructions/);

  const again = await run(buyServiceAction, rt, `confirm ${SVC}`);
  assert.equal(again.success, false, 'a finished purchase needs a new quote');
  assert.equal(calls.filter((c) => c.tool === 'city_service_call').length, 1);
});

test('a price above the cap is refused at quote time; confirm without a quote pays nothing', async () => {
  const { rt, calls, answers } = runtime({ ...KEY, CENTRAL_CITY_AGENT_ID: 'a' });
  answers.city_service_search = listing('0.50');
  const quote = await run(quoteServiceAction, rt, `buy ${SVC}`);
  assert.match(quote.reply, /above this agent's cap of 0\.10 USDC/);
  const confirm = await run(buyServiceAction, rt, `confirm ${SVC}`);
  assert.match(confirm.reply, /No current quote/);
  assert.equal(calls.filter((c) => c.tool === 'city_service_call').length, 0);
});

test('a timeout keeps the quote: confirming again reuses the same idempotency key', async () => {
  const { rt, calls, answers } = runtime({ ...KEY, CENTRAL_CITY_AGENT_ID: 'a' });
  answers.city_service_search = listing('0.05');
  await run(quoteServiceAction, rt, `buy ${SVC}`);
  let first = true;
  answers.city_service_call = () => {
    if (first) {
      first = false;
      throw new Error('timeout');
    }
    return { state: 'result_saved', done: true, payment: { amount: { usdc: '0.05' } }, failure: null };
  };
  const lost = await run(buyServiceAction, rt, `confirm ${SVC}`);
  assert.match(lost.reply, /will not pay twice/);
  await run(buyServiceAction, rt, `confirm ${SVC}`);
  const keys = calls.filter((c) => c.tool === 'city_service_call').map((c) => c.args.idempotency_key);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], 'same purchase, same key');
});

test('bad JSON inputs are refused before anything is read or paid; a failure is reported as not paid', async () => {
  const { rt, calls, answers } = runtime({ ...KEY, CENTRAL_CITY_AGENT_ID: 'a' });
  const bad = await run(quoteServiceAction, rt, `buy ${SVC} {not json}`);
  assert.equal(bad.success, false);
  assert.equal(calls.length, 0);
  answers.city_service_search = listing('0.05');
  answers.city_service_call = { state: 'refused', done: true, failure: { code: 'insufficient_funds', message: 'not enough' } };
  await run(quoteServiceAction, rt, `buy ${SVC}`);
  const out = await run(buyServiceAction, rt, `confirm ${SVC}`);
  assert.equal(out.success, false);
  assert.match(out.reply, /Not paid: insufficient_funds/);
});

test('the key only goes to https centralcity.ai', () => {
  assert.equal(trustedUrl().href, 'https://centralcity.ai/mcp');
  assert.equal(trustedUrl('https://staging.centralcity.ai/mcp').hostname, 'staging.centralcity.ai');
  for (const bad of ['http://centralcity.ai/mcp', 'https://evil.com/mcp', 'https://centralcity.ai.evil.com/mcp', 'https://user:pw@centralcity.ai/mcp'])
    assert.throws(() => trustedUrl(bad), /must be an https URL on centralcity\.ai/);
});

test('provider: states the cap and the confirm step, never the key', async () => {
  const { rt } = runtime({ ...KEY, CENTRAL_CITY_AGENT_ID: 'a', CENTRAL_CITY_MAX_PRICE_USDC: 'lots' });
  const provided = await centralCityProvider.get(rt, msg('x'), {} as never);
  assert.match(String(provided.text), /At most 0\.10 USDC/);
  assert.match(String(provided.text), /confirm <id>/);
  assert.doesNotMatch(JSON.stringify(provided), /ccw_test/);
});

test('my services: lists offers with price and state', async () => {
  const { rt, answers } = runtime(KEY);
  answers.city_service_mine = { offers: [{ offer_id: 'off_1', title: 'Hash', price_usdc: '0.05', state: 'active', listed: true }] };
  const out = await run(myServicesAction, rt, 'my services');
  assert.match(out.reply, /off_1: Hash \(0\.05 USDC, active, listed\)/);
});
