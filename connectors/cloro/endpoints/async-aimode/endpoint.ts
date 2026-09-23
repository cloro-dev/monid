import { defineEndpoint, Unit, UsageModelKind } from "@shared/core";
import { z } from "zod";
import { zAimodeBody } from "../aimode/schema/inputs.ts";

/**
 * `POST /v1/async/task` with `taskType: AIMODE` — the async twin of
 * cloro#monitor/aimode. The protocol and the billing claim are described in
 * ../async-chatgpt/endpoint.ts.
 */
export default defineEndpoint({
    endpoint: "/async/aimode",
    meta: {
        displayName: "cloro Google AI Mode (async)",
        summary:
            "Get Google AI Mode's answer, cited sources and products for a prompt, in a chosen country, as a queued task.",
        description: "Run a prompt on Google AI Mode as a real user in a " +
            "chosen country, city or device, and get the answer as " +
            "structured JSON: the answer text, the cited sources, shopping " +
            "cards and inline products, and optionally the merchant offers " +
            "for up to 6 product clusters. Use it to see whether and how " +
            "Google's AI search mentions or cites a brand, a product or a " +
            "page. For the AI Overview on the classic SERP use " +
            "cloro#monitor/google.",
        docsUrl:
            "https://cloro.dev/docs/api-reference/endpoint/create-async-task",
        categories: ["ai-search", "geo"],
        notes: [
            "Billing: 4 credits per request, " +
            "plus 1 credit per product cluster returned when " +
            "expandProducts is on (at most 6).",
        ],
    },
    request: { method: "POST", path: "/async/task" },
    input: {
        schema: {
            // cloro requires country or gl. A union survives compilation
            // as anyOf (one required key per arm); a .refine would not.
            body: z.union([
                zAimodeBody.required({ country: true }),
                zAimodeBody.required({ gl: true }),
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
                    taskType: "AIMODE",
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
                    description: "4 base credits",
                    consumes: { credit: "default", amount: 4 },
                },
                expanded_product: {
                    kind: UsageModelKind.PER_UNIT,
                    unit: Unit.RESULT,
                    label: "expanded products",
                    description: "product clusters returned with merchant " +
                        "offers (expandProducts)",
                    consumes: { credit: "default", amount: 1 },
                },
            },
        },
        /** cloro expands at most 6 product clusters per scrape; the hold
         *  covers that documented maximum. */
        estimate: ({ data }) => ({
            counts: {
                ...(data.input.body.include?.expandProducts === true
                    ? { expanded_product: 6 }
                    : {}),
            },
        }),
        /** cloro charges the clusters in result.productResults, only when
         *  expandProducts was requested. */
        evidence: ({ data, utils }) => {
            const products = data.input.body.include?.expandProducts === true
                ? utils.json.optionalGet(data.output, "$.result.productResults")
                : undefined;
            const count = Array.isArray(products) ? products.length : 0;
            return {
                counts: { ...(count > 0 ? { expanded_product: count } : {}) },
            };
        },
    },
});
