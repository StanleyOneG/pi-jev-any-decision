## Agent skills

### Issue tracker

Issues are tracked in this repository’s GitHub Issues via `gh`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context domain documentation uses root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.

### Delegation assessment

For the current task, the main agent may initiate existing `subagent` delegation within its current tool and permission ceilings. Before the first working tool and at an explicit phase or approximate 16k-context-growth marker, call `delegation_assess` with an English bounded next-step summary, policy facts, and compact roles obtained from `subagent({ action: "list", capabilities: true })`. The extension advises only; the main remains executor and must not send raw user text, code, logs, or secrets to Jev.
