---
name: agent-config-audit
description: Audit the FDE plugin, identities, MCP targeting, hooks and scripts for malformed manifests, embedded secrets, bypass flags and authority drift. Use after harness changes and before installing a plugin update.
allowed-tools: Read, Grep, Glob, Bash
---

# Agent configuration audit

Run the deterministic, read-only scanner before interpreting higher-level risk:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/audit_agent_config.py" \
  --plugin-root "${CLAUDE_PLUGIN_ROOT}" \
  --shared-root "${CLAUDE_SHARED:-$HOME/.claude-shared}"
```

Errors block installation. Warnings require inspection, especially agents with
read/write/shell authority. Then review trust boundaries that static scanning
cannot prove: connector target scopes, hook side effects, whether tools match an
agent's job, whether external content is treated as data, and whether a new
automation creates an unapproved external write. Do not silence a finding by
adding an exemption unless the line is a refusal/checker definition rather than
an executable bypass.
