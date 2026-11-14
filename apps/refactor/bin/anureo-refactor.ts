#!/usr/bin/env bun
// Set the process exit code after the CLI has finished any client cleanup.
import { runCli } from '../src/cli'

process.exitCode = await runCli(process.argv.slice(2))
