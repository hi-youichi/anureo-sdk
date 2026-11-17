import { expect, test } from 'bun:test'
import { BeeProfileRegistry } from '../src/profiles'
import { profile } from './evolution-fixture'

test('registry retains same-ID origins and uses project, user, then legacy defaults', () => {
  const registry = new BeeProfileRegistry([
    { profile },
    { profile: { ...profile, instructions: 'User' }, source: { scope: 'user' } },
    { profile: { ...profile, instructions: 'Project' }, source: { scope: 'project' } },
    { profile: { ...profile, id: 'reviewer' }, source: { scope: 'user' } },
  ])
  expect(registry.entries).toHaveLength(4)
  expect(registry.resolve('tester')?.profile.instructions).toBe('Project')
  expect(registry.resolve('tester', 'user')?.profile.instructions).toBe('User')
  expect(registry.resolve('reviewer')?.source?.scope).toBe('user')
  expect(registry.resolve('reviewer', 'project')).toBeUndefined()
  expect(new BeeProfileRegistry([{ profile }]).resolve('tester')?.profile).toEqual(profile)
  expect(new BeeProfileRegistry([{ profile }]).resolve('tester', 'user')).toBeUndefined()
})

test('registry rejects duplicate origins and invalid source metadata', () => {
  expect(() => new BeeProfileRegistry([{ profile }, { profile }])).toThrow('Duplicate profile')
  expect(() => new BeeProfileRegistry([
    { profile, source: { scope: 'user', namespace: 'home-a' } },
    { profile, source: { scope: 'user', namespace: 'home-b' } },
  ])).toThrow('Duplicate profile')
  expect(() => new BeeProfileRegistry([{ profile, source: { scope: 'project', namespace: '' } }])).toThrow('namespace')
})
