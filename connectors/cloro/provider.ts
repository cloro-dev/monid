import { defineProvider, presets } from "@shared/core";
import { z } from "zod";

/**
 * cloro (cloro.dev) — structured scrapes of AI assistants and Google
 * search surfaces, Bearer auth. Seven synchronous JSON endpoints,
 * `POST https://api.cloro.dev/v1/monitor/<engine>`, each answering
 * `{ success: true, result: {...} }`. Seven async twins on
 * `POST /v1/async/task` + `GET /v1/async/task/{id}`, which author their
 * own lifecycle (see endpoints/async-chatgpt) and return the same shape.
 *
 * BILLING. cloro bills one pool of credits per organization. A sync
 * request costs the engine's base credits, plus a flat 2-credit sync
 * surcharge, plus the add-ons the request turns on (state targeting,
 * ChatGPT raw data, Google AI Overview, extra Google pages, AI Mode
 * expanded products). Each endpoint states that card as a COMPOSITE: one
 * `call` line (base + sync surcharge) and one PER_UNIT line per add-on.
 * Rate card: https://cloro.dev/docs/guides/providers (checked 2026-09-21).
 *
 * The actual charge is the vendor claim (design D27): every sync 200
 * carries `X-Credits-Charged`, the credits cloro took for the request, AI
 * Mode product adjustments and per-organization overrides included. A sync
 * lifecycle relay (the ahrefs pattern) carries it into state for
 * usage.consolidate. The async endpoints read the same claim from the
 * status body (`credits.creditsCharged`) into the same state field, and
 * their card has no sync surcharge. A missing or malformed claim falls
 * back to the rate card. Non-2xx responses and FAILED tasks are not
 * charged by cloro, and the engine settles them at zero.
 */
export default defineProvider({
    name: "cloro",
    meta: {
        displayName: "cloro",
        summary:
            "Structured answers from ChatGPT, Gemini, Perplexity, Copilot, Google AI Mode and Google Search.",
        description: "cloro runs a prompt or a query on a real AI assistant " +
            "or Google surface, in a chosen country, and returns the answer " +
            "as structured JSON: the answer text, the cited sources, " +
            "shopping cards, brand entities and ads, or the full Google " +
            "SERP with organic results, People Also Ask and the AI " +
            "Overview. Use it to measure how a brand or a page shows up in " +
            "AI answers (GEO) and in search results (SEO). It returns what " +
            "a real user in that country sees, not a model API completion.",
        homepageUrl: "https://cloro.dev",
        docsUrl: "https://cloro.dev/docs",
        categories: ["ai-search", "geo", "seo"],
        notes: [
            "Billed in cloro credits: the endpoint's base credits, plus a " +
            "2-credit surcharge on the sync monitor endpoints, plus the " +
            "add-ons the request turns on. cloro's own credit claim " +
            "settles the bill; without it, settlement falls back to the " +
            "published rate card.",
            "The monitor endpoints are synchronous and can take up to a " +
            "few minutes on the AI assistant engines. The async endpoints " +
            "queue a cloro task and poll it until it completes.",
        ],
    },
    auth: { inject: presets.auth.bearer() },
    request: {
        baseUrl: "https://api.cloro.dev/v1",
        headers: { Accept: "application/json" },
    },
    // cloro stops a sync scrape after 5 minutes (docs changelog); the
    // run budget leaves room for the response to arrive.
    timeouts: { requestMs: 300_000, runMs: 310_000 },
    lifecycle: {
        state: z.strictObject({
            creditsCharged: z.number().nonnegative().optional(),
        }),
        start: async ({ utils }) => {
            const response = await utils.request();
            const raw = response.headers["x-credits-charged"];
            const parsed = raw !== undefined && /^\d+$/.test(raw.trim())
                ? Number(raw)
                : undefined;
            const creditsCharged =
                parsed !== undefined && Number.isSafeInteger(parsed)
                    ? parsed
                    : undefined;
            return {
                kind: "COMPLETED",
                httpStatus: response.status,
                output: response.body,
                ...(creditsCharged !== undefined
                    ? { state: { data: { creditsCharged } } }
                    : {}),
            };
        },
    },
    usage: {
        credits: {
            default: {
                label: "cloro credits",
                description: "the organization's credit balance; each " +
                    "successful request draws base + sync surcharge + add-ons",
            },
        },
        consolidate: ({ data, utils }) => {
            const creditsCharged = utils.json.optionalGet(
                data.lifecycle?.state ?? null,
                "$.data.creditsCharged",
            );
            return {
                credits: {
                    ...(typeof creditsCharged === "number"
                        ? { default: creditsCharged }
                        : {}),
                },
            };
        },
    },
    output: {
        /** cloro errors are non-2xx `{ error: { code, message, details?,
         *  timestamp } }` bodies. The raw body rides under `raw`. */
        fromError: ({ data, utils }) => {
            const message = utils.json.optionalGet(
                data.output,
                "$.error.message",
            );
            const code = utils.json.optionalGet(data.output, "$.error.code");
            return {
                message: typeof message === "string" && message !== ""
                    ? message
                    : "cloro API error",
                ...(typeof code === "string" ? { code } : {}),
                raw: data.output,
            };
        },
    },
});
