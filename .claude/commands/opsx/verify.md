---
name: "OPSX: Verify"
description: "Verify implementation matches change artifacts before archiving"
allowed-tools: Bash(openspec:*)
category: "Workflow"
tags: ["workflow", "verify", "experimental"]
---

Verify that an implementation matches the change artifacts (specs, tasks, design).

Read and follow the [openspec-verify-change workflow](../../skills/openspec-verify-change/SKILL.md) from this project's `.claude/skills/` directory in the current conversation. Treat this slash command as an explicit OpenSpec request.

Use the optional change name supplied after `/opsx:verify`.

Arguments: $ARGUMENTS
