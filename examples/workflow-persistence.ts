import { resolve } from 'node:path'
import { z } from 'zod'
import { pipeline, workflow } from '@anureo/workflow'

// This example uses deterministic application callbacks; it makes no model requests.
const result = await workflow({
  name: 'square-numbers', revision: '1', directory: resolve('.anureo/workflows'),
  input: { numbers: [2, 3, 4] }, resumeFrom: process.argv[2],
}, async run => {
  console.log(`Run: ${run.runId}`)
  const values = await pipeline(run.input.numbers, number => run.step({
    key: `square:${number}`, input: { number },
    schema: z.strictObject({ value: z.number() }), recovery: 'repeatable',
  }, () => {
    console.log(`Executing square:${number}`)
    return { value: number * number }
  }))
  if (values.some(value => value === null)) throw new Error('A step did not complete')
  return values.map(value => value!.value)
})
console.log(JSON.stringify(result))
