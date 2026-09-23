import { defineEndpoint, Unit, UsageModelKind } from "@shared/core";
import { z } from "zod";
import { zGoogleBody } from "../google/schema/inputs.ts";

/**
 * `POST /v1/async/task` with `taskType: GOOGLE` — the async twin of
 * cloro#monitor/google. The protocol and the billing claim are described in
 * ../async-chatgpt/endpoint.ts.
 */
export default defineEndpoint({
    endpoint: "/async/google",
    meta: {
        displayName: "cloro Google Search (async)",
        summary:
            "Scrape a Google search result page into structured JSON, with the AI Overview on request, as a queued task.",
        description: "Run a Google web search as a real user in a chosen " +
            "country, city or device, and get the result page as " +
            "structured JSON: organic results, sponsored ads, shopping " +
            "cards, People Also Ask, local pack, related searches, and " +
            "optionally the AI Overview with its cited sources. Send a " +
            "query with country (or gl), or a complete Google search URL. " +
            "Up to 10 pages per request. Use it for rank tracking and to " +
            "see which pages the AI Overview cites. For Google News use " +
            "cloro#monitor/google/news; for Google AI Mode use " +
            "cloro#monitor/aimode.",
        docsUrl:
            "https://cloro.dev/docs/api-reference/endpoint/create-async-task",
        categories: ["web-search", "seo", "geo"],
        notes: [
            "Billing: 3 credits per request, " +
            "plus 2 credits per page after the first, plus 2 credits for " +
            "the AI Overview add-on (aioverview or paaAioverview).",
        ],
    },
    request: { method: "POST", path: "/async/task" },
    input: {
        schema: {
            // cloro's three request shapes (anyOf, required keys per arm)
            body: z.union([
                zGoogleBody.required({ query: true, country: true }),
                zGoogleBody.required({ query: true, gl: true }),
                zGoogleBody.required({ url: true }),
            ]),
        },
    },
    // quick submit and status calls; the run budget covers queue time
    timeouts: { requestMs: 30_000, runMs: 1_800_000, pollMs: 5_000 },
    lifecycle: {
        start: async ({ data, utils }) => {
            // runId is stable across activity retries, so a retried submit
            // gets a 409 instead of a second charged task
            const response = await utils.request({
                body: {
                    taskType: "GOOGLE",
                    payload: data.input.body ?? {},
                    idempotencyKey: data.run.runId,
                },
            });
            if (
                response.status === 409 &&
                utils.json.optionalGet(
                        response.body,
                        "$.error.details.field",
                    ) ===
                    "idempotencyKey"
            ) {
                // an earlier attempt of this run created the task, and its
                // response was lost. cloro also finds a task by its
                // idempotencyKey, so the poll uses the run id.
                return {
                    kind: "RUNNING",
                    state: { externalRunId: data.run.runId },
                };
            }
            if (response.status < 200 || response.status >= 300) {
                return {
                    kind: "COMPLETED",
                    httpStatus: response.status,
                    output: response.body,
                };
            }
            const taskId = utils.json.optionalGet(response.body, "$.task.id");
            if (typeof taskId !== "string" || taskId === "") {
                throw new Error("cloro did not return a task id");
            }
            return { kind: "RUNNING", state: { externalRunId: taskId } };
        },
        poll: async ({ data, utils, logger }) => {
            const taskId = data.lifecycle.state.externalRunId;
            if (taskId === undefined) {
                throw Object.assign(
                    new Error("cloro poll without externalRunId in state"),
                    { retriable: false },
                );
            }
            const response = await utils.http({
                method: "GET",
                url: data.request.url + "/" + encodeURIComponent(taskId),
            });
            if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
                // the status LOOKUP failed, not the task, which keeps
                // running and will be charged: stay RUNNING, back off
                logger.warn("cloro task status lookup transient", {
                    taskId,
                    status: response.status,
                });
                return { kind: "RUNNING", pollAfterMs: 15_000 };
            }
            if (response.status < 200 || response.status >= 300) {
                return {
                    kind: "COMPLETED",
                    httpStatus: response.status,
                    output: response.body,
                };
            }
            const status = utils.json.optionalGet(
                response.body,
                "$.task.status",
            );
            if (status === "QUEUED" || status === "PROCESSING") {
                return { kind: "RUNNING" };
            }
            const result = utils.json.optionalGet(response.body, "$.response");
            if (status === "COMPLETED") {
                const credits = utils.json.optionalGet(
                    response.body,
                    "$.credits.creditsCharged",
                );
                return {
                    kind: "COMPLETED",
                    httpStatus: 200,
                    // the shape of the sync twin, so evidence fns and
                    // callers read one shape
                    output: utils.json.merge({ success: true }, {
                        result: result ?? null,
                    }),
                    state: {
                        externalRunId: taskId,
                        ...(typeof credits === "number" &&
                                Number.isSafeInteger(credits) && credits >= 0
                            ? { data: { creditsCharged: credits } }
                            : {}),
                    },
                };
            }
            // FAILED (charged 0 by cloro), or a status we do not know. The
            // status API answered 200, the task did not complete (D12).
            const message = utils.json.optionalGet(result ?? null, "$.error");
            logger.warn("cloro task did not complete", {
                taskId,
                status: String(status),
            });
            return {
                kind: "COMPLETED",
                httpStatus: 500,
                providerHttpStatus: 200,
                output: message !== undefined ? { error: message } : {
                    error: {
                        code: "TASK_" + String(status),
                        message: "cloro task " + String(status),
                    },
                },
            };
        },
    },
    usage: {
        model: {
            kind: UsageModelKind.COMPOSITE,
            components: {
                call: {
                    kind: UsageModelKind.PER_CALL,
                    label: "base fee",
                    description: "3 base credits; " +
                        "includes the first page",
                    consumes: { credit: "default", amount: 3 },
                },
                extra_page: {
                    kind: UsageModelKind.PER_UNIT,
                    unit: Unit.PAGE,
                    label: "extra pages",
                    description: "result pages after the first",
                    consumes: { credit: "default", amount: 2 },
                },
                ai_overview: {
                    kind: UsageModelKind.PER_UNIT,
                    unit: Unit.RESULT,
                    label: "AI Overview",
                    description: "AI Overview add-on (aioverview or " +
                        "paaAioverview)",
                    consumes: { credit: "default", amount: 2 },
                },
            },
        },
        /** The page count is `pages`, or, for a url request, the query
         *  string's `num` read as depth: ceil(num / 10), at most 10, where a
         *  missing or non-numeric num counts as 10 (one page). Both
         *  defaults are cloro's documented ones. */
        estimate: ({ data }) => {
            const body = data.input.body;
            const include = body.include ?? {};
            // URL is not a closed-term global: cut the fragment, then
            // read num from the query string only
            const match = typeof body.url === "string"
                ? /[?&]num=([^&]*)/.exec(body.url.split("#")[0])
                : null;
            const num = match !== null && /^\d+$/.test(match[1])
                ? Number(match[1])
                : 10;
            const pages = body.pages ??
                (num < 1 ? 1 : Math.min(Math.ceil(num / 10), 10));
            const aiOverview = include.aioverview !== undefined ||
                include.paaAioverview === true;
            return {
                counts: {
                    ...(pages > 1 ? { extra_page: pages - 1 } : {}),
                    ...(aiOverview ? { ai_overview: 1 } : {}),
                },
            };
        },
        evidence: ({ data }) => {
            const body = data.input.body;
            const include = body.include ?? {};
            // URL is not a closed-term global: cut the fragment, then
            // read num from the query string only
            const match = typeof body.url === "string"
                ? /[?&]num=([^&]*)/.exec(body.url.split("#")[0])
                : null;
            const num = match !== null && /^\d+$/.test(match[1])
                ? Number(match[1])
                : 10;
            const pages = body.pages ??
                (num < 1 ? 1 : Math.min(Math.ceil(num / 10), 10));
            const aiOverview = include.aioverview !== undefined ||
                include.paaAioverview === true;
            return {
                counts: {
                    ...(pages > 1 ? { extra_page: pages - 1 } : {}),
                    ...(aiOverview ? { ai_overview: 1 } : {}),
                },
            };
        },
    },
});
