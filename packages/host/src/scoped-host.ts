import { HarnessHost, type HostOptions, type Principal, type Role } from './host'
import { scopeParams, scopeResult } from './protocol'
import { rpcError, type HostConnection, type HostDispatcher } from './rpc'

export interface HostActor { userId: string }

export type HostAuthorizationPolicy = (actor: HostActor, scopeId: string, minimum: Role) => boolean | Promise<boolean>

export interface CreateHostOptions extends Omit<HostOptions, 'applicationAuthorization' | 'can' | 'projectRoot'> {
  authorize: HostAuthorizationPolicy
  resolveWorkspace: HostOptions['projectRoot']
}

export function createHarnessHost({ authorize, resolveWorkspace, ...options }: CreateHostOptions): HarnessHost {
  return new HarnessHost({ ...options, can: authorize, projectRoot: resolveWorkspace, applicationAuthorization: true })
}

/** Use the SDK scope-based protocol on a new endpoint. Cowork can keep its existing wire contract. */
export function createScopedHostDispatcher(host: HarnessHost): HostDispatcher<HostActor> {
  return {
    async handle(connection, request) {
      const scoped: HostConnection<Principal> = {
        ...connection,
        principal() {
          const actor = connection.principal()
          return actor ? { userId: actor.userId, mode: 'on' } : null
        },
        send(notification) { return connection.send({ ...notification, params: scopeResult(notification.params) }) },
      }
      let params: unknown
      try { params = scopeParams(request.params) }
      catch { return rpcError(request.id, -32602, 'Invalid params') }
      const response = await host.handle(scoped, { ...request, params })
      if ('error' in response) return response
      return { ...response, result: scopeResult(response.result, request.method) }
    },
    disconnect: id => host.disconnect(id),
  }
}
