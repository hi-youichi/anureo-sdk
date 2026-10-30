import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

export interface NpmCommand { executable: string; args: [string] }
export interface NpmResolverOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  /** Tests can supply a trusted search inventory without editing system PATH. */
  searchDirectories?: readonly string[];
  nodeExecutable?: string;
}
function file(value: string): boolean { try { return statSync(value).isFile() } catch { return false } }
function executable(value: string, windows: boolean): boolean { try { accessSync(value,windows ? constants.F_OK : constants.X_OK); return statSync(value).isFile() } catch { return false } }
/** Resolve the package-manager JS entry rather than trying to execute npm.cmd with shell:false.
 * Only a PATH-selected installation, its known sibling layout, or npm's own npm_execpath is used.
 */
export function resolveNpmCommand(options: NpmResolverOptions = {}): NpmCommand {
  const platform=options.platform??process.platform,environment=options.environment??process.env,windows=platform==='win32'
  const directories=options.searchDirectories??(environment.PATH??environment.Path??'').split(windows?';':path.delimiter).filter(Boolean)
  const node=options.nodeExecutable??directories.map(dir=>path.join(dir,windows?'node.exe':'node')).find(candidate=>executable(candidate,windows))
  if(!node)throw new Error('A Node executable is required for npm packaging')
  const candidates:string[]=[]
  const npmExecPath=environment.npm_execpath
  if(npmExecPath&&path.basename(npmExecPath).toLowerCase()==='npm-cli.js')candidates.push(npmExecPath)
  for(const directory of directories)for(const name of windows?['npm.cmd','npm']:['npm']) {
    const selected=path.join(directory,name)
    if(!file(selected))continue
    const resolved=realpathSync(selected)
    if(path.basename(resolved).toLowerCase()==='npm-cli.js')candidates.push(resolved)
    // Official Windows Node installs npm.cmd beside node_modules/npm/bin/npm-cli.js.
    candidates.push(path.join(path.dirname(selected),'node_modules','npm','bin','npm-cli.js'))
    candidates.push(path.join(path.dirname(resolved),'node_modules','npm','bin','npm-cli.js'))
    candidates.push(path.join(path.dirname(selected),'..','lib','node_modules','npm','bin','npm-cli.js'))
  }
  candidates.push(path.join(path.dirname(node),'node_modules','npm','bin','npm-cli.js'))
  const cli=candidates.find(candidate=>file(candidate)&&path.basename(candidate).toLowerCase()==='npm-cli.js')
  if(!cli)throw new Error('Cannot resolve the npm installation JS entry; install Node with npm available on PATH')
  return {executable:realpathSync(node),args:[realpathSync(cli)]}
}
