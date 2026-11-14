---
name: "OPSX: Sync"
description: "Sync delta specs from a change to main specs"
allowed-tools: Bash(openspec:*)
category: "Workflow"
tags: ["workflow", "specs", "experimental"]
---

Sync delta specs from a change to main specs.

Read and follow the [openspec-sync-specs workflow](../../skills/openspec-sync-specs/SKILL.md) from this project's `.claude/skills/` directory in the current conversation. Treat this slash command as an explicit OpenSpec request.

Use the optional change name supplied after `/opsx:sync`. Carry through any caller-supplied delta paths and specs-rule snapshot.

Arguments: $ARGUMENTS
