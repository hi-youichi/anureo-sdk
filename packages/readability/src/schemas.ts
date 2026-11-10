import Ajv2020 from 'ajv/dist/2020.js'
import type { JsonSchema } from '@anureo/protocol'
import type { AnalysisDraft, RuleDraft, RuleReview } from './types'

const text = { type: 'string', minLength: 1 }
const texts = { type: 'array', items: text, uniqueItems: true }
const array = (items: JsonSchema, minItems = 0): JsonSchema => ({ type: 'array', items, minItems })
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
})
const location = object({ path: text, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 }, quote: text })
const observation = object({ evidence: array(location, 1), readingTask: text, obstacle: text,
  consequence: text, suggestion: text, invariants: texts })
const rule = object({ title: text, guidance: text, rationale: text,
  appliesWhen: { ...texts, minItems: 1 }, exceptions: texts,
  observationIds: { ...texts, minItems: 1 }, checkMethod: { type: 'string', enum: ['human', 'static', 'agent'] } })

export const analysisSchema = object({ reviewedFiles: texts,
  unreviewedFiles: array(object({ path: text, reason: text })), observations: array(observation) })
export const derivationSchema = object({ rules: array(rule) })
export const reviewSchema = object({ rule, verdict: { type: 'string', enum: ['supported', 'candidate', 'rejected'] },
  explanation: text, inspectedFiles: { ...texts, minItems: 1 }, counterexamples: array(location) })

/** Native structured-output schemas omit uniqueItems; host validation retains it. */
export function structuredOutputSchema(schema: JsonSchema): JsonSchema {
  if (typeof schema === 'boolean') return schema
  const output = structuredClone(schema)
  delete output.uniqueItems
  if (output.properties && typeof output.properties === 'object' && !Array.isArray(output.properties)) {
    output.properties = Object.fromEntries(Object.entries(output.properties).map(([name, property]) =>
      [name, structuredOutputSchema(property as JsonSchema)]))
  }
  if (output.items && typeof output.items === 'object' && !Array.isArray(output.items)) {
    output.items = structuredOutputSchema(output.items as JsonSchema)
  }
  return output
}

const ajv = new Ajv2020({ strict: false, allErrors: true })
function parser<T>(schema: JsonSchema): (value: unknown) => T {
  const validate = ajv.compile<T>(schema)
  return value => {
    if (!validate(value)) {
      const issues = validate.errors?.map(error => `${error.instancePath || '/'} ${error.message}`).join('; ')
      throw new Error(`Invalid agent output: ${issues}`)
    }
    return value
  }
}
export const parseAnalysis = parser<AnalysisDraft>(analysisSchema)
export const parseDerivation = parser<{ rules: RuleDraft[] }>(derivationSchema)
export const parseReview = parser<RuleReview>(reviewSchema)
