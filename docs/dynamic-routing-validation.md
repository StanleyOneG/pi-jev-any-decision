# Dynamic routing validation

## Scope

Original dynamic routing was implemented against [the approved contract](dynamic-routing-spec.md), based on commit `54c470f`. The routing-efficiency update started from `043b7c4` and was verified offline only. Existing binary-policy comparison fixtures remain legacy evidence only; they are not demonstrations of the compact assessment API.

## Candidate-generation guidance update (HEAD 5d6b186 baseline)

The injected guidance and registered-tool metadata now direct the parent to discover roles before ruling out suitability, evaluate current user/project/loaded-skill permission within scope, and compare a bounded authorized implementation alternative at substantial transitions when available. The optional project standing-permission example is documentation only. Harness regressions assert both instruction surfaces, local `no_comparison` for small direct-only work, and an actual mocked service comparison for a bounded implementation option. Offline checks: `npm test` (66/66), `npm run typecheck`, `git diff --check`. These offline checks used no live inference or child launches. An implementation worker made the change; that development run is not behavioral validation of the new guidance. Instruction tests do not prove future agent compliance or measured savings.

## Routing-efficiency offline checks

Regression-first component evidence: policy/typesafe focused tests initially failed on missing schema/exports, then passed 17/17; runtime/gate focused tests initially failed on four new cases (advice reuse, direct-only roles/output, expiry reminder and gate request preservation), then passed 40/40. Both component workers ran `npm test` and `npm run typecheck` successfully; after runtime integration the suite passed 63/63. These mocked/offline tests cover compact and expanded direct inputs, invalid explicit values, no-alternative rationale, no-comparison filtering versus unresolved transfer, benign prose versus credentials, role snapshot replacement/clearing, stale results, accepted-advice reuse across replies with its original growth baseline, one-shot model-visible expiry reminder, compact content with complete details and existing trust/concurrency/debug behavior. They do **not** demonstrate live host reminder delivery or economic savings.

Independent review found a privacy regression: the narrowed secret guard accepted colon/equal-labeled bearer credentials. Parent added regression coverage across prose, identifier and rationale fields, observed two focused test failures, then restored rejection before either the SDK client or debug sink is invoked. Final parent checks passed: `npm test` (64/64), `npm run typecheck`, offline `scripts/probe-routing.ts` preview without `--live`, and `git diff --check`. No new live API experiment was run.

## Original dynamic-routing offline checks (historical)

The original workflow ran `npm run typecheck` and `npm test`: 46 tests passed, no failures. The tests cover dynamic options, context-risk exclusion, unknown transfer safety, relative-cost provenance, English/privacy guards, malformed SDK output, freshness-only enforcement, cache/session/cancellation behavior, one-clarification allowance and project-local debug logging.

Independent review identified and parent corrected:

- Obvious credential-shaped identifiers could bypass prose privacy checks. Identifier validation now applies the same secret guard, with tests proving rejection before client/debug invocation.
- A -> B -> A in-flight sharing could accept a stale-origin classification without consuming the clarification allowance. Only the current accepting waiter now consumes it atomically with recording/caching. A deferred-promise regression verifies the subsequent abstention becomes conservative fallback.
- Non-string SDK choices could pass property-key coercion. Explicit string validation and array/object regressions were added.

The incomplete Unicode script-block check was replaced with printable-ASCII validation for model-bound prose. This rejects non-ASCII text, but cannot prove that ASCII prose is semantically English or contains no concealed secrets.

## Bounded live smoke run (historical; not rerun for routing efficiency)

Before the routing-efficiency update, the parent executed `node --experimental-strip-types scripts/probe-routing.ts --live` once: **6 attempted TypeSafe calls out of the authorized maximum 12**, no retries, no child-execution benchmark. All fixtures were synthetic English descriptions. Five calls returned validated `jev-1.13.0` responses and matched the intended effective option. One call failed at approximately the configured five-second timeout and was not retried.

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

A sibling `dynamic-routing-live-probe.approval-used` marker prevents accidental reruns. No unused calls are automatically spent. These requests used the original expanded input/payload shape and are **not** live validation of compact direct input, local no-comparison, role caching, new cadence, or Pi reminder delivery. The smoke cases are developer-authored expectations, not an independent quality evaluation. Local exclusion can make an outcome inevitable; matching such an outcome does not establish model judgment quality. No economic improvement, calibration, repeatability or broad routing accuracy has been demonstrated.

## Remaining limits

- Model recommendations depend on the parent's summaries and estimates. The classifier does not independently see or verify the original conversation.
- Eligibility uses caller-supplied capability and authorization evidence; it does not replace actual host/subagent permission checks.
- Relative cost is project configuration, not pricing or measured all-agent cost.
- Unknown context transfer is handled conservatively; one clarification is allowed per actual user request across phases, not an inferred task boundary. If no unresolved transfer clarification remains and only direct is admissible, the offline-tested path skips Jev.
- Accepted advice can persist across ordinary replies, but the parent must detect meaningful goal/scope/permission changes and explicitly reassess; the extension cannot infer these from raw user text. Cached roles are evidence only, and the host/parent must enforce actual authorization.
- Compact model-facing content is distinct from full details/debug metadata. The host may store tool arguments, and syntactic English/secret guards cannot establish semantic privacy; the Pi `sendMessage` call shape was verified in a harness, not in a new live host session.
- Further cost/quality comparison and migration of legacy benchmarking require separate approval.
