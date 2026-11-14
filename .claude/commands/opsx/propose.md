---
name: "OPSX: Propose"
description: "Propose a new change - create it and generate all artifacts in one step"
allowed-tools: Bash(openspec:*)
category: "Workflow"
tags: ["workflow", "artifacts", "experimental"]
---

Read [.claude/skills/openspec-propose/SKILL.md](../../skills/openspec-propose/SKILL.md) from the project root and follow its proposal workflow. This slash command is an explicit OpenSpec request.

Use the argument as a kebab-case change name or a description of what to build. If it is empty, ask the skill's open-ended discovery question.

$ARGUMENTS
