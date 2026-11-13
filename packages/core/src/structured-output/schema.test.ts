// Exercises schema dialect, definition and value contracts. Production admission and publication stay in the output session.
import { expect, test } from 'bun:test'
import { compileOutputSchema } from './schema'
import type { JsonSchema } from '@anureo/protocol'

test('schema compilation distinguishes invalid contracts from invalid values without converting them', () => {
  const output = compileOutputSchema({ type: 'object', properties: { n: { type: 'integer', default: 42 } }, required: ['n'], additionalProperties: false })
  expect(() => output.parse('{}')).toThrow('Output does not match its schema')
  expect(() => output.parse('{"n":"42"}')).toThrow()
  expect(() => output.parse('{"n":42,"extra":true}')).toThrow()
  expect(output.parse('{"n":42}')).toEqual({ n: 42 })
  const invalid: JsonSchema[] = [{ type: 'invalid' }, { $async: true }, { $ref: 'https://example.com/schema' }, { $schema: 'unsupported' }]
  for (const schema of invalid) expect(() => compileOutputSchema(schema)).toThrow('Unsupported or invalid output schema')
})

test('draft-07 and explicit 2020-12 use their own array semantics and ignore schema-like example data', () => {
  expect(compileOutputSchema({ type: 'object', examples: [{ $ref: 'https://example.com/data', $async: true }] }).parse('{}')).toEqual({})
  const tuple = compileOutputSchema({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'array', prefixItems: [{ type: 'integer' }], items: false })
  expect(tuple.parse('[42]')).toEqual([42])
  expect(() => tuple.parse('[42,43]')).toThrow()
  expect(compileOutputSchema(true).parse('null')).toBeNull()
  expect(compileOutputSchema({ type: 'boolean' }).parse('false')).toBe(false)
  expect(() => compileOutputSchema(false).parse('null')).toThrow()
})
