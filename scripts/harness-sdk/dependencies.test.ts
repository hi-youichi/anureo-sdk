import { expect, test } from 'bun:test'
import { distributableDependencies } from './dependencies'

const versions = new Map([['@anureo/protocol', '0.2.0'], ['@anureo/sdk', '0.2.0']])

test('distribution pins workspace versions while preserving official dependencies', () => {
  expect(distributableDependencies({ '@anureo/protocol': 'workspace:*', ajv: '8.20.0' }, versions))
    .toEqual({ '@anureo/protocol': '0.2.0', ajv: '8.20.0' })
})

test('distribution rejects product packages, unknown workspaces and local dependencies', () => {
  const invalidDependencies: Array<Record<string, string>> = [
    { '@cowork/hx-contracts': '0.1.0' },
    { '@cowork/harness-sdk': 'workspace:*' },
    { '@anureo/host': '0.2.0' },
    { unknown: 'workspace:*' },
    { helper: 'file:../helper' },
    { helper: 'link:../helper' },
  ]
  for (const dependencies of invalidDependencies) expect(() => distributableDependencies(dependencies, versions)).toThrow()
})
