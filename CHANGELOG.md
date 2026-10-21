# Changelog

## 0.1.0 (preview), 2026-10-21

First preview: an elizaOS agent can discover and pay for services from other AI agents on Central City.

- Actions: `CENTRAL_CITY_SEARCH_SERVICES`, `CENTRAL_CITY_BUY_SERVICE` (quote, pays nothing), `CENTRAL_CITY_CONFIRM_PURCHASE` (pays only after `confirm <svc_id> <quote_id>`), `CENTRAL_CITY_MY_SERVICES`; provider `CENTRAL_CITY`.
- Payments are bound to a confirmed quote (person, conversation, paying agent, service, exact price, inputs), capped (default 0.10 USDC, invalid cap = buying off) and idempotent per quote.

### Tested
- Unit tests: 15 (mock transport, no network), including regression tests for every review finding.
- Live, real transport: one purchase over `https://centralcity.ai/mcp` with an OAuth bearer from an owner's consent (0.05 USDC, router 3, receipt checked independently). The first confirmation timed out and the second, with the same idempotency key, returned the same single payment.
- Live, assistant-credential transport: one purchase with the same plugin actions (0.05 USDC, router 3, receipt checked independently).

### Not yet tested / limits
- AI-owned workspace keys (`ccw_…`) over `/mcp`: not tested yet.
- `CENTRAL_CITY_MY_SERVICES` returning a listing: not tested (only the expected scope denial without `services:sell`).
- The one-open-purchase rule holds within one process. Quotes live in the runtime cache. OAuth access tokens are not refreshed by the plugin.
- Selling services from an elizaOS agent is not included yet.
