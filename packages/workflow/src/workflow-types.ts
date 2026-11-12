export interface WorkflowOptions<Input> {
  name: string
  revision: string
  directory: string
  runId?: string
  input: Input
  resumeFrom?: string | { directory: string; runId: string }
}

export interface WorkflowContext<Input> {
  readonly runId: string
  readonly input: Input
}

export interface WorkflowResult<Result> {
  runId: string
  status: 'completed' | 'incomplete'
  result: Result
}
