import { resolve } from 'node:path'
import { createClient } from '@anureo/sdk'
import { createScriptedAdapter } from '@anureo/conformance'
import { z } from 'zod'
import { agent, pipeline, workflow } from '@anureo/workflow'

// This example uses a scripted backend; it makes no model requests. Each agent()
// call inside workflow() is journaled automatically: resuming with the printed
// run ID replays identical calls from the journal without opening new sessions.
const schema = z.strictObject({ answer: z.string() })
const adapter = createScriptedAdapter()
const client = await createClient({ adapter, identity: { adapterId: 'scripted', runtimeConfigId: 'example' } })
try {
  const result = await workflow({
    name: 'agent-journal', revision: '1', directory: resolve('.anureo/workflows'),
    input: { questions: ['Map the modules.', 'List risky files.'] },
    resumeFrom: process.argv[2],
  }, async run => {
    console.log(`Run: ${run.runId}`)
    return pipeline(run.input.questions, async question => {
      // The scripted backend echoes the prompt as its final message, so the
      // prompt text doubles as the schema-valid JSON answer.
      const prompt = JSON.stringify({ answer: `answered: ${question}` })
      const output = await agent(prompt, { client, cwd: process.cwd(), schema })
      return output === null ? null : output.answer
    })
  })
  console.log(JSON.stringify(result))
  console.log(`Sessions opened: ${adapter.opened.length}`)
} finally {
  await client.dispose()
}
