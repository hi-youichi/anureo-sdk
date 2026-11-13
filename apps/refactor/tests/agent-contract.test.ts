// Verifies prompt compatibility and plan safety contracts; it must not dispatch agents or touch repositories.
import { expect, test } from 'bun:test'
import { validatePlan } from '../src/plan-validation'
import { designPrompt, modulePrompt, planPrompt } from '../src/prompts'
import { plan } from './helpers'

/** Compare both prompt APIs across modes and check lists so migrating callers cannot alter instructions. */
test.each([
  { readOnly: false, checks: [] },
  { readOnly: false, checks: ['bun test', 'bun run typecheck'] },
  { readOnly: true, checks: [] },
  { readOnly: true, checks: ['bun test', 'bun run typecheck'] },
])('named and positional prompts agree for readOnly=$readOnly checks=$checks', ({ readOnly, checks }) => {
  const files = plan.modules.flatMap(module => module.files)
  const module = plan.modules[0]!
  const context = { graphFile: 'graph.json', version: 'snapshot', checks, mode: readOnly ? 'read-only' as const : 'edit' as const }
  const prompts = [
    designPrompt({ ...context, files }),
    modulePrompt({ ...context, module, design: 'Reviewed boundaries' }),
  ]
  expect(prompts).toEqual([
    designPrompt(files, context.graphFile, context.version, checks, readOnly),
    modulePrompt(module, context.graphFile, context.version, checks, readOnly, 'Reviewed boundaries'),
  ])
  for (const prompt of prompts) {
    expect(prompt).toContain(readOnly ? 'MODE: READ ONLY' : 'MODE: EDIT')
    expect(prompt.includes('Validation commands:')).toBe(!readOnly && checks.length > 0)
    if (!readOnly && checks.length > 0) expect(prompt).toContain(`Validation commands: ${JSON.stringify(checks)}`)
  }
})

/** Both editing phases receive the same audience/language policy, even when only proposing changes. */
test.each(['read-only', 'edit'] as const)('documentation guidance reaches both phases in %s mode', mode => {
  const context = { graphFile: 'graph.json', version: 'snapshot', checks: [], mode }
  const prompts = [
    designPrompt({ ...context, files: ['api.ts', 'worker.py'] }),
    modulePrompt({ ...context, module: plan.modules[0]!, design: 'Reviewed boundaries' }),
  ]
  for (const prompt of prompts) {
    const documentation = prompt.replace(/\s+/g, ' ')
    expect(documentation).toContain('An exported declaration is not automatically a supported public API')
    expect(documentation).toContain('an extension interface can be public')
    expect(documentation).toContain('Lead public API comments with the consumer\'s task')
    expect(documentation).toContain('a short contract can be one sentence')
    expect(documentation).toContain('Select the documentation convention for each declaration from its language')
    expect(documentation).toContain('In mixed-language files')
    expect(documentation).toContain('Preserve the exact documentation dialect across phases and moved declarations')
    expect(documentation).toContain('Record identified conventions in the summary')
    expect(documentation).toContain('Examples are not a language allowlist')
    expect(documentation).toContain('For any other language or DSL')
    expect(documentation).toContain('ordinary native comments if no structured convention is established')
    expect(documentation).toContain('Documentation tags are convention-specific, not a universal @ syntax')
    expect(documentation).toContain('Do not transplant TSDoc tags or restrictions into another convention')
    expect(documentation).toContain('Go uses doc comments and prose')
    expect(documentation).toContain('docstrings with the project\'s Sphinx, Google or NumPy style')
    expect(documentation).toContain('C# uses XML documentation')
    expect(documentation).toContain('Do not infer support or release stage')
    expect(documentation).toContain('Verify these claims')
    expect(documentation).toContain('review comments against the final code')
    expect(documentation).toContain('Record documentation changes or proposals in "changes"')
    expect(documentation).toContain('concrete unresolved gaps in "deferred"')
    expect(documentation).toContain('Do not claim unavailable tooling was run')
    expect(documentation).toContain('Correct stale names, unsupported tags and misleading descriptions')
    expect(documentation).toContain('Type annotations, braces, delimiters and tag placement must follow that exact dialect')
    expect(documentation).toContain('Do not describe a returned failure as a thrown exception')
    expect(documentation).toContain('A parser pass alone does not establish semantic accuracy')
    expect(prompt.indexOf('Documentation conventions and tags:')).toBe(prompt.lastIndexOf('Documentation conventions and tags:'))
    if (mode === 'read-only') expect(prompt).toContain('apply this review to proposed comments without editing')
  }
})

/** Both phases prioritize actual API definitions while preserving executable declaration order. */
test.each(['read-only', 'edit'] as const)('declaration ordering reaches both phases in %s mode', mode => {
  const context = { graphFile: 'graph.json', version: 'snapshot', checks: [], mode }
  const prompts = [
    designPrompt({ ...context, files: ['api.ts'] }),
    modulePrompt({ ...context, module: plan.modules[0]!, design: 'Reviewed boundaries' }),
  ]
  for (const prompt of prompts) {
    const instructions = prompt.replace(/\s+/g, ' ')
    expect(instructions).toContain('Keep license/file comments and imports at the beginning')
    expect(instructions).toContain('exported types/interfaces, functions and classes before unexported implementation helpers')
    expect(instructions).toContain('move the actual declaration, not just its export statement')
    expect(instructions).toContain('constructor and public methods/accessors first')
    expect(instructions).toContain('Include implicitly public members and static public methods')
    expect(instructions).toContain('do not change visibility')
    expect(instructions).toContain('Preserve overload order')
    expect(instructions).toContain('field initialization order, static blocks, computed names and decorator evaluation')
    expect(instructions).toContain('report the concrete constraint in "deferred"')
    expect(instructions).toContain('do not skip safe ordering changes elsewhere')
    expect(prompt.indexOf('Declaration order:')).toBe(prompt.lastIndexOf('Declaration order:'))
    if (mode === 'read-only') expect(prompt).toContain('propose the reordering without editing files')
  }
  expect(prompts[0]).toContain('Apply declaration ordering to files affected by boundary changes')
  expect(prompts[1]).toContain('public class methods hidden below internal implementation helpers')
})

/** Boundary work preserves affected contracts; module work owns completion without forcing cosmetic churn. */
test('documentation scope is phase-specific and planning remains inventory-only', () => {
  const files = ['api.ts']
  const context = { graphFile: 'graph.json', version: 'snapshot', checks: [], mode: 'edit' as const }
  const design = designPrompt({ ...context, files })
  const module = modulePrompt({ ...context, module: plan.modules[0]!, design: 'Reviewed boundaries' })
  expect(design).toContain('preserve contract comments on moved declarations')
  expect(design).toContain('Do not perform a repository-wide comment rewrite')
  expect(design).not.toContain('Module documentation scope:')
  expect(module).toContain('including declarations\nwhose implementation stays unchanged')
  expect(module).toContain('keep accurate concise comments without cosmetic rewrites')
  expect(module).not.toContain('Design documentation scope:')
  expect(planPrompt(files, 'snapshot')).not.toContain('Documentation conventions and tags:')
})

/** Artifact IDs keep the existing alphabet and length boundaries, including legacy uppercase/underscore IDs. */
test.each(['a', 'A_0-module', 'a'.repeat(80)])('accepts safe module ID %s', id => {
  const candidate = { ...plan, modules: [{ ...plan.modules[0]!, id }] }
  expect(() => validatePlan(candidate, ['a.ts'])).not.toThrow()
})

/** Reject path components and out-of-policy IDs before their values can reach graph artifact filenames. */
test.each(['', '../escape', 'a/b', 'a\\b', '_module', '-module', 'a.b', 'a b', 'a'.repeat(81)])('rejects unsafe module ID %s', id => {
  const candidate = { ...plan, modules: [{ ...plan.modules[0]!, id }] }
  expect(() => validatePlan(candidate, ['a.ts'])).toThrow(`Invalid or duplicate module id: ${id}`)
})

/** Plans fail in traversal order, with omissions delayed until all explicit assignments are checked. */
test('plan validation preserves error precedence and inventory ordering', () => {
  const first = plan.modules[0]!
  const second = plan.modules[1]!
  expect(() => validatePlan({ ...plan, modules: [first, { ...second, id: first.id, files: ['extra.ts'] }] }, ['a.ts', 'b.ts']))
    .toThrow('Invalid or duplicate module id: a')
  expect(() => validatePlan({ ...plan, modules: [{ ...first, files: ['extra.ts'] }, { ...second, id: '../unsafe' }] }, ['a.ts', 'b.ts']))
    .toThrow('Unlisted or duplicate module file: extra.ts')
  expect(() => validatePlan({ ...plan, modules: [first, { ...second, files: ['a.ts'] }] }, ['a.ts', 'b.ts']))
    .toThrow('Unlisted or duplicate module file: a.ts')
  expect(() => validatePlan({ ...plan, modules: [first] }, ['c.ts', 'a.ts', 'b.ts']))
    .toThrow('Module plan omitted source files: c.ts, b.ts')
})
