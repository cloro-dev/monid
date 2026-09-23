import { defineEndpoint, Unit, UsageModelKind } from "@shared/core";
import { zChatgptBody } from "../chatgpt/schema/inputs.ts";

/**
 * `POST /v1/async/task` with `taskType: CHATGPT` — the async twin of
 * cloro#monitor/chatgpt.
 *
 * ASYNC (design D10/D21): the submit returns a task id, the task is polled
 * at `GET /v1/async/task/{id}` until it is COMPLETED or FAILED, and the
 * result rides the status body. The seven async endpoints share ONE
 * protocol, so `poll` is byte-identical across them and interns to one
 * fnTable entry. `start` differs only in the `taskType` literal. The
 * lifecycle lives on the endpoints, because a provider-level `start` is the
 * sync header relay of the monitor endpoints.
 *
 * There is no `stop`: cloro cannot cancel one task, only clear the whole
 * queue of the organization.
 *
 * BILLING. The same card as the sync twin without the 2-credit sync
 * surcharge. The vendor claim is `credits.creditsCharged` in the status
 * body; `poll` puts it in `state.data.creditsCharged`, where the provider
 * `usage.consolidate` reads it.
 */
export default defineEndpoint({
    endpoint: "/async/chatgpt",
    meta: {
        displayName: "cloro ChatGPT (async)",
        summary:
            "Get ChatGPT's answer, cited sources, shopping cards, entities and ads for a prompt, in a chosen country, as a queued task.",
        description: "Run a prompt on ChatGPT, as a real user in a chosen " +
            "country, with web search forced on, as a queued cloro task. " +
            "The result is the same structured JSON as " +
            "cloro#monitor/chatgpt: the answer text, the cited sources and " +
            "citation pills, brand entities, and optionally the query " +
            "fan-out, shopping cards and ads. It costs 2 credits less than " +
            "the sync endpoint and can wait in cloro's queue before it runs.",
        docsUrl:
            "https://cloro.dev/docs/api-reference/endpoint/create-async-task",
        categories: ["ai-search", "geo"],
        notes: [
            "Billing: 5 credits per request, plus 2 credits for the " +
            "raw-data add-on (any of rawResponse, searchQueries, ads, " +
            "shopping), plus 2 credits when state is set. A FAILED task " +
            "is not charged.",
        ],
    },
    request: { method: "POST", path: "/async/task" },
    input: { schema: { body: zChatgptBody } },
    // quick submit and status calls; the run budget covers queue time
    timeouts: { requestMs: 30_000, runMs: 1_800_000, pollMs: 5_000 },
    lifecycle: {
        start: async ({ data, utils }) => {
            // runId is stable across activity retries, so a retried submit
            // gets a 409 instead of a second charged task
            const response = await utils.request({
                body: {
                    taskType: "CHATGPT",
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
                    description: "5 base credits",
                    consumes: { credit: "default", amount: 5 },
                },
                raw_data: {
                    kind: UsageModelKind.PER_UNIT,
                    unit: Unit.RESULT,
                    label: "raw data",
                    description: "one shared add-on for rawResponse, " +
                        "searchQueries, ads and shopping",
                    consumes: { credit: "default", amount: 2 },
                },
                state_targeting: {
                    kind: UsageModelKind.PER_UNIT,
                    unit: Unit.RESULT,
                    label: "state targeting",
                    description: "US state geo-targeting (state is set)",
                    consumes: { credit: "default", amount: 2 },
                },
            },
        },
        estimate: ({ data }) => {
            const body = data.input.body;
            const include = body.include ?? {};
            const rawData = include.rawResponse === true ||
                include.searchQueries === true || include.ads === true ||
                include.shopping === true;
            return {
                counts: {
                    ...(rawData ? { raw_data: 1 } : {}),
                    ...(body.state !== undefined ? { state_targeting: 1 } : {}),
                },
            };
        },
        evidence: ({ data }) => {
            const body = data.input.body;
            const include = body.include ?? {};
            const rawData = include.rawResponse === true ||
                include.searchQueries === true || include.ads === true ||
                include.shopping === true;
            return {
                counts: {
                    ...(rawData ? { raw_data: 1 } : {}),
                    ...(body.state !== undefined ? { state_targeting: 1 } : {}),
                },
            };
        },
    },
});
