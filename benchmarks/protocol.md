# Delegation-assessment comparison protocol

This repository contains no paid-run results. Run only with approved credentials and real Pi sessions.

1. Use the frozen cases in `cases.json` to tune only the rules and provisional threshold. Keep `holdouts` unseen until comparison.
2. Run each case in `baseline` (`off/baseline`), `rules-only`, and `jev` modes from comparable clean sessions.
3. For every case in both `frozen` and `holdouts`, record exactly one run for each `baseline`, `rules-only`, and `jev` mode. Each row needs its case id and exact `caseSet`, observed routing decision, nonnegative finite approximate parent context tokens, **all-agent** nonnegative finite total cost and elapsed time (including the parent and every child), a 0–1 independently reviewed quality score, and nonblank quality evidence. Missing cost/time/quality/decision stays missing; it is never recorded as zero or pass. An explicitly measured zero is valid and distinct from missing.
4. Run `npm run compare -- recording.json`. The script rejects incomplete, duplicate, unknown, misclassified, nonfinite, or out-of-range rows. It reports per-mode aggregate parent context, all-agent time, and all-agent cost; it also defines no-quality-regression as both rules-only and Jev scoring at least their paired baseline on every case. Jev's aggregate all-agent cost must be within the experimental 120% baseline budget. These are evaluation criteria, not per-call limiters.
5. Record service failures, fallbacks, aborted runs, and unavailable metrics separately. Do not claim an improvement without those recordings and independent review.

The threshold is explicitly **UNCALIBRATED** pending this benchmark.
