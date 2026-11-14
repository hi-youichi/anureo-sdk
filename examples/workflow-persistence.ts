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
  /**
   * The pipeline invokes this stage for each question. The scripted adapter echoes the prompt,
   * so encode a schema-valid answer as that prompt. Return the answer or null on a drop.
   * Pipeline keeps a null slot on rejection, while workflow still observes fatal agent failures.
   */
  const answerQuestion = async (question: string) => {
    const prompt = JSON.stringify({ answer: `answered: ${question}` })
    const output = await agent(prompt, { client, cwd: process.cwd(), schema })
    return output === null ? null : output.answer
  }

  // Resume runs this body again so the journal can match each agent call in invocation order.
  const result = await workflow({
    name: 'agent-journal', revision: '1', directory: resolve('.anureo/workflows'),
    input: { questions: ['Map the modules.', 'List risky files.'] },
    resumeFrom: process.argv[2],
  }, async run => {
    console.log(`Run: ${run.runId}`)
    return pipeline(run.input.questions, answerQuestion)
  })
  console.log(JSON.stringify(result))
  console.log(`Sessions opened: ${adapter.opened.length}`)
} finally {
  await client.dispose()
}
