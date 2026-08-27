# @meterbility/github-copilot-adapter

Part of [Meterbility](https://github.com/HoneycombHairDevelopers/Meterbility) — the debugger for AI agents. Capture every run, inspect every decision, pause and inject live, fork from any step.

Ingests GitHub Copilot CLI sessions from `~/.copilot/session-state` (`events.jsonl`), falling back to the legacy `history-session-state` directory on older installs (`COPILOT_HOME` overrides `~/.copilot`), and carves multi-agent (squad) sessions into a parent run plus one child run per agent.

```bash
npm install @meterbility/github-copilot-adapter
```

See the [Meterbility documentation](https://github.com/HoneycombHairDevelopers/Meterbility#readme) for the full guide. MIT licensed.
