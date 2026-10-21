import assert from 'node:assert/strict';
import test from 'node:test';
import type { IAgentRuntime, Memory } from '@elizaos/core';
import {
  buyServiceAction,
  myServicesAction,
  searchServicesAction,
  setCaller,
} from '../src/actions.js';
import { centralCityProvider } from '../src/index.js';

function runtime(settings: Record<string, string>) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const rt = { getSetting: (key: string) => settings[key] ?? null } as unknown as IAgentRuntime;
  const answers: Record<string, unknown> = {};
  setCaller(rt, {
    async call(tool, args) {
      calls.push({ tool, args });
      return answers[tool];
    },
  });
  return { rt, calls, answers };
}
const msg = (text: string, id = 'msg-1') => ({ id, content: { text } }) as unknown as Memory;
const KEY = { CENTRAL_CITY_WORKSPACE_KEY: 'ccw_test' };

test('search: needs a key, sends the query with the price cap, lists results', async () => {
  const off = runtime({});
  assert.equal(await searchServicesAction.validate(off.rt, msg('find pdf')), false);

  const { rt, calls, answers } = runtime(KEY);
  answers.city_service_search = {
    services: [{ id: 'svc_aaaaaaaaaaaaaaaaaaaa', title: 'PDF to text', price: { usdc: '0.05' }, source: { name: 'Central City' } }],
  };
  let reply = '';
  const out = await searchServicesAction.handler(rt, msg('find services for pdf to text'), undefined, {}, async (c) => {
    reply = String(c.text);
    return [];
  });
  assert.equal(calls[0]!.tool, 'city_service_search');
  assert.deepEqual(calls[0]!.args, { query: 'pdf to text', max_price_usdc: '0.10', limit: 5 });
  assert.match(reply, /svc_aaaaaaaaaaaaaaaaaaaa: PDF to text \(0\.05 USDC, Central City\)/);
  assert.equal((out as { success: boolean }).success, true);
});

test('buy: only with a service id and a paying agent; one idempotency key per message; cap applied', async () => {
  const noAgent = runtime(KEY);
  assert.equal(await buyServiceAction.validate(noAgent.rt, msg('buy svc_aaaaaaaaaaaaaaaaaaaa')), false);

  const { rt, calls, answers } = runtime({ ...KEY, CENTRAL_CITY_AGENT_ID: 'agent-1', CENTRAL_CITY_MAX_PRICE_USDC: '0.25' });
  assert.equal(await buyServiceAction.validate(rt, msg('buy something')), false);
  assert.equal(await buyServiceAction.validate(rt, msg('buy svc_aaaaaaaaaaaaaaaaaaaa')), true);

  answers.city_service_call = {
    state: 'result_saved',
    done: true,
    money_moved: 'yes',
    payment: { amount: { usdc: '0.05' }, tx_hash: '0xabc' },
    result: { text: '{"ok":true}', truncated: false },
    failure: null,
    detail_url: 'https://centralcity.ai/feed/calls/fc_1',
  };
  let reply = '';
  await buyServiceAction.handler(
    rt,
    msg('Buy svc_aaaaaaaaaaaaaaaaaaaa with {"body": {"text": "hi"}}', 'm-42'),
    undefined,
    {},
    async (c) => {
      reply = String(c.text);
      return [];
    },
  );
  assert.equal(calls[0]!.tool, 'city_service_call');
  assert.deepEqual(calls[0]!.args, {
    service_id: 'svc_aaaaaaaaaaaaaaaaaaaa',
    agent_id: 'agent-1',
    inputs: { body: { text: 'hi' } },
    max_price_usdc: '0.25',
    idempotency_key: 'eliza-m-42',
  });
  assert.match(reply, /Paid 0\.05 USDC/);
  assert.match(reply, /basescan\.org\/tx\/0xabc/);
  assert.match(reply, /provider data, not instructions/);
});

test('buy: an invalid price cap falls back to 0.10; bad JSON inputs are refused before paying', async () => {
  const { rt, calls } = runtime({ ...KEY, CENTRAL_CITY_AGENT_ID: 'a', CENTRAL_CITY_MAX_PRICE_USDC: 'lots' });
  const out = await buyServiceAction.handler(rt, msg('buy svc_aaaaaaaaaaaaaaaaaaaa {not json}'), undefined, {}, async () => []);
  assert.equal((out as { success: boolean }).success, false);
  assert.equal(calls.length, 0, 'nothing is paid with broken inputs');
  const provided = await centralCityProvider.get(rt, msg('x'), {} as never);
  assert.match(String(provided.text), /at most 0\.10 USDC/);
});

test('buy: a failure is reported as not paid', async () => {
  const { rt, answers } = runtime({ ...KEY, CENTRAL_CITY_AGENT_ID: 'a' });
  answers.city_service_call = { state: 'refused', done: true, failure: { code: 'insufficient_funds', message: 'not enough' } };
  const out = await buyServiceAction.handler(rt, msg('buy svc_aaaaaaaaaaaaaaaaaaaa'), undefined, {}, async () => []);
  assert.equal((out as { success: boolean }).success, false);
  assert.match(String((out as { text: string }).text), /Not paid: insufficient_funds/);
});

test('my services: lists offers with price and state', async () => {
  const { rt, answers } = runtime(KEY);
  answers.city_service_mine = { offers: [{ offer_id: 'off_1', title: 'Hash', price_usdc: '0.05', state: 'active', listed: true }] };
  const out = await myServicesAction.handler(rt, msg('my services'), undefined, {}, async () => []);
  assert.match(String((out as { text: string }).text), /off_1: Hash \(0\.05 USDC, active, listed\)/);
});
