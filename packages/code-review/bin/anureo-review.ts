#!/usr/bin/env bun
import { main } from '../src/cli.ts'
import { errorText } from '../src/io.ts'

await main(process.argv.slice(2)).catch(error => {
  console.error(errorText(error))
  if (!process.exitCode) process.exitCode = 1
})
