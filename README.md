# Pi Jev delegation assessment

A Pi extension that compares bounded dynamic execution options for the main agent's next stage. It never launches children, changes child permissions, loads into children, compacts context, or overrides pi-subagents' authority.

## Use in another project

Requires Pi with project-trust support, tested with `@earendil-works/pi-coding-agent` 0.86.1, and a separately installed and enabled `pi-subagents` extension providing the `subagent` tool. Installing an npm dependency alone does not enable that tool.

Install pi-subagents once if you do not already use it:

```sh
pi install npm:pi-subagents
```

In the project where you want assessments, create `.pi/delegation-assessment.json` with:

```json
{
  "mode": "observe",
  "provisionalConfidenceThreshold": 0.7,
  "contextGrowthTokens": 16000
}
```

Then run from that project's directory:

```sh
export TYPESAFE_API_KEY=... # keep credentials outside the repository and chat
pi -e https://github.com/StanleyOneG/pi-jev-any-decision
```

`-e` loads the GitHub package for this run without saving it in settings. Pi installs its runtime dependencies automatically. Review the code before loading it, since extensions execute with full system access. Trust the target project when prompted. For a reviewed project in non-interactive mode, `--approve` grants trust for that run.

For persistent installation, choose one scope:

```sh
pi install https://github.com/StanleyOneG/pi-jev-any-decision    # all projects
pi install -l https://github.com/StanleyOneG/pi-jev-any-decision # current project
```

After installation, start `pi` normally. Use `pi update --extensions` to update installed packages. Append `@<tag-or-commit>` to the repository URL to pin a revision.

The package exports only the delegation-assessment extension, not this repository's development skills or pi-subagents. No build step or copy of the extension is needed. It injects its assessment instructions itself; copying this repository's `AGENTS.md` is unnecessary and does not grant permission to delegate.

Configuration always comes from `.pi/delegation-assessment.json` in the **target project's working directory**, never from the downloaded package. The extension is **off unless the trusted project has a valid explicit configuration**, even with `-e` or a global installation. Missing, untrusted, or malformed configuration is nonblocking `off`; it emits a Russian status warning. Use `rules-only` to avoid Jev API calls and the TypeSafe key requirement, or `off` to disable assessment. Start a new Pi session after changing configuration rather than reloading a live session.

## Repository-local debug log

To inspect TypeSafe requests, add `"debug": true` to the **target project's** `.pi/delegation-assessment.json`, preserving its other settings:

```json
{
  "mode": "observe",
  "debug": true
}
```

Start a new Pi session after changing configuration. Debug is off by default. The extension shows the log path at session start:

```text
<target-project-cwd>/.pi/delegation-assessment-debug/<pi-session-id>.jsonl
```

Logs belong to the working directory where Pi loads the project configuration, not to the installed extension. Start Pi at the repository root to store them there. A shell command targeting another repository does not move the session's log. Every row includes the absolute working directory, session ID and timestamp. Resuming the same session appends to its file; another session gets another file.

The JSONL records include:

- `assessment`: validated tool input, correlation IDs and source (`service`, `cache`, `in_flight`, `local`, or `rules`).
- `request`: the JSON body supplied to TypeSafe `systemOne`, including state and routing criteria. This records an attempted SDK call, not proof of delivery to the server.
- `response`: model, answers, usage and elapsed time, before local response validation.
- `service_error`: elapsed time and cancellation flag, without the potentially sensitive SDK error text.
- `result`: the effective local policy result; `discarded` marks stale assessments.

Cached/shared assessments do not generate a second service request. Direct-only or filtered-to-direct assessments with no unresolved transfer clarification are resolved locally (`local`), also without a TypeSafe call. `rules-only` records assessments/results without sending to TypeSafe; `off` and untrusted projects write no debug logs. Request rows are SDK-boundary body snapshots, not packet captures; HTTP headers and the API key are not recorded. SDK logging remains off.

The directory contains its own `.gitignore` with `*`, so logs are ignored in target repositories without editing their root ignore file. Log files use owner-only permissions. Symlinked diagnostic paths are rejected. Write failures warn once and do not change assessment behavior. No automatic retention or rotation is provided; delete old logs manually.

**Logs contain task summaries and role descriptions.** Secret checks are imperfect: do not place credentials or confidential raw data in tool arguments. Review logs before sharing them. Set `"debug": false` and start a new session to stop recording; existing files remain.

## Local development

```sh
npm ci
cp .pi/delegation-assessment.json.example .pi/delegation-assessment.json
npm test
npm run typecheck
```

Sources live in `src/delegation-assessment/`. The package manifest exports `src/delegation-assessment/index.ts`; this checkout has no local extension auto-discovery, so a globally installed copy can run here without a duplicate registration.

To test checkout changes, use `pi -e .` from this directory, or `pi -e /absolute/path/to/pi-jev-any-decision` from another project with its own opt-in configuration. Disable any installed copy with `pi config --local` before loading the checkout explicitly, since both copies register the same tools. Loading from GitHub with `pi -e https://github.com/StanleyOneG/pi-jev-any-decision` still uses the package manifest and needs no build step.

## Modes and main-agent contract

- `observe`: call Jev/rules and show Russian status, but never block a tool.
- `enforce`: require assessment before working tools.
- `rules-only`: use the deterministic policy and enforce exactly the same gate without a Jev call.
- `off`: baseline/no assessment.

Before the first working tool, discover compact roles with `subagent({action:"list", capabilities:true})` and call `delegation_assess`. Reassess for a **meaningful** new work phase, changed goal/scope/permissions/capabilities, or configured context growth—not for every shell result, acknowledgement, reply or idle continuation. After substantial research or code discovery, consider an authorized bounded delegated alternative when useful, or explain why none was offered. Discover roles again on capability change, not on every reply. Parent/host permissions remain authoritative: capability summaries, cached roles and a locally admissible direct baseline never authorize a child launch or other action.

Tool input includes an English `nextStep` (at most 2000 characters, without raw user text, source, logs or secrets), `phase` (`initial`, `transition`, `context_growth`), a fresh `phaseId` for a distinct transition, and 1–8 `options` including exactly one `direct`. `roles` may contain at most 12 capability summaries with purpose (`execution`, `research`, `review`), availability, suitability, authorization and tool IDs. Explicit `roles` replaces the last **accepted** snapshot, `[]` clears it, and omitted `roles` reuses it within the session. Missing referenced roles produce a repairable error. A successful new capability discovery invalidates that snapshot and advice; lifecycle reset, tree navigation and compaction clear both. Role evidence is caller-provided, not launch authority. Supply current permissions from the parent/host; do not assume a cached role retains permission to act.

A direct option requires only `id`, `kind: "direct"`, `summary`, `evidence` and `verificationCriteria`. Omitted direct authorization/suitability fields establish only the safe direct baseline (not an action permit); omitted comparison evidence is `unknown`. Expanded direct options remain accepted, but nonempty direct roles/tools and invalid explicit fields are rejected. Delegated options still require role names, tools, authorization, write conflict, suitability, context dependency, decisions recorded (`documents`, `conversation`, `both`, `unknown`), handoff effort/loss, verification and execution effort, rework risk, expected benefit and independent-review benefit. Qualitative levels are `low`, `moderate`, `high` or `unknown`; missing facts never become favorable.

When **no delegated option is supplied**, include `noDelegationReason: {code, detail}` with bounded ASCII English detail and code `trivial_continuation`, `no_authorized_delegate`, `no_suitable_delegate`, or `handoff_not_worthwhile`. This says why no alternative was offered, **not** that Jev rejected delegation. A submitted but excluded delegated option does not require this reason. A direct-only or filtered-to-direct comparison resolves locally without a model call unless unresolved context-transfer safety requires the existing one-clarification path. For example:

```json
{
  "phase": "initial",
  "phaseId": "minor_fix_1",
  "nextStep": "Correct the already located conditional and run the focused regression test.",
  "roles": [],
  "options": [{
    "id": "direct_fix",
    "kind": "direct",
    "summary": "The parent makes the bounded correction.",
    "evidence": "The condition and focused regression are already located.",
    "verificationCriteria": "Run the focused test and review the diff."
  }],
  "noDelegationReason": {
    "code": "handoff_not_worthwhile",
    "detail": "Preparing and reviewing a separate handoff exceeds the remaining work."
  }
}
```

For a later direct-only assessment in the same session, omit `roles` to reuse the accepted snapshot; `roles: []` explicitly clears it. When comparing delegation, include complete delegated safety/comparison fields and a matching role in the snapshot. Old `facts`/`selectedCandidate` boolean calls are unsupported and receive a migration error. No caller cost claim or attempt/revision flag is accepted. All visible submitted fields, including ignored expanded direct fields, are checked before service. The phase category is not identity. Assessment identity includes request, phase ID, context bucket, summary, normalized options, role capabilities, no-alternative reason and configured relative costs. Fresh user input makes pending work stale and starts a new request/clarification allowance, but preserves **accepted** advice with its original context-count baseline when still applicable; it does not reset growth by itself. An idle trigger alone also does not expire accepted advice. The parent must explicitly reassess before materially different work even when the runtime retains advice. Session replacement/fork/resume/reload, tree navigation, compaction, capability rediscovery, relevant model/budget changes, explicit phase assessment or measured context growth invalidate it as appropriate. Concurrent same-state calls deduplicate; stale responses cannot reopen a generation or overwrite newer roles. Unknown context metrics do not invent growth.

Only narrow read/control shapes (`list`, `status`, `doctor`, `guide`, `models`, `children.list`) and `bg_wait` bypass the gate. Mixed or unknown `subagent` input, including `resume` and `steer`, is a working launch. Launch attempt/confirmation is telemetry only: a failed/unconfirmed launch does not invalidate an otherwise fresh assessment or prevent ordinary work. The parent may choose differently from *any* fresh recommendation, without a mandatory launch or execution-plan validator. Record a concrete English reason using `delegation_deviate`; it is not required to unblock the gate. UI distinguishes Jev's choice, effective rule outcome, source (`jev`, `rules`, or service fallback), observation/enforcement mode, launch telemetry, and deviation. Persisted deviation diagnostic contains only bounded metadata (identity and reason length), not the reason.

## Parent context budget (smart zone)

The optional project settings below work with all active modes. Existing configurations keep working with a default 150,000-token budget:

```json
{
  "mode": "observe",
  "provisionalConfidenceThreshold": 0.7,
  "contextGrowthTokens": 16000,
  "smartZoneTokens": 150000,
  "smartZoneTokensByModel": {
    "example-provider/example-model": 120000
  }
}
```

Replace the example model key with the exact `provider/id` of the **parent** model, or omit the map. Budgets must be integers of at least 1,000 tokens. The effective budget is the smaller of the configured budget and the known model window; this is not an output-token reservation. The 150k default and the warning at 80% are configurable-budget heuristics, not calibrated quality thresholds or guarantees.

Each assessment tool result's **details** include `parentContext`: parent model identifier, window size, configured/effective budget, remaining tokens, state (`within`, `near`, `exceeded`, `unknown`), and explicitly unknown child context. Jev receives numeric/categorical telemetry without the parent model identifier; child model identifiers are not requested. Unknown usage/window/model values remain `null`; usage is approximate. Remaining budget floors at zero. Cached results describe the original assessment snapshot; model/window/budget/state changes participate in cache identity alongside the existing token bucket.

Monitoring before working tools and during assessment warns once on entering the near-budget or reached-budget state. Returning below 80% rearms warnings; a new session/reload resets warning deduplication. Near the budget, instructions favor fresh-context children and short reports **only when existing delegation prerequisites and operator permission hold**. At the budget, they suggest a manual session handoff or compaction. There is no automatic launch, compaction, mode switch, or new gate based on the budget. Already accumulated parent context is not removed by delegating. Child usage and future task growth are not measured or predicted.

This budget is separate from `contextGrowthTokens`, which expires accepted advice relative to its **original** assessment count, including across user replies. After large skill/reference reads that reach the threshold, the parent must reassess with `phase: "context_growth"` and a fresh `phaseId` before the next working tool, including a child launch. Observe warnings distinguish an absent assessment, an in-flight assessment, and growth expiry (with measured growth and threshold); none blocks the tool. On observed growth expiry the extension also queues one bounded English model-visible reminder per accepted assessment/expiry via Pi's custom `sendMessage` with `display: false`, `deliverAs: "steer"`, `triggerTurn: false`: no new turn or automatic launch. Read only necessary reference sections where applicable instructions allow it.

## Policy, service, and privacy limits

The model-facing result contains only effective recommendation, origin/reason and relevant revision/fallback action; `details`/opt-in debug retain full choice probabilities, context telemetry and exclusions. Only a genuine initiating service path sets `details.serviceCalled: true`; cache and shared in-flight waiters do not. When a comparison is needed, Jev receives one typed `Choice` among locally admissible option IDs, `insufficient_information`, and `revise_options`; it generates no plan or explanation. The TypeSafe call uses a 5-second timeout, `maxRetries: 0`, and Pi's cancellation signal. Runtime validation rejects malformed choices, missing/unknown probability keys, out-of-range values and distributions that do not sum to one. The two abstentions have different meanings: missing comparative information versus adequate descriptions but no acceptable option. First uncertainty invites clarification; after a second abstention or unresolved transfer safety the result is explicitly a conservative direct fallback. The runtime permits **one** clarification across the entire active user request, regardless of phase ID or category; later normal assessments remain possible. Fresh user input resets this allowance. In `rules-only`, unresolved safety is reported as a conservative direct fallback locally, with no Jev call or clarification loop.

Local eligibility excludes unauthorized, conflicting, unsuitable, unavailable or tool-deficient delegation and confirmed high-risk context-dependent transfer. Unknown transfer safety for context-dependent delegation requires clarification, never an assumed low risk. One admissible direct option alone is valid. Jev's semantic preference is advisory within this envelope; quality and preservation outrank cost. The confidence threshold is **uncalibrated**. Costs are project assumptions: absent defaults and overrides mean `unknown`, not a measured saving. Configure, for example, `"relativeCosts": {"defaultsByPurpose": {"execution": "similar", "review": "similar"}, "byRole": {"researcher": "higher"}}`; supported values are `lower`, `similar`, `higher`, `unknown`, with per-role overrides winning. No role-name or model-price inference occurs.

English and obvious-secret checks are practical guards, not a promise of perfect language or secret detection. Benign English such as "token budget" or "password handling" is allowed; recognizable key formats, bearer credentials, private-key headers and explicit secret label/value pairs are rejected. Direct role/tool/handoff boilerplate and redundant safety defaults are omitted from Jev payloads; relevant absent comparison evidence stays `unknown`. `noDelegationReason` is validated even for a local-only assessment and sent only if a service request is necessary. Do not put raw transcripts, code, logs, or credentials in a summary. By default the extension does not persist extra diagnostic copies of those inputs or model rationale. Opt-in debug logging persists assessment inputs and TypeSafe request/response bodies in the target project as described above. Pi may still persist tool-call arguments in its host session format, so the extension cannot promise that the host never stores them.

Service failure, low confidence, insufficient information, revise-options, or malformed service output use a visible conservative direct outcome as appropriate. Printable-ASCII and obvious-secret validation covers all model-bound text, including identifiers. Write descriptions in English with ASCII punctuation. Syntactic checks cannot prove semantic English for ASCII text or catch every secret. A true internal extension malfunction—including a UI failure—disables only this extension's gate for the rest of the session, with a best-effort warning; normal pi-subagents behavior continues. Normal invalid tool input remains a repairable tool error and does not disable the extension. A disabled extension makes no Jev calls. The disabled marker is owned by the current Pi session ID: it restores on startup, resume, and reload of that same session, but not into a new or forked session.

## Evaluation

`benchmarks/cases.json` and `npm run compare -- recording.json` are retained **legacy binary-policy** fixtures/tooling, not dynamic-routing validation. Do not interpret their `facts`, `delegate` choices or thresholds as this feature's API. Future all-agent comparison requires separate approval and fixture/script migration. See [dynamic routing validation](docs/dynamic-routing-validation.md) for current offline results and a **historical** bounded live smoke run (not rerun for the routing-efficiency change). These are not evidence of measured savings.

`node --experimental-strip-types scripts/probe-routing.ts` previews six synthetic English request bodies without inference. Adding `--live` sends those six requests, with no retries or children, and writes project-local debug evidence. A one-shot approval marker prevents accidental reruns; any further run requires a fresh budget decision. Set `TYPESAFE_API_KEY` outside the repository.
