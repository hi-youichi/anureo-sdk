/**
 * Run each input through sequential stages, letting items advance independently without a stage barrier.
 * Stages receive the awaited previous value, the original unawaited input entry and its zero-based index.
 * An awaited null input or stage result skips the item's remaining stages; other falsy values continue.
 * Input rejections, stage throws and stage rejections also stop that item and produce null, without
 * cancelling siblings. Results retain input positions and resolve only after every item chain settles.
 * With no stages, return the awaited inputs with rejections as null. The input array is snapshotted;
 * non-array input rejects with TypeError. Empty input returns [] before stage validation; otherwise,
 * every stage is validated before processing items and an invalid stage rejects with TypeError.
 * Callers supply any concurrency limits, cancellation, retries and resource cleanup inside their stages.
 */
export function pipeline<Input>(items: readonly Input[]): Promise<(Awaited<Input> | null)[]>
export function pipeline<A, B>(items: readonly A[], first: Stage<A, A, B>): Promise<(Awaited<B> | null)[]>
export function pipeline<A, B, C>(
  items: readonly A[], first: Stage<A, A, B>, second: Stage<B, A, C>,
): Promise<(Awaited<C> | null)[]>
export function pipeline<A, B, C, D>(
  items: readonly A[], first: Stage<A, A, B>, second: Stage<B, A, C>,
  third: Stage<C, A, D>,
): Promise<(Awaited<D> | null)[]>
export function pipeline<A, B, C, D, E>(
  items: readonly A[], first: Stage<A, A, B>, second: Stage<B, A, C>,
  third: Stage<C, A, D>, fourth: Stage<D, A, E>,
): Promise<(Awaited<E> | null)[]>
export function pipeline<A, B, C, D, E, F>(
  items: readonly A[], first: Stage<A, A, B>, second: Stage<B, A, C>,
  third: Stage<C, A, D>, fourth: Stage<D, A, E>, fifth: Stage<E, A, F>,
): Promise<(Awaited<F> | null)[]>
export function pipeline<A, B, C, D, E, F, G>(
  items: readonly A[], first: Stage<A, A, B>, second: Stage<B, A, C>,
  third: Stage<C, A, D>, fourth: Stage<D, A, E>,
  fifth: Stage<E, A, F>, sixth: Stage<F, A, G>,
): Promise<(Awaited<G> | null)[]>
// Homomorphic tuple inference also supports arbitrary-length chains of typed functions.
export function pipeline<Input, Outputs extends readonly unknown[]>(
  items: readonly Input[],
  ...stages: Stages<Input, Outputs> & { 0: Stage<Input, Input, unknown> }
): Promise<(Last<Outputs> | null)[]>
export async function pipeline(items: readonly unknown[], ...stages: Array<(value: never, originalItem: never, index: number) => unknown>): Promise<unknown[]> {
  if (!Array.isArray(items)) throw new TypeError('pipeline expects an array as the first argument')
  const inputs = [...items]
  if (!inputs.length) return []
  if (stages.some(stage => typeof stage !== 'function')) throw new TypeError('pipeline stages must be functions')
  const results = await Promise.allSettled(inputs.map(async (originalItem, index) => {
    let value = await originalItem
    for (const stage of stages) {
      if (value === null) break
      value = await (stage as (value: unknown, originalItem: unknown, index: number) => unknown)(value, originalItem, index)
    }
    return value
  }))
  return results.map(result => result.status === 'fulfilled' ? result.value : null)
}

/** Align each stage with its predecessor's output by prepending the original input type. */
type PreviousStageOutput<Input, Outputs extends readonly unknown[], K> =
  K extends '0' ? Input : [Input, ...Outputs][K & keyof [Input, ...Outputs]]

/** Check each variadic stage against the preceding output while retaining the original input context. */
type Stages<Input, Outputs extends readonly unknown[]> = {
  [K in keyof Outputs]: Stage<PreviousStageOutput<Input, Outputs, K>, Input, Outputs[K]>
}
type Last<Outputs extends readonly unknown[]> = Outputs extends readonly [...unknown[], infer Output] ? Awaited<Output> : never

/** Exclude only null from a stage's awaited input because null short-circuits the item at runtime. */
type Stage<Previous, Input, Output> = (value: Exclude<Awaited<Previous>, null>, originalItem: Input, index: number) => Output
