import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import type { Json } from "@shared/core";
import {
    estimateEndpoint,
    liveSkip,
    loadFixture,
    runEndpoint,
    testBundle,
    testSealedUnit,
} from "@shared/testing";

/**
 * THE cloro async suite. Two shared chains drive every `cloro#async/*`
 * endpoint: `{{request.url}}` binds the submit (`/v1/async/task`) and the
 * status url (`/v1/async/task/T1`), which are the same for all seven.
 */

const chain = (name: string) =>
    fromFileUrl(new URL(`./fixtures/${name}.json`, import.meta.url));

/** Runs the completed chain, with the status body's claim replaced
 *  (`undefined` removes it). */
async function run(
    id: string,
    body: Record<string, Json>,
    creditsCharged: Json | undefined,
) {
    const fixture = await loadFixture(chain("synthetic-async-completed"));
    const last = fixture.calls[fixture.calls.length - 1].res.body as {
        credits: Record<string, Json>;
    };
    if (creditsCharged === undefined) delete last.credits.creditsCharged;
    else last.credits.creditsCharged = creditsCharged;
    return await runEndpoint({
        unit: await testSealedUnit(id),
        input: { body },
        mode: "replay",
        fixture,
    });
}

const CHATGPT = "cloro#async/chatgpt";
const CHATGPT_BODY = {
    prompt: "What is Example Corp?",
    country: "US",
    include: { shopping: true, ads: true },
    state: "CA",
};

Deno.test("cloro async: the status body's claim settles the bill", async () => {
    const result = await run(CHATGPT, CHATGPT_BODY, 9);
    assertEquals(result.httpStatus, 200);
    assertEquals(result.isProviderError, false);
    // 5 base + 2 raw data + 2 state; no sync surcharge
    assertEquals(result.usage, {
        credits: { default: 9 },
        evidence: { call: 1, raw_data: 1, state_targeting: 1 },
    });
    // submit, a 503 status lookup that stays RUNNING, PROCESSING, COMPLETED
    assertEquals(result.timing.attempts, 3);
    // the shape of the sync twin
    assertEquals(
        (result.output as { success: boolean }).success,
        true,
    );
    assertEquals(
        (result.output as { result: { text: string } }).result.text,
        "Example Corp makes project management software.",
    );
});

Deno.test("cloro async: a claim that differs from the card wins, the card rides as mismatch", async () => {
    const result = await run(CHATGPT, CHATGPT_BODY, 6);
    assertEquals(result.usage, {
        credits: { default: 6 },
        evidence: { call: 1, raw_data: 1, state_targeting: 1 },
        mismatch: { derived: { default: 9 } },
    });
});

Deno.test("cloro async: missing or malformed claims fall back to the card", async () => {
    for (const claim of [undefined, null, -1, 1.5, "9", 9007199254740992]) {
        const result = await run(CHATGPT, CHATGPT_BODY, claim);
        assertEquals(result.usage, {
            credits: { default: 9 },
            evidence: { call: 1, raw_data: 1, state_targeting: 1 },
        }, JSON.stringify(claim));
    }
});

Deno.test("cloro async: a FAILED task is a provider error, settled at zero", async () => {
    const result = await runEndpoint({
        unit: await testSealedUnit(CHATGPT),
        input: { body: { prompt: "p", country: "US" } },
        mode: "replay",
        fixture: await loadFixture(chain("synthetic-async-failed")),
    });
    assertEquals(result.httpStatus, 500);
    assertEquals(result.isProviderError, true);
    assertEquals(result.usage, { credits: {}, evidence: {} });
    assertEquals(result.output, {
        message: "Task failed after max retries",
        code: "INTERNAL_SERVER_ERROR",
        raw: {
            error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "Task failed after max retries",
            },
        },
    });
});

Deno.test("cloro async: a rejected submit is digested and settled at zero", async () => {
    const fixture = await loadFixture(chain("synthetic-unauthorized"));
    const result = await runEndpoint({
        unit: await testSealedUnit(CHATGPT),
        input: { body: { prompt: "p", country: "US" } },
        mode: "replay",
        fixture,
    });
    assertEquals(result.httpStatus, 401);
    assertEquals(result.isProviderError, true);
    assertEquals(result.usage, { credits: {}, evidence: {} });
    assertEquals(result.output, {
        message: "Invalid or expired API key",
        code: "INVALID_OR_EXPIRED_API_KEY",
        raw: fixture.calls[0].res.body,
    });
});

// The async card, per endpoint, with no claim: the sync card minus the
// 2-credit sync surcharge. https://cloro.dev/docs/guides/providers
const cards: {
    id: string;
    body: Record<string, Json>;
    credits: number;
    evidence: Record<string, number>;
}[] = [
    {
        id: CHATGPT,
        body: { prompt: "p", country: "US" },
        credits: 5,
        evidence: { call: 1 },
    },
    ...["gemini", "perplexity"].map((engine) => ({
        id: `cloro#async/${engine}`,
        body: { prompt: "p", country: "US", state: "NY" },
        credits: 6,
        evidence: { call: 1, state_targeting: 1 },
    })),
    {
        id: "cloro#async/copilot",
        body: { prompt: "p", country: "US" },
        credits: 5,
        evidence: { call: 1 },
    },
    {
        id: "cloro#async/google",
        body: {
            query: "q",
            country: "US",
            pages: 3,
            include: { aioverview: {} },
        },
        credits: 9,
        evidence: { call: 1, extra_page: 2, ai_overview: 1 },
    },
    {
        id: "cloro#async/google",
        body: { url: "https://www.google.com/search?q=laptops&num=30" },
        credits: 7,
        evidence: { call: 1, extra_page: 2 },
    },
    {
        id: "cloro#async/google/news",
        body: { query: "q", gl: "us", pages: 2 },
        credits: 5,
        evidence: { call: 1, extra_page: 1 },
    },
    {
        // productResults in the result are not charged without the flag
        id: "cloro#async/aimode",
        body: { prompt: "p", country: "US" },
        credits: 4,
        evidence: { call: 1 },
    },
    {
        // evidence reads result.productResults from the reshaped output
        id: "cloro#async/aimode",
        body: { prompt: "p", country: "US", include: { expandProducts: true } },
        credits: 7,
        evidence: { call: 1, expanded_product: 3 },
    },
];

for (const card of cards) {
    Deno.test(`cloro async card: ${card.id} ${JSON.stringify(card.body)}`, async () => {
        const result = await run(card.id, card.body, undefined);
        assertEquals(result.isProviderError, false);
        assertEquals(result.usage, {
            credits: { default: card.credits },
            evidence: card.evidence,
        });
    });
}

Deno.test("cloro async estimates: holds match the card before the run", async () => {
    const estimate = async (id: string, body: Record<string, Json>) =>
        (await estimateEndpoint(await testSealedUnit(id), { body })).credits;
    assertEquals(await estimate(CHATGPT, CHATGPT_BODY), { default: 9 });
    assertEquals(
        await estimate("cloro#async/google/news", { query: "q", gl: "us" }),
        { default: 3 },
    );
    // the hold covers cloro's documented maximum of 6 expanded clusters
    assertEquals(
        await estimate("cloro#async/aimode", {
            prompt: "p",
            country: "US",
            include: { expandProducts: true },
        }),
        { default: 10 },
    );
});

Deno.test("cloro async: the seven endpoints share one poll, the claim and the error digest", async () => {
    const bundle = await testBundle();
    const docs = Object.values(bundle.endpoints).filter((doc) =>
        doc.id.startsWith("cloro#async/")
    );
    assertEquals(docs.length, 7);
    const keys = (pick: (doc: typeof docs[number]) => unknown) =>
        new Set(docs.map(pick)).size;
    // byte-identical sources intern to one fnTable entry
    assertEquals(keys((doc) => doc.lifecycle?.poll?.$fn.key), 1);
    // start differs only in the taskType literal
    assertEquals(keys((doc) => doc.lifecycle?.start?.$fn.key), 7);
    // cloro cannot cancel one task
    assertEquals(keys((doc) => doc.lifecycle?.stop), 1);
    assertEquals(docs[0].lifecycle?.stop, undefined);
    // the provider's claim and error digest serve sync and async alike
    const all = Object.values(bundle.endpoints).filter((doc) =>
        doc.id.startsWith("cloro#")
    );
    assertEquals(
        new Set(all.map((doc) => doc.usage.consolidate?.$fn.key)).size,
        1,
    );
    assertEquals(
        new Set(all.map((doc) => doc.output?.fromError?.$fn.key)).size,
        1,
    );
});

Deno.test({
    name: "cloro#async/google live (gated on CLORO_API_KEY)",
    ignore: liveSkip("cloro"),
    fn: async () => {
        const unit = await testSealedUnit("cloro#async/google");
        const result = await runEndpoint({
            unit,
            input: {
                body: { query: "project management software", country: "US" },
            },
            mode: "live",
        });
        assertEquals(
            result.isProviderError,
            false,
            JSON.stringify(result.output),
        );
        assertEquals(result.usage.evidence, { call: 1 });
        assertEquals(typeof result.usage.credits.default, "number");
    },
});
