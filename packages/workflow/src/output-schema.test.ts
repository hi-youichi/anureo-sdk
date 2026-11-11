import { expect, test } from 'bun:test'
import { z } from 'zod'
import { validateJsonSchema } from '@anureo/protocol'
import { HarnessSdkError } from '@anureo/sdk'
import { compileOutputSchema } from '../../claude/src/output-schema'
import { prepareOutputSchema } from './output-schema'

const findings = z.strictObject({ issues: z.array(z.string()), state: z.enum(['ready', 'done']), note: z.string().nullable() })

test('one Zod schema generates compatible JSON Schema and validates typed results', async () => {
  const output = prepareOutputSchema(findings)
  const good: z.output<typeof findings> = { issues: ['one'], state: 'ready', note: null }
  const bad = { ...good, issues: [1] }
  expect(output.schema.$schema).toBeUndefined()
  expect(output.schema).toMatchObject({ type: 'object', required: ['issues', 'state', 'note'], additionalProperties: false })
  expect(validateJsonSchema(output.schema, good)).toBe(true)
  expect(validateJsonSchema(output.schema, bad)).toBe(false)
  const native = compileOutputSchema(output.schema)
  expect(native.validate(good)).toBe(true)
  expect(native.validate(bad)).toBe(false)
  expect(await output.parse(JSON.stringify(good))).toEqual(good)
})

test('nested unions and recursive local references retain positive and negative validation', async () => {
  const tree = z.object({
    name: z.string(),
    get children(): z.ZodArray<typeof tree> { return z.array(tree) },
    value: z.union([z.string(), z.number()]),
  })
  const output = prepareOutputSchema(tree)
  const good = { name: 'root', children: [{ name: 'child', children: [], value: 'ok' }], value: 1 }
  expect(compileOutputSchema(output.schema).validate(good)).toBe(true)
  expect(validateJsonSchema(output.schema, good)).toBe(true)
  expect(await output.parse(JSON.stringify(good))).toEqual(good)
  await expect(output.parse(JSON.stringify({ ...good, children: [{ ...good, name: 4 }] }))).rejects.toMatchObject({ code: 'AGENT_STRUCTURED_OUTPUT_INVALID' })
})

test.each([
  ['raw JSON Schema', { type: 'object', properties: {} }],
  ['null', null], ['boolean', true], ['array', []], ['string root', z.string()],
  ['array root', z.array(z.string())], ['root union', z.union([z.object({ a: z.string() }), z.object({ b: z.string() })])],
  ['optional', z.object({ a: z.string().optional() })],
  ['loose', z.looseObject({ a: z.string() })], ['record', z.object({ a: z.record(z.string(), z.string()) })],
  ['tuple', z.object({ a: z.tuple([z.string(), z.number()]) })],
  ['coercion', z.object({ a: z.coerce.number() })], ['transform', z.object({ a: z.string().transform(x => x.length) })],
  ['output pipe', z.object({ a: z.string().transform(x => x.length).pipe(z.number()) })],
  ['preprocess', z.object({ a: z.preprocess(x => x, z.string()) })],
  ['catch', z.object({ a: z.string().catch('fallback') })], ['prefault', z.object({ a: z.string().prefault('fallback') })],
  ['trim overwrite', z.object({ a: z.string().trim() })], ['date', z.object({ a: z.date() })],
  ['bigint', z.object({ a: z.bigint() })], ['map', z.object({ a: z.map(z.string(), z.string()) })],
  ['set', z.object({ a: z.set(z.string()) })], ['custom', z.object({ a: z.custom<string>() })],
  ['metadata cannot hide a date', z.object({ a: z.date().meta({ type: 'string' }) })],
  ['lazy transform', z.object({ a: z.lazy(() => z.coerce.string()) })],
])('rejects %s before execution', (_label, schema) => {
  expect(() => prepareOutputSchema(schema as z.ZodObject)).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS', outcomeUnknown: false }))
})

test('schema-like keys in business enum and default data are not treated as schema nodes', async () => {
  const schema = z.object({ value: z.enum(['object', 'array']), data: z.object({ type: z.literal('object'), $ref: z.literal('https://business') }).default({ type: 'object', $ref: 'https://business' }) })
  const value: z.output<typeof schema> = { value: 'object', data: { type: 'object', $ref: 'https://business' } }
  expect(await prepareOutputSchema(schema).parse(JSON.stringify(value))).toEqual(value)
})

test('raw JSON is validated before Zod can strip extra fields or supply defaults', async () => {
  const output = prepareOutputSchema(z.object({ count: z.number().default(3) }))
  expect(await output.parse('{"count":4}')).toEqual({ count: 4 })
  for (const text of ['{}', '{"count":4,"extra":1}', '{"count":"4"}', 'null', '[]']) {
    await expect(output.parse(text)).rejects.toMatchObject({ code: 'AGENT_STRUCTURED_OUTPUT_INVALID', retryable: false, outcomeUnknown: false })
  }
})

test('missing and malformed output remain distinct failures without recovering prose', async () => {
  const output = prepareOutputSchema(z.object({ count: z.number() }))
  await expect(output.parse('  ')).rejects.toMatchObject({ code: 'AGENT_STRUCTURED_OUTPUT_MISSING' })
  for (const text of ['not json', '```json\n{"count":1}\n```', '{"count":1}\n{"count":2}']) {
    await expect(output.parse(text)).rejects.toMatchObject({ code: 'AGENT_STRUCTURED_OUTPUT_NOT_JSON' })
  }
})

test('sync and async refinements and formats validate locally and sanitize custom diagnostics', async () => {
  const local = z.object({ count: z.number(), email: z.email() })
    .refine(value => value.count > 0, 'private-message')
    .superRefine(async (value, context) => { if (value.count > 10) context.addIssue({ code: 'custom', message: 'private-refinement' }) })
  const output = prepareOutputSchema(local)
  expect(await output.parse('{"count":3,"email":"me@example.com"}')).toEqual({ count: 3, email: 'me@example.com' })
  for (const count of [-1, 11]) {
    let failure: unknown
    try {
      await output.parse(JSON.stringify({ count, email: 'me@example.com' }))
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ code: 'AGENT_STRUCTURED_OUTPUT_INVALID', outcomeUnknown: false })
    expect(JSON.stringify(failure)).not.toContain('private-')
  }
  await expect(output.parse('{"count":1,"email":"bad"}')).rejects.toMatchObject({ code: 'AGENT_STRUCTURED_OUTPUT_INVALID' })
  const throwing = prepareOutputSchema(z.object({ a: z.string() }).refine(async () => { throw new Error('private exception') }))
  await expect(throwing.parse('{"a":"ok"}')).rejects.toMatchObject({ code: 'AGENT_STRUCTURED_OUTPUT_VALIDATION_FAILED' })
})

test('definite generated contradictions and external references are rejected', () => {
  for (const schema of [
    z.object({ a: z.string().meta({ minLength: 5, maxLength: 1 }) }),
    z.object({ a: z.number().meta({ minimum: 5, maximum: 1 }) }),
    z.object({ a: z.number().meta({ minimum: 1, exclusiveMaximum: 1 }) }),
    z.object({ a: z.array(z.string()).meta({ minItems: 3, maxItems: 1 }) }),
    z.object({ a: z.string().meta({ $ref: 'https://private.example/schema' }) }),
    z.object({ a: z.string() }).meta({ required: ['missing'] }),
    z.object({}).meta({ required: ['missing'], patternProperties: { '^allowed$': { type: 'string' } } }),
  ]) expect(() => prepareOutputSchema(schema)).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }))
  // Numeric bounds do not contradict a string instance.
  expect(prepareOutputSchema(z.object({ a: z.string().meta({ minimum: 5, maximum: 1 }) })).schema.type).toBe('object')
  expect(prepareOutputSchema(z.object({}).meta({ required: ['allowed'], patternProperties: { '^allowed$': { type: 'string' } } })).schema.type).toBe('object')
})

test('user schema callbacks cannot expose their exception or claim execution uncertainty before submission', () => {
  const schema = z.object({ a: z.lazy(() => { throw new HarnessSdkError('PRIVATE_NATIVE_ERROR', 'private value', true, true) }) })
  let failure: unknown
  try {
    prepareOutputSchema(schema)
  } catch (cause) {
    failure = cause
  }
  expect(failure).toMatchObject({ code: 'INVALID_PARAMS', retryable: false, outcomeUnknown: false })
  expect(String(failure)).not.toContain('private value')
})
