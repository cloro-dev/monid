import { defineEndpoint, Unit, UsageModelKind } from "@shared/core";
import { z } from "zod";
import { zGoogleNewsBody } from "../google-news/schema/inputs.ts";

// cloro's documented default, applied at the binding (D25)
const zBody = zGoogleNewsBody.extend({
    pages: zGoogleNewsBody.shape.pages.unwrap().default(1),
});

/**
 * `POST /v1/async/task` with `taskType: GOOGLE_NEWS` — the async twin of
 * cloro#monitor/google/news. The protocol and the billing claim are
 * described in ../async-chatgpt/endpoint.ts.
 */
export default defineEndpoint({
    endpoint: "/async/google/news",
    meta: {
        displayName: "cloro Google News (async)",
        summary:
            "Scrape Google News results into structured articles for a query, in a chosen country, as a queued task.",
        description: "Run a Google News search as a real user in a chosen " +
            "country and device, and get the articles as structured JSON: " +
            "title, link, snippet, source, date and thumbnail. Up to 10 " +
            "pages per request. Use it to monitor press coverage of a " +
            "brand or topic. For the Google web SERP use " +
            "cloro#monitor/google.",
        docsUrl:
            "https://cloro.dev/docs/api-reference/endpoint/create-async-task",
        categories: ["news-search"],
        notes: [
            "Billing: 3 credits per request, " +
            "plus 2 credits per page after the first.",
        ],
    },
    request: { method: "POST", path: "/async/task" },
    input: {
        schema: {
            // cloro requires country or gl (anyOf, one required key per arm)
            body: z.union([
                zBody.required({ country: true }),
                zBody.required({ gl: true }),
            ]),
        },
    },
    // quick submit and status calls; the run budget covers queue time
    timeouts: { requestMs: 30_000, runMs: 1_800_000, pollMs: 5_000 },
    lifecycle: {
        start: async ({ data, utils }) => {
            // runId is stable across activity retries, so a retried submit
            // gets a 409 instead of a second charged task. cloro finds a
            // task by its id only, so the 409 is returned as an error.
            const response = await utils.request({
                body: {
                    taskType: "GOOGLE_NEWS",
                    payload: data.input.body,
                    idempotencyKey: data.run.runId,
                },
            });
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
                    description: "news result pages after the first",
                    consumes: { credit: "default", amount: 2 },
                },
            },
        },
        estimate: ({ data }) => {
            const pages = data.input.body.pages;
            return {
                counts: { ...(pages > 1 ? { extra_page: pages - 1 } : {}) },
            };
        },
        evidence: ({ data }) => {
            const pages = data.input.body.pages;
            return {
                counts: { ...(pages > 1 ? { extra_page: pages - 1 } : {}) },
            };
        },
    },
});
