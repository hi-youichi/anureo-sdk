import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DesignReport } from '../src/review'

test('CLI resumes a killed run from an unrelated cwd and reuses committed tasks without a report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anureo-cli-recovery-'))
  try {
    const cwd = join(directory, 'subject')
    await mkdir(cwd)
    execFileSync('git', ['init', '--quiet'], { cwd })
    await writeFile(join(cwd, 'a.ts'), 'export const a = 1\n')
    await writeFile(join(cwd, 'b.ts'), 'export const b = 2\n')
    const entry = fileURLToPath(new URL('./fixtures/review-cli.ts', import.meta.url))
    const args = [process.execPath, entry, cwd, '--concurrency', '1', '--format', 'json',
      '--backend-config-digest', 'scripted-cli-v1']
    const first = Bun.spawn([...args, '--output', 'first'], { cwd: directory,
      env: { ...process.env, REVIEW_CRASH: '1', REVIEW_CALLS: join(directory, 'first-calls.jsonl'), REVIEW_OUTPUT: join(directory, 'first') },
      stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([first.exited,
      new Response(first.stdout).text(), new Response(first.stderr).text()])
    expect(code).not.toBe(0)
    expect(stdout).toBe('')
    expect(stderr).toContain('analysis-0 start')
    const committed = (await readdir(join(directory, 'first', 'checkpoints'))).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    expect(committed).toHaveLength(4) // planner plus three workers; ignore interrupted temp writes
    expect(await readdir(join(directory, 'first'))).not.toContain('report.json')
    const originalCalls = (await readFile(join(directory, 'first-calls.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { task: string; taskId?: string })
    const interruptedTask = originalCalls.filter(call => call.task === 'design-analysis').at(-1)!.taskId
    const sourceManifest = await readFile(join(directory, 'first', 'run.json'), 'utf8')
    const second = Bun.spawn([...args, '--resume', 'first', '--output', 'second'], { cwd: directory,
      env: { ...process.env, REVIEW_CRASH: '0', REVIEW_CALLS: join(directory, 'second-calls.jsonl') },
      stdout: 'pipe', stderr: 'pipe' })
    const [resumedCode, resumedOutput, resumedErrors] = await Promise.all([second.exited,
      new Response(second.stdout).text(), new Response(second.stderr).text()])
    expect(resumedCode).toBe(0)
    const report = JSON.parse(resumedOutput) as DesignReport
    expect(report.complete).toBe(true)
    expect(report.calls.reusedTasks).toBe(3)
    expect(report.tasks.every(task => task.status === 'completed')).toBe(true)
    expect(resumedErrors).toContain('Artifacts:')
    const calls = (await readFile(join(directory, 'second-calls.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { task: string; taskId?: string })
    expect(calls.filter(call => call.task === 'design-planning')).toHaveLength(0)
    expect(calls.filter(call => call.task === 'design-analysis')).toEqual([
      { task: 'design-analysis', taskId: interruptedTask },
    ])
    expect(await readFile(join(directory, 'first', 'run.json'), 'utf8')).toBe(sourceManifest)
    const manifest = JSON.parse(await readFile(join(directory, 'second', 'run.json'), 'utf8'))
    expect(manifest.identity.runId).toBe('second')
    expect(manifest.resumedFrom.runId).toBe('first')
    expect(manifest.status).toBe('completed')
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 15000)
