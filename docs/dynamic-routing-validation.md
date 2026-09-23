# Dynamic routing validation

## Scope

Implementation against [the approved contract](dynamic-routing-spec.md), based on commit `54c470f`. No commits or publication were performed by the implementation workflow. Existing binary-policy comparison fixtures remain legacy evidence only.

## Offline checks

Parent ran `npm run typecheck` and `npm test`: 46 tests passed, no failures. The tests cover dynamic options, context-risk exclusion, unknown transfer safety, relative-cost provenance, English/privacy guards, malformed SDK output, freshness-only enforcement, cache/session/cancellation behavior, one-clarification allowance and project-local debug logging.

Independent review identified and parent corrected:

- Obvious credential-shaped identifiers could bypass prose privacy checks. Identifier validation now applies the same secret guard, with tests proving rejection before client/debug invocation.
- A -> B -> A in-flight sharing could accept a stale-origin classification without consuming the clarification allowance. Only the current accepting waiter now consumes it atomically with recording/caching. A deferred-promise regression verifies the subsequent abstention becomes conservative fallback.
- Non-string SDK choices could pass property-key coercion. Explicit string validation and array/object regressions were added.

The incomplete Unicode script-block check was replaced with printable-ASCII validation for model-bound prose. This rejects non-ASCII text, but cannot prove that ASCII prose is semantically English or contains no concealed secrets.

## Bounded live smoke run

The parent executed `node --experimental-strip-types scripts/probe-routing.ts --live` once: **6 attempted TypeSafe calls out of the authorized maximum 12**, no retries, no child-execution benchmark. All fixtures were synthetic English descriptions. Five calls returned validated `jev-1.13.0` responses and matched the intended effective option. One call failed at approximately the configured five-second timeout and was not retried.

| Scenario | Expected effective option | Observed | Elapsed ms |
| --- | --- | --- | --- |
| Documented serial implementation | serial_implementation | serial_implementation | 428 |
| Decisions retained after requirements discussion | parent | parent; high-risk alternative excluded locally | 314 |
| Tiny coupled change | parent | parent | 318 |
| Independent security review at comparable cost | parent_plus_audit | parent_plus_audit | 331 |
| Unknown context-transfer safety | parent with clarification | Service error at timeout boundary; classification not obtained | 5010 |
| Four dynamic execution options | targeted_research | targeted_research | 425 |

The request/response evidence stays in the working repository, ignored by Git:

`.pi/delegation-assessment-debug/dynamic-routing-live-probe.jsonl`

A sibling `dynamic-routing-live-probe.approval-used` marker prevents accidental reruns. No unused calls are automatically spent. The smoke cases are developer-authored expectations, not an independent quality evaluation. Local exclusion can make an outcome inevitable; matching such an outcome does not establish model judgment quality. No economic improvement, calibration, repeatability or broad routing accuracy has been demonstrated.

## Remaining limits

- Model recommendations depend on the parent's summaries and estimates. The classifier does not independently see or verify the original conversation.
- Eligibility uses caller-supplied capability and authorization evidence; it does not replace actual host/subagent permission checks.
- Relative cost is project configuration, not pricing or measured all-agent cost.
- Unknown context transfer is handled conservatively; one clarification is allowed per actual user request across phases, not an inferred task boundary.
- Further cost/quality comparison and migration of legacy benchmarking require separate approval.
