import assert from 'node:assert/strict'
import { createClient, type Client } from '@anureo/sdk'
import { createCodexAdapter } from '@anureo/adapter-codex'
import { agent, parallel, pipeline } from '@anureo/workflow'

/**
 * Double then square each input independently, then request both summaries concurrently.
 * Pipeline and parallel turn callback failures and dropped calls into null slots. Reject on
 * those slots, before requesting summaries if any input failed. The CLI awaits this function,
 * checks the numeric results and disposes the client.
 */
async function calculate(client: Client, inputs: readonly number[]) {
  const options = {
    client,
    cwd: process.cwd(),
    instructions: 'Perform only the requested arithmetic. Do not use tools. Return only the numeric result.',
  }
  /**
   * The pipeline stages and parallel callbacks use this to run a prompt in a fresh session.
   * Log its text or null after agent's cleanup. Agent rejections reach the invoking primitive
   * without an input/output log.
   */
  const ask = async (input: string) => {
    const output = await agent(input, options)
    console.log(JSON.stringify({ input, output }))
    return output
  }
  const results = await pipeline(
    inputs,
    value => ask(`double ${value}`),
    text => Number(text),
    value => ask(`square ${value}`),
    text => Number(text),
  )
  const squaredDoubles = results.map((value, index) => {
    if (value === null) throw new Error(`Calculation failed for input ${inputs[index]}`)
    return value
  })
  const summaryInput = squaredDoubles.join(',')
  const [sum, max] = await parallel([
    () => ask(`sum ${summaryInput}`),
    () => ask(`max ${summaryInput}`),
  ])
  if (sum === null || max === null) throw new Error('Summary calculation failed')
  return { squares: squaredDoubles, sum: Number(sum), max: Number(max) }
}

// Requires a configured, authenticated Codex CLI on PATH.
const client = await createClient({
  adapter: createCodexAdapter({ command: process.env.CODEX_BIN ?? 'codex' }),
  identity: { adapterId: 'codex', runtimeConfigId: 'workflow-example' },
})
try {
  const inputs = [2, 3, 4]
  const result = await calculate(client, inputs)
  assert.deepEqual(result, { squares: [16, 36, 64], sum: 116, max: 64 })
  console.log(JSON.stringify({ status: 'passed', backend: 'codex', inputs, result }))
} finally {
  await client.dispose()
}
