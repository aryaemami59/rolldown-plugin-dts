import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { styleText } from 'node:util'
import { createDebug } from 'obug'
import type { Logger } from './options.ts'

const require = createRequire(import.meta.url)
const debug = createDebug('rolldown-plugin-dts:tsgo')

export function isTS70Installed(): boolean {
  try {
    const { versionMajorMinor } = require('typescript')
    return versionMajorMinor === '7.0'
  } catch {}
  return false
}

/**
 * Promisified wrapper around {@linkcode spawn} that resolves when the child
 * process exits and rejects if the process emits an error.
 *
 * @param args - Arguments forwarded verbatim to {@linkcode spawn}.
 */
const spawnAsync = (...args: Parameters<typeof spawn>) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(...args)
    child.on('close', () => resolve())
    child.on('error', (error) => reject(error))
  })

let tsgoPathCache: string | undefined

/**
 * Resolves the path to the `tsgo` binary bundled inside the
 * {@linkcode https://github.com/microsoft/typescript-go | @typescript/native-preview}
 * package.
 *
 * @returns The absolute path to the `tsgo` executable.
 */
export async function getTsgoPathFromNodeModules(
  logger: Logger,
): Promise<string> {
  if (tsgoPathCache) return tsgoPathCache

  const pkgName = isTS70Installed()
    ? 'typescript'
    : '@typescript/native-preview'
  const tsgoPkg = import.meta.resolve(`${pkgName}/package.json`)
  const {
    default: { version },
  } = await import(tsgoPkg, { with: { type: 'json' } })
  logger.info(
    `Emit types with ${styleText('underline', `${pkgName}@${version}`)}`,
  )
  const { default: getExePath } = await import(
    new URL('lib/getExePath.js', tsgoPkg).href
  )
  return (tsgoPathCache = getExePath())
}

/**
 * A handle to the temporary directory that `tsgo` emitted declaration files
 * into, along with a cleanup function to remove it.
 */
export interface TsgoContext {
  /**
   * The absolute path to the temporary directory containing the emitted
   * `.d.ts` files.
   */
  path: string

  /**
   * Removes the temporary directory (unless debug logging is enabled, in which
   * case it is kept for inspection).
   */
  dispose: () => Promise<void>
}

/**
 * Runs `tsgo` to emit declaration files into a temporary directory and returns
 * that directory's path. The caller is responsible for cleaning it up.
 *
 * @param logger - A logger instance to log information about the `tsgo` execution.
 * @param rootDir - The project root passed to `tsgo` via `--rootDir`.
 * @param tsconfig - Optional path to a {@linkcode https://www.typescriptlang.org/docs/handbook/tsconfig-json.html | tsconfig.json} file passed via `-p`.
 * @param [sourcemap] - If `true`, passes `--declarationMap` to emit `.d.ts.map` files.
 * @param [tsgoPath] - Optional explicit path to the `tsgo` binary. Falls back to resolving from {@linkcode https://github.com/microsoft/typescript-go | @typescript/native-preview} in `node_modules`.
 * @returns The path to the temporary directory containing the emitted `.d.ts` files.
 */
export async function runTsgo(
  logger: Logger,
  rootDir: string,
  tsconfig: string,
  sourcemap?: boolean,
  tsgoPath?: string,
): Promise<TsgoContext> {
  debug('[tsgo] rootDir', rootDir)

  let tsgo: string
  if (tsgoPath) {
    tsgo = tsgoPath
    debug('[tsgo] using custom path', tsgo)
  } else {
    tsgo = await getTsgoPathFromNodeModules(logger)
    debug('[tsgo] using tsgo from node_modules', tsgo)
  }

  const tsgoDist = await mkdtemp(path.join(tmpdir(), 'rolldown-plugin-dts-'))
  debug('[tsgo] tsgoDist', tsgoDist)

  const args = [
    '--noEmit',
    'false',
    '--declaration',
    '--emitDeclarationOnly',
    '-p',
    tsconfig,
    '--outDir',
    tsgoDist,
    '--rootDir',
    rootDir,
    '--noCheck',
    ...(sourcemap ? ['--declarationMap'] : []),
  ]
  debug('[tsgo] args %o', args)

  await spawnAsync(tsgo, args, { stdio: 'inherit' })

  return {
    path: tsgoDist,
    async dispose() {
      if (debug.enabled) {
        debug('[tsgo] skip cleanup of tsgoDist', tsgoDist)
      } else {
        debug('[tsgo] disposing tsgoDist', tsgoDist)
        await rm(tsgoDist, { recursive: true, force: true }).catch(() => {})
      }
    },
  }
}
