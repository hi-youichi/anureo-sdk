/**
 * Journal scripted agent calls without model requests. Pass the printed run ID as the
 * first argument to rerun the body in a new run and reuse unchanged successful calls
 * without opening sessions. Storage is relative to the working directory; keep it for replay.
 */
import { resolve } from 'node:path'
import { createClient } from '@anureo/sdk'
import { createScriptedAdapter } from '@anureo/conformance'
import { z } from 'zod'
import { agent, pipeline, workflow } from '@anureo/workflow'

const schema = z.strictObject({ answer: z.string() })
const adapter = createScriptedAdapter()
const client = await createClient({ adapter, identity: { adapterId: 'scripted', runtimeConfigId: 'example' } })
try {
  const result = await workflow({
    name: 'agent-journal', revision: '1', directory: resolve('.anureo/workflows'),
    input: { questions: ['Map the modules.', 'List risky files.'] },
    resumeFrom: process.argv[2],
  }, /** Rerun on resume to match calls in order; fatal journal failures still reject workflow. */ async run => {
    console.log(`Run: ${run.runId}`)
    return pipeline(run.input.questions, /** Decode scripted answers; pipeline retains null slots for rejected or dropped stages. */ async question => {
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
