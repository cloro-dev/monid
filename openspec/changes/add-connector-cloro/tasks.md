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

## 5. Async twins

- [x] 5.1 Read the async API (`POST /v1/async/task`,
      `GET /v1/async/task/{taskId}`) and cloro's backend: no sync surcharge,
      FAILED is charged 0 and stores `{error: {code, message}}`, the status
      lookup is by task id only
- [x] 5.2 `endpoints/async-*`: 7 endpoints with an endpoint-level
      `start` + `poll`, the sync input schemas, and the card without the
      surcharge
- [x] 5.3 Add the 7 `cloro#async/*` ids to `connectors/ids.lock.json`
- [x] 5.4 `synthetic-async-completed` and `synthetic-async-failed` chains; `async.test.ts`:
      claim, mismatch, malformed claims, FAILED, rejected submit, the card
      per endpoint, estimates, interning
- [x] 5.5 Live test `cloro#async/google` (gated on `CLORO_API_KEY`): the
      claim equals the card (3)
