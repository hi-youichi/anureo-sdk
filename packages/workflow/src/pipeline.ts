type Stages<Input, Outputs extends readonly unknown[]> = {
  [K in keyof Outputs]: (value: K extends '0' ? Input : Awaited<[Input, ...Outputs][K & keyof [Input, ...Outputs]]>) => Outputs[K]
}
type Last<Outputs extends readonly unknown[]> = Outputs extends readonly [...unknown[], infer Output] ? Awaited<Output> : never
type Stage<Input, Output> = (value: Input) => Output

/** Each item advances independently through every stage; results retain input order. */
export function pipeline<A, B>(items: readonly A[], first: Stage<A, B>): Promise<Awaited<B>[]>
export function pipeline<A, B, C>(
  items: readonly A[], first: Stage<A, B>, second: Stage<Awaited<B>, C>,
): Promise<Awaited<C>[]>
export function pipeline<A, B, C, D>(
  items: readonly A[], first: Stage<A, B>, second: Stage<Awaited<B>, C>,
  third: Stage<Awaited<C>, D>,
): Promise<Awaited<D>[]>
export function pipeline<A, B, C, D, E>(
  items: readonly A[], first: Stage<A, B>, second: Stage<Awaited<B>, C>,
  third: Stage<Awaited<C>, D>, fourth: Stage<Awaited<D>, E>,
): Promise<Awaited<E>[]>
export function pipeline<A, B, C, D, E, F>(
  items: readonly A[], first: Stage<A, B>, second: Stage<Awaited<B>, C>,
  third: Stage<Awaited<C>, D>, fourth: Stage<Awaited<D>, E>, fifth: Stage<Awaited<E>, F>,
): Promise<Awaited<F>[]>
export function pipeline<A, B, C, D, E, F, G>(
  items: readonly A[], first: Stage<A, B>, second: Stage<Awaited<B>, C>,
  third: Stage<Awaited<C>, D>, fourth: Stage<Awaited<D>, E>,
  fifth: Stage<Awaited<E>, F>, sixth: Stage<Awaited<F>, G>,
): Promise<Awaited<G>[]>
// Homomorphic tuple inference also supports arbitrary-length chains of typed functions.
export function pipeline<Input, Outputs extends readonly unknown[]>(
  items: readonly Input[],
  ...stages: Stages<Input, Outputs> & { 0: (value: Input) => unknown }
): Promise<Last<Outputs>[]>
export async function pipeline(items: readonly unknown[], ...stages: Array<(value: never) => unknown>): Promise<unknown[]> {
  if (!stages.length || stages.some(stage => typeof stage !== 'function')) throw new TypeError('pipeline requires at least one stage function')
  return await Promise.all(items.map(async item => {
    let value = item
    for (const stage of stages) value = await (stage as (value: unknown) => unknown)(value)
    return value
  }))
}
