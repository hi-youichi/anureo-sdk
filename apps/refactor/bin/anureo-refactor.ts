#!/usr/bin/env bun
// Passes process arguments to runCli and assigns its exit code after cleanup; it must not parse input or own clients.
import { runCli } from '../src/cli'

process.exitCode = await runCli(process.argv.slice(2))
