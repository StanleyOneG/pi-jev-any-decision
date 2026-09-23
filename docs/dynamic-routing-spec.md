# Dynamic routing: agreed implementation contract

Status: implemented locally and validated; see [validation evidence](dynamic-routing-validation.md). Baseline: 54c470f on main. Existing repository-local debug logging is preserved.

## Product decisions

The parent constructs a bounded set of dynamic execution options for the next stage, not a closed menu of three workflows. An option may describe serial, parallel or mixed work, consultation, partial delegation, independent review, or direct work. Always include one direct baseline. Jev compares submitted admissible options, not all possible plans. It never generates plans or explanations and never launches tools or changes permissions.

Quality and preservation of important constraints outrank cost. Evaluate task suitability, context dependency, where decisions are recorded (documents/conversation/both/unknown), handoff effort, loss risk, verification criteria/effort, execution effort, likely rework and benefit of independent review. Use bounded English summaries and categorical values including unknown, not invented dollar estimates or probabilities. Unknown is not favorable evidence.

The parent may prefer direct work after substantial requirements discussion because decisions, rejected alternatives and exceptions are expensive or risky to transfer. A large parent context alone neither requires delegation nor predicts quality. Serial independent work can be handed off: independence is not parallelism. A candidate's lower cost alone never establishes suitability. Independent review may be worthwhile even at comparable cost when it adds a concrete quality benefit.

Use role capabilities and configurable relative costs (lower/similar/higher/unknown), not child model names or hardcoded model prices. No role-name-based cost inference. Project config may provide defaults by purpose (execution/research/review) and per-role overrides; absent settings mean unknown. Role purpose and suitability must be explicit. Cost profiles are user assumptions, not measured savings.

Local code excludes options violating permission, availability, suitability/tool requirements or unresolved write conflicts. Exclude delegation of context-dependent work with confirmed high handoff-loss risk. Unknown transfer safety must not be treated as low risk: allow one bounded clarification/revision; if unresolved use a conservative direct fallback. Delegating a genuinely context-independent subtask remains possible even when the parent holds other sensitive decisions.

Jev returns a submitted option ID, insufficient_information, or revise_options. The last two are fixed classifier outcomes, not explanations. Parent interpretation and deterministic exclusion reasons must be distinguished from Jev output. Insufficient information means descriptions do not support comparison; revise_options means descriptions suffice but none is acceptable. A valid single direct option after filtering is permitted without manufacturing a delegation alternative.

Runtime owns the revision allowance, not a caller-provided attempt flag. Integration clarification: one clarification allowance is shared across the entire actual user request, because caller-provided phase labels cannot establish genuine task boundaries. This caps clarification invitations, not ordinary successful assessments of later stages. Cache hits and concurrent shared requests must not consume extra attempts or start duplicate calls. A caller must not reset the budget merely by changing phaseId. After the second abstention/uncertainty, return an explicit conservative local fallback and permit ordinary work. New actual user input resets the logical request; session lifecycle is respected. No automatic repeated model calls.

Observe never blocks. Enforce and rules-only require a fresh assessment but must not force execution of the recommendation. Parent can record an English reason for choosing differently. Generalize the existing delegation_refuse behavior to any current recommendation, not only child launches. If helpful, tool instructions require recording a deviation; do not build a fake execution-plan validator from arbitrary shell calls. Existing host/subagent authority remains authoritative.

All natural-language fields submitted to TypeSafe must be English. Validate all model-bound fields (including role names/capabilities, option summaries, evidence and criteria) before the service call. Use bounded ASCII identifiers and enumerations; reject non-English-script text and obvious secrets with repairable field-specific errors, without sending it. Simple guards cannot prove semantic English for ASCII text; document this limitation. No translator model, transcripts, code dumps, raw user messages or credentials. Local paths/config keys not sent to the service need not be English. SDK request/response logs stay opt-in, repository-local, no headers/API keys.

Preserve trust gating, off/rules-only behavior, session isolation, generation safety, cached snapshot semantics, cancellation, service-fallback visibility and parent smart-zone telemetry. Existing project mode/budget/debug config stays valid. Old boolean tool-call shapes may receive a clear migration error; do not silently infer favorable facts from legacy input. Update injected instructions, descriptions, documentation and tests together.

## Validation and evidence

Offline tests: dynamic choice beyond three predefined workflows; grilling-context direct preference and high-risk exclusion; low-risk serial delegation allowed; independent review at comparable cost; unavailable/unsuitable/unauthorized/conflicting roles; unknown profiles and handoff facts; complete English/privacy validation; malformed distributions/unknown model choices; one-revision limit; concurrency/cache; stale completion/cancellation; enforce permits deviation; rules-only/off; debug regression.

At most 12 additional real TypeSafe calls are authorized for this feature, no automatic retry and no comparative child-execution benchmark. Parent owns this budget; children perform offline tests only. Use synthetic English scenarios, never private conversation. Capture count, request/response evidence, latency and observed versus intended outcomes. Report failures honestly; no claim of measured economic savings. Existing assessment calls for harness governance are distinct from the 12 experimental requests.

## Implementation ownership

Multi-seam change, sequential to avoid overlapping writes in this checkout.

| Stage | Owner | Exclusive files/contracts | Gate and handoff |
| --- | --- | --- | --- |
| Policy and adapter | worker, fresh | src/delegation-assessment/policy.ts, typesafe.ts; focused policy/typesafe tests; optional schema helper owned by this stage | Focused offline tests; durable API/schema handoff |
| Runtime integration | different worker, fresh, after first finishes | index.ts, gate.ts, new config/schema runtime helpers; runtime/gate tests; README/config examples; benchmark fixture migration if needed | Full tests/typecheck; durable integration handoff |
| Independent validation | reviewer, fresh, read-only after writers | Whole implementation against this contract | Concrete findings, no source edits |
| Acceptance and live probe | parent, after all writers stop | Integration fixes if needed, bounded live evidence and final acceptance | Full tests/typecheck and at most 12 live requests |

All stages use /workspaces/astraprojects/pi-jev-any-decision, branch main; no concurrent writers, no commit/push/publication, no nested subagents. Stop and ask on unapproved product decisions. The parent retains the negotiated requirements and final acceptance.
