# Pi Jev delegation assessment

A project-local Pi extension that advises the main agent whether a compact next step merits delegation. It never launches children, changes child permissions, loads into children, compacts context, or overrides pi-subagents' authority.

## Setup

```sh
npm ci
export TYPESAFE_API_KEY=... # keep credentials outside the repository and chat
cp .pi/delegation-assessment.json.example .pi/delegation-assessment.json
npm test
npm run typecheck
```

Pi discovers `.pi/extensions/delegation-assessment/index.ts` only in a trusted project. The extension is **off unless the trusted project has a valid explicit `.pi/delegation-assessment.json`**. Missing, untrusted, or malformed configuration is nonblocking `off`; it emits a Russian status warning. Do not reload a live session just to change this configuration.

## Modes and main-agent contract

- `observe`: call Jev/rules and show Russian status, but never block a tool.
- `enforce`: require assessment before working tools.
- `rules-only`: use the deterministic policy and enforce exactly the same gate without a Jev call.
- `off`: baseline/no assessment.

Before first work and each explicit transition, the parent obtains compact roles with `subagent({action:"list", capabilities:true})`, then calls `delegation_assess` with:

- an English next-step summary (at most 2000 characters), without raw user text, source, logs, or secrets;
- phase category and a fresh caller-generated `phaseId` for each distinct transition;
- bounded policy facts and up to 12 compact role capability summaries;
- an explicit `selectedCandidate` with suitability evidence.

The phase category is not identity. Assessment freshness includes request, generation, phase ID, context bucket, summary, every fact, complete role summaries, and selected-candidate evidence. A new user input (including extension-sent input), an idle trigger-only run, session replacement/fork/resume, `/tree` navigation, explicit phase assessment, or approximate configurable context growth invalidates a permit. Normal continuations within an active agent run retain their request. Concurrent same-state calls deduplicate; late results cannot open a new generation. Unknown context metrics do not invent growth.

Only narrow read/control shapes (`list`, `status`, `doctor`, `guide`, `models`, `children.list`) and `bg_wait` bypass the gate. Mixed or unknown `subagent` input, including `resume` and `steer`, is a working launch. A recommended delegation may make that launch itself; follow-on work waits for a correlated, structured launch confirmation. A non-error arbitrary tool result or structured failure is not confirmation. A failed/unconfirmed launch requires a fresh role roster and assessment.

A `delegate` recommendation can instead be declined only with `delegation_refuse` and a nonblank concrete English reason attached to that exact current recommendation. UI states distinguish Jev's original choice, effective rule outcome, source (`jev`, `rules`, or service fallback), observation/enforcement mode, launch attempt/confirmation, and refusal. The stored refusal diagnostic contains only bounded metadata (identity and reason length), not the reason.

## Policy, service, and privacy limits

Jev receives one typed `Choice` (`delegate`, `direct`, `insufficient_information`) and no generated explanation. The TypeSafe call uses a 5-second per-attempt timeout, `maxRetries: 0`, and Pi's cancellation signal. Runtime validation rejects malformed choices, non-numeric/string probabilities, out-of-range values, and distributions that do not sum to one.

The deterministic policy is an intentional hard prerequisite, not a claimed security boundary: delegate only a bounded/verifiable step with an explicitly suitable available role, no need for most parent context, no write conflict, and large research or independent work. Jev remains an advisory semantic preference within that envelope. The confidence threshold is **uncalibrated**.

English and obvious-secret checks are practical guards, not a promise of perfect language or secret detection. Do not put raw transcripts, code, logs, or credentials in a summary. The extension does not persist extra diagnostic copies of those inputs or model rationale. Pi may still persist tool-call arguments in its host session format, so the extension cannot promise that the host never stores them.

Service failure, low confidence, insufficient information, or malformed service output use deterministic fallback and remain visible. A true internal extension malfunction—including a UI failure—disables only this extension's gate for the rest of the session, with a best-effort warning; normal pi-subagents behavior continues. Normal invalid tool input remains a repairable tool error and does not disable the extension. A disabled extension makes no Jev calls. The disabled marker is owned by the current Pi session ID: it restores on startup, resume, and reload of that same session, but not into a new or forked session.

## Evaluation

Use `benchmarks/protocol.md` and `npm run compare -- recording.json`. Frozen cases tune policy; holdouts remain separate. Record real parent context plus **all-agent** cost/time and independently reviewed quality for baseline, rules-only, and Jev runs. Missing evidence is missing, never zero/pass. This repository contains no paid-run result or claim of measured improvement.
