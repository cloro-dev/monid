# Proposal: add-connector-cloro

## Why

Agents that do GEO and SEO work need to know what AI assistants and Google
show to a real user in a given country: which brands an answer names, which
pages it cites, and where a page ranks. A model API completion does not
answer that question. The consumer products (ChatGPT, Gemini, Perplexity,
Copilot, Google AI Mode, Google Search) give different answers from
their APIs, with web search, citations, shopping cards and ads.

cloro scrapes those products and returns the result as structured JSON. The
catalog has `ai-search` and `geo` leaves, but no endpoint that returns the
consumer answer of these assistants.

Mechanically it is an easy fit: one base URL, bearer auth, seven synchronous
JSON endpoints with an `X-Credits-Charged` header on every successful
response, and one async task API that the async run protocol already
covers. No new engine capability is necessary.

## What Changes

- **connectors/cloro**: 7 sync endpoints against `https://api.cloro.dev/v1`,
  bearer auth:
  `POST /monitor/chatgpt`, `/monitor/gemini`, `/monitor/copilot`,
  , `/monitor/perplexity`, `/monitor/aimode`,
  `/monitor/google` and `/monitor/google/news`.
- **The vendor meter is a header.** cloro puts the credits it charged in
  `X-Credits-Charged`, not in the body. The provider declares a sync
  `lifecycle.start` relay (the ahrefs pattern) that reads the header into
  `state.data.creditsCharged`, and a provider `usage.consolidate` that
  claims it. The claim includes per-organization overrides and the AI Mode
  product adjustment. A missing or malformed header falls back to the card.
- **The def is cloro's rate card.** Each endpoint is a COMPOSITE: a `call`
  line (base credits + the 2-credit sync surcharge) and one PER_UNIT line per
  add-on the request can turn on:
  - `state_targeting` (+2) on ChatGPT, Gemini, Copilot, Perplexity.
  - `raw_data` (+2, once) on ChatGPT for any of `rawResponse`,
    `searchQueries`, `ads`, `shopping`.
  - `ai_overview` (+2, once) on Google for `aioverview` or `paaAioverview`.
  - `extra_page` (+2 per page after the first) on Google and Google News.
    For a Google `url` request, the page count comes from the URL's `num`,
    as cloro derives it.
  - `expanded_product` (+1 per cluster returned, at most 6) on AI Mode.
    The estimate holds the documented maximum of 6; evidence counts
    `result.productResults`.
  Rate card: https://cloro.dev/docs/guides/providers, checked 2026-09-21.
- **Faithful mirrors.** Each `schema/inputs.ts` mirrors the OpenAPI request
  body with optionality only. cloro rejects unknown fields
  (`additionalProperties: false`), so the mirrors are strict objects.
  Where cloro requires one of several fields (`country` or `gl` on AI Mode
  and Google News; `query + country`, `query + gl` or `url` on Google), the
  binding is a union with required keys per arm, which compiles to `anyOf`.
  The
  one binding default is Google News `pages` (1), which the estimate reads.
  Google `pages` stays optional, because cloro rejects it together with
  `url`.
- **Async twins.** 7 async endpoints, `cloro#async/<engine>`, one for
  each sync endpoint. Each one submits `POST /async/task` with
  `{taskType, payload: <the sync body>, idempotencyKey: <runId>}` and polls
  `GET /async/task/{id}`:
  - The input schema is the schema of the sync twin, so the payload is
    validated before the wire.
  - The lifecycle is on each endpoint, not on the provider, because the
    provider `lifecycle.start` is the sync header relay. `poll` is
    byte-identical across the 7 and interns to one fnTable entry; `start`
    differs only in the `taskType` literal.
  - `QUEUED` and `PROCESSING` stay RUNNING. A 408, 429 or 5xx on the status
    lookup also stays RUNNING, with a 15 s back-off, because the task keeps
    running and cloro charges it.
  - `COMPLETED` returns `{success: true, result: <response>}`, the shape of
    the sync twin, and puts `credits.creditsCharged` into
    `state.data.creditsCharged`, the field the provider claim reads.
  - `FAILED` returns a synthesized 500 (`providerHttpStatus` 200) with
    cloro's `{error: {code, message}}` blob, so the provider `fromError`
    digests it. cloro charges a FAILED task 0.
  - The `runId` idempotency key makes a retried submit a 409, not a second
    charged task. cloro finds a task by its id only, so that 409 is
    returned as an error, settled at zero.
  - There is no `stop`: cloro cannot cancel one task, only clear the queue
    of the whole organization.
  - The card is the sync card without the 2-credit sync surcharge:
    ChatGPT 5, Copilot 5, Gemini 4, Perplexity 4, AI Mode 4, Google 3,
    Google News 3, with the same add-on lines.
  - Timeouts: 30 s per request, 5 s poll cadence, 30 min per run, so that
    the run budget covers queue time.
- **Errors.** A provider `output.fromError` digests
  `{error: {code, message}}` into `{message, code?, raw}`.
- Synthetic provider-level fixtures (`synthetic-answer`,
  `synthetic-unauthorized`, `async-completed`, `async-failed`) for the
  billing and lifecycle cases, plus real recordings for
  `google` and `chatgpt`. The recorded `X-Credits-Charged` (5 and 7) equals
  the card.
- `shared/testing/fixtures.ts`: `x-credits-charged` joins
  `RECORDED_RES_HEADERS`, so the recorder keeps the meter.

## Capabilities

- `cloro-connector`.

## Non-goals

- `/v1/monitor/grok` is not ported. cloro marks Grok as temporarily
  unavailable (Grok blocks anonymous access), and every call fails.

- `/v1/async/task/batch` is not ported. One monid run is one task, so the
  single-task submit covers it.
- No webhook. cloro can POST the result to a `webhook.url`, but the poll
  gives the same result without a host ingress route.
- `/v1/monitor/google/goto`, `/v1/countries`, `/v1/states` and
  `/v1/credits` are free utility reads and are not ported.
- No dollar conversion in the doc. cloro's price per credit depends on the
  plan, so the pool is cloro credits and the conversion is the broker
  card's job.

## Impact

New connector tree, 14 new ids in `connectors/ids.lock.json`, and one new
recorded response header. No new
`Unit`, preset, hook or category, and no compiler or engine change.
