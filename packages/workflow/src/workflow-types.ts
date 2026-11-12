import type { z } from 'zod'

export interface WorkflowOptions<Input> {
  name: string
  revision: string
  directory: string
  runId?: string
  input: Input
  resumeFrom?: string | { directory: string; runId: string }
}

export interface StepOptions<S extends z.ZodObject> {
  key: string
  input: unknown
  schema: S
  recovery?: 'manual' | 'repeatable'
  reuse?: (value: z.output<S>) => boolean | Promise<boolean>
}

export interface WorkflowContext<Input> {
  readonly runId: string
  readonly input: Input
  step<S extends z.ZodObject>(
    options: StepOptions<S>,
    execute: () => z.output<S> | null | Promise<z.output<S> | null>,
  ): Promise<z.output<S>>
}

export interface WorkflowResult<Result> {
  runId: string
  status: 'completed' | 'incomplete'
  result: Result
}
