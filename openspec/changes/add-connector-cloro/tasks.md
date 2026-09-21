# Tasks: add-connector-cloro

## 1. Vendor surface

- [x] 1.1 Read the published OpenAPI spec: base url, bearer auth, the seven
      available `/v1/monitor/*` request bodies (Grok is unavailable), the error body, `X-Credits-Charged`
- [x] 1.2 Read the rate card (https://cloro.dev/docs/guides/providers): base credits,
      add-ons, the 2-credit sync surcharge, the AI Mode product adjustment,
      the Google `url` depth rule

## 2. Provider

- [x] 2.1 `provider.ts`: bearer auth, `/v1` baseUrl, timeouts, header relay
      lifecycle, credit pool, claim, `output.fromError`
- [x] 2.2 `schema/common.ts`: shared field mirrors

## 3. Endpoints (7)

- [x] 3.1 `chatgpt`: call + raw_data + state_targeting
- [x] 3.2 `gemini`, `copilot`, `perplexity`: call + state_targeting
- [x] 3.3 `google`: call + extra_page + ai_overview, url depth rule
- [x] 3.4 `google-news`: call + extra_page, `pages` default 1
- [x] 3.5 `aimode`: call + expanded_product
- [x] 3.6 Add the 7 ids to `connectors/ids.lock.json`

## 4. Fixtures and tests

- [x] 4.1 Synthetic provider-level chains: `synthetic-answer`,
      `synthetic-unauthorized`
- [x] 4.2 `provider.test.ts`: claim, mismatch, malformed headers, provider
      error, the card per endpoint, estimates, strict input, interning
- [x] 4.3 Live test gated on `CLORO_API_KEY`
- [x] 4.4 Record real chains for google and chatgpt; add `x-credits-charged`
      to `RECORDED_RES_HEADERS` so the recorder keeps the meter
