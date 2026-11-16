#!/usr/bin/env bun
// Passes process arguments to runCli and assigns its exit code; it must not parse input or own clients.
import { runCli } from '../src/cli'

// stdout must stay pure JSONL (see README): deflect stray adapter console debugging to stderr
// before any adapter module loads. Adapter diagnostics remain visible, just off the event stream.
console.log = console.error
console.info = console.error
console.debug = console.error

process.exitCode = await runCli(process.argv.slice(2))
