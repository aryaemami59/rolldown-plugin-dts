import path from 'node:path'
import process from 'node:process'
import {
  getTsconfig,
  readTsconfig,
  type TsconfigJson,
  type TsconfigJsonResolved,
} from 'get-tsconfig'
import { createDebug } from 'obug'
import { requireTS } from './tsc/load-tsc.ts'
import { getVueVolarPlugin } from './tsc/vue.ts'
import { isTS70Installed } from './tsgo.ts'
import { VolarContext, type VolarPlugin } from './volar.ts'
import type { invalidateContextFile } from './tsc/context.ts'
import type { IsolatedDeclarationsOptions } from 'rolldown/experimental'

const debug = createDebug('rolldown-plugin-dts:options')

/**
 * A minimal console-compatible logger the plugin uses to report messages.
 * Any object implementing this interface can be passed as
 * {@linkcode GeneralOptions.logger | logger}.
 */
export interface Logger {
  /**
   * Logs informational messages.
   */
  info: (...args: any[]) => void

  /**
   * Logs warning messages.
   */
  warn: (...args: any[]) => void

  /**
   * Logs error messages.
   */
  error: (...args: any[]) => void
}

//#region General Options
/**
 * Options that apply across all DTS generation modes (`oxc`, `tsc`, and
 * `tsgo`).
 */
export interface GeneralOptions {
  /**
   * The generator used to produce `.d.ts` files.
   *
   * - `'tsc'`: The TypeScript 5.x/6.x compiler. Supports all TypeScript features.
   * - `'oxc'`: {@link https://oxc.rs | Oxc}'s isolated declaration generator. Much faster than `tsc`, but only supports code that satisfies {@linkcode https://www.typescriptlang.org/tsconfig/#isolatedDeclarations | isolatedDeclarations}.
   * - `'tsgo'`: **[Experimental]** The TypeScript Go compiler ({@linkcode https://github.com/microsoft/typescript-go | tsgo}). May not support all TypeScript features yet.
   *
   * When unset, the generator is inferred (first match wins):
   * - `'oxc'` if {@linkcode Options.oxc | oxc} options are provided or {@linkcode https://www.typescriptlang.org/tsconfig/#isolatedDeclarations | isolatedDeclarations} is enabled in `compilerOptions`.
   * - `'tsgo'` if TypeScript 7.0 (or `@typescript/native-preview`) is installed, or if {@linkcode Options.tsgo | tsgo} options are provided.
   * - `'tsc'` otherwise, and always when {@linkcode TscOptions.vue | vue} or {@linkcode TscOptions.tsMacro | tsMacro} is enabled.
   *
   * @default 'tsc'
   */
  generator?: 'tsc' | 'oxc' | 'tsgo'

  /**
   * Glob pattern(s) to filter which files get `.d.ts` generation. When
   * specified, only files matching these patterns will emit `.d.ts` chunks
   * even if they are not Rolldown entry points. Patterns filter modules
   * already present in Rolldown's build graph (the `input` plus everything
   * it imports); they do not glob the filesystem to pull in new files. When
   * not specified, all entries get `.d.ts` generation. Supports negation
   * patterns (e.g., `['**', '!src/icons/**']`) for exclusion. Patterns are
   * matched against file paths relative to
   * {@linkcode GeneralOptions.cwd | cwd}.
   *
   * @example
   * <caption>Include a single entry file</caption>
   *
   * ```ts
   * import { defineConfig } from 'rolldown';
   * import { dts } from 'rolldown-plugin-dts';
   *
   * export default defineConfig({
   *   plugins: [
   *     dts({
   *       entry: 'src/index.ts',
   *     }),
   *   ],
   * });
   * ```
   *
   * @example
   * <caption>Include all `.ts` files in `src` except those in `src/internal`</caption>
   *
   * ```ts
   * import { defineConfig } from 'rolldown';
   * import { dts } from 'rolldown-plugin-dts';
   *
   * export default defineConfig({
   *   plugins: [
   *     dts({
   *       entry: ['src/*.ts', '!src/internal/‎**'],
   *     }),
   *   ],
   * });
   * ```
   */
  entry?: string | string[]

  /**
   * The directory in which the plugin will search for the
   * {@linkcode https://www.typescriptlang.org/docs/handbook/tsconfig-json.html | tsconfig.json}
   * file.
   *
   * @default process.cwd()
   */
  cwd?: string

  /**
   * Set to `true` if your entry files are `.d.ts` files instead of `.ts` files.
   * When enabled, the plugin will skip generating a `.d.ts` file for the
   * entry point.
   *
   * @default false
   */
  dtsInput?: boolean

  /**
   * If `true`, the plugin will emit only `.d.ts` files and remove all other
   * output chunks. This is especially useful when generating `.d.ts` files for
   * the CommonJS format as part of a separate build step.
   *
   * @default false
   */
  emitDtsOnly?: boolean

  /**
   * Configures TypeScript configuration file resolution and usage.
   * - **`true`**: The plugin walks up from {@linkcode GeneralOptions.cwd | cwd} via {@linkcode https://github.com/privatenumber/get-tsconfig | get-tsconfig} to locate the nearest {@linkcode https://www.typescriptlang.org/docs/handbook/tsconfig-json.html | tsconfig.json}. If none is found, no tsconfig is loaded.
   * - **`false`**: The plugin will ignore any {@linkcode https://www.typescriptlang.org/docs/handbook/tsconfig-json.html | tsconfig.json} file. You can still specify {@linkcode GeneralOptions.compilerOptions | compilerOptions} directly in the options.
   * - **`string`**: Path to a specific {@linkcode https://www.typescriptlang.org/docs/handbook/tsconfig-json.html | tsconfig.json} file to use. It can be an absolute path or a path relative to the {@linkcode GeneralOptions.cwd | cwd}.
   *
   * @default true
   */
  tsconfig?: string | boolean

  /**
   * Pass a raw {@linkcode https://www.typescriptlang.org/tsconfig | tsconfig}
   * object directly to the plugin.
   *
   * @default {}
   * @see {@link https://www.typescriptlang.org/tsconfig | TypeScript `tsconfig` documentation}
   */
  tsconfigRaw?: Omit<TsconfigJson, 'compilerOptions'>

  /**
   * Override the
   * {@linkcode https://www.typescriptlang.org/tsconfig/#compilerOptions | compilerOptions}
   * specified in
   * {@linkcode https://www.typescriptlang.org/docs/handbook/tsconfig-json.html | tsconfig.json}.
   *
   * @default {}
   * @see {@linkcode https://www.typescriptlang.org/tsconfig/#compilerOptions | compilerOptions}
   */
  compilerOptions?: TsconfigJson.CompilerOptions

  /**
   * If `true`, the plugin will generate declaration maps (`.d.ts.map`) for
   * `.d.ts` files. If this option is not specified, it will fall back to
   * the value of
   * {@linkcode https://www.typescriptlang.org/tsconfig#declarationMap | declarationMap}.
   *
   * @default false
   */
  sourcemap?: boolean

  /**
   * Specifies a resolver to resolve type definitions, especially for
   * `node_modules`.
   *
   * - `'oxc'`: Uses Oxc's module resolution, which is faster and more efficient.
   * - `'tsc'`: Uses TypeScript's native module resolution, which may be more compatible with complex setups, but slower.
   *
   * @default 'oxc'
   */
  resolver?: 'oxc' | 'tsc'

  /**
   * Determines how the `default` export is emitted. If set to `true`, and you
   * are only exporting a single item using
   * {@linkcode https://www.typescriptlang.org/docs/handbook/2/modules.html#es-module-syntax | export default},
   * the output will use
   * {@linkcode https://www.typescriptlang.org/docs/handbook/modules/reference.html#export--and-import--require | export =}
   * instead of the standard ES module syntax. This is useful for compatibility
   * with
   * {@link https://nodejs.org/api/modules.html#modules-commonjs-modules | CommonJS}.
   * This only controls the output format and does not enable support for
   * CommonJS-style `.d.ts` input.
   *
   * @default false
   *
   * @example
   * <caption>With `cjsDefault: true`</caption>
   *
   * ```ts
   * export default function foo(): void {}
   * ```
   *
   * will generate
   *
   * ```ts
   * declare function foo(): void;
   * export = foo;
   * ```
   */
  cjsDefault?: boolean

  /**
   * Indicates whether the generated `.d.ts` files have side effects.
   * - If set to `true`, Rolldown will treat the `.d.ts` files as having side effects during tree-shaking.
   * - If set to `false`, Rolldown may consider the `.d.ts` files as side-effect-free, potentially removing them if they are not imported.
   *
   * @default false
   */
  sideEffects?: boolean

  /**
   * The logger used by the plugin to report warnings and informational
   * messages. Any object implementing the {@linkcode Logger} interface is
   * accepted.
   *
   * @default globalThis.console
   */
  logger?: Logger
}

//#region tsc Options
/**
 * Options specific to TypeScript compiler (`tsc`) based DTS generation.
 * These options only take effect when both {@linkcode Options.oxc | oxc} and
 * {@linkcode Options.tsgo | tsgo} are disabled (i.e. the `tsc` generator is
 * used); other generators ignore them.
 */
export interface TscOptions {
  /**
   * Build mode for the TypeScript compiler:
   * - If `true`, the plugin will use {@linkcode https://www.typescriptlang.org/docs/handbook/project-references.html#build-mode-for-typescript | tsc -b} to build the project and all referenced projects before emitting `.d.ts` files.
   * - If `false`, the plugin will use {@linkcode https://www.typescriptlang.org/docs/handbook/compiler-options.html | tsc} to emit `.d.ts` files without building referenced projects.
   *
   * @default false
   */
  build?: boolean

  /**
   * If your
   * {@linkcode https://www.typescriptlang.org/docs/handbook/tsconfig-json.html | tsconfig.json}
   * has
   * {@linkcode https://www.typescriptlang.org/tsconfig/#references | references}
   * option, `rolldown-plugin-dts` will use
   * {@linkcode https://www.typescriptlang.org/docs/handbook/project-references.html#build-mode-for-typescript | tsc -b}
   * to build the project and all referenced projects before emitting `.d.ts`
   * files. In such case, if this option is `true`, `rolldown-plugin-dts` will
   * write down all built files into your disk, including
   * {@linkcode https://www.typescriptlang.org/tsconfig/#tsBuildInfoFile | .tsbuildinfo}
   * and other built files. This is equivalent to running
   * {@linkcode https://www.typescriptlang.org/docs/handbook/project-references.html#build-mode-for-typescript | tsc -b}
   * in your project. Otherwise, if this option is `false`,
   * `rolldown-plugin-dts` will write built files only into memory and leave a
   * small footprint in your disk. Enabling this option will decrease the build
   * time by caching previous build results. This is helpful when you have a
   * large project with multiple referenced projects. By default, this is
   * `true` if your
   * {@linkcode https://www.typescriptlang.org/docs/handbook/tsconfig-json.html | tsconfig.json}
   * has
   * {@linkcode https://www.typescriptlang.org/tsconfig/#incremental | incremental}
   * or
   * {@linkcode https://www.typescriptlang.org/tsconfig/#tsBuildInfoFile | tsBuildInfoFile}
   * enabled. This option is only used when both {@linkcode Options.oxc | oxc}
   * and {@linkcode Options.tsgo | tsgo} are `false`.
   *
   * @default false
   */
  incremental?: boolean

  /**
   * If `true`, the plugin will generate `.d.ts` files using
   * {@linkcode https://github.com/vuejs/language-tools/tree/HEAD/packages/tsc | vue-tsc}.
   *
   * @default false
   */
  vue?: boolean

  /**
   * If `true`, the plugin will launch a separate process for
   * {@linkcode https://www.typescriptlang.org/docs/handbook/compiler-options.html | tsc}
   * or
   * {@linkcode https://github.com/vuejs/language-tools/tree/HEAD/packages/tsc | vue-tsc}.
   * This enables processing multiple projects in parallel.
   *
   * @default false
   */
  parallel?: boolean

  /**
   * If `true`, the plugin will prepare all files listed in
   * {@linkcode https://www.typescriptlang.org/docs/handbook/tsconfig-json.html | tsconfig.json}
   * for
   * {@linkcode https://www.typescriptlang.org/docs/handbook/compiler-options.html | tsc}
   * or
   * {@linkcode https://github.com/vuejs/language-tools/tree/HEAD/packages/tsc | vue-tsc}.
   * This is especially useful when you have a single
   * {@linkcode https://www.typescriptlang.org/docs/handbook/tsconfig-json.html | tsconfig.json}
   * for multiple projects in a monorepo.
   *
   * @default false
   */
  eager?: boolean

  /**
   * If `true`, the plugin will create a new isolated context for each build,
   * ensuring that previously generated `.d.ts` code and caches are not reused.
   * By default, the plugin may reuse internal caches or incremental build
   * artifacts to speed up repeated builds. Enabling this option forces a clean
   * context, guaranteeing that all type definitions are generated from
   * scratch. Use {@linkcode invalidateContextFile} to selectively clear
   * individual files from the context rather than forcing a full rebuild on
   * every build.
   *
   * @default false
   *
   * @example
   * <caption>Invalidate a specific file in the context between builds</caption>
   *
   * ```ts
   * import {
   *   globalContext,
   *   invalidateContextFile,
   * } from 'rolldown-plugin-dts/tsc-context';
   *
   * invalidateContextFile(globalContext, 'src/foo.ts');
   * ```
   */
  newContext?: boolean

  /**
   * If `true`, the plugin will emit `.d.ts` files for `.js` files as well.
   * This is useful when you want to generate type definitions for JavaScript
   * files with JSDoc comments. When not specified, this option defaults to
   * `true` if either
   * {@linkcode https://www.typescriptlang.org/tsconfig/#checkJs | checkJs} or
   * {@linkcode https://www.typescriptlang.org/tsconfig/#allowJs | allowJs} is
   * enabled. This option is only used when {@linkcode Options.oxc | oxc} is
   * `false`.
   *
   * @default false
   */
  emitJs?: boolean
}

/**
 * The full configuration interface for the plugin. Combines
 * {@linkcode GeneralOptions} and {@linkcode TscOptions} and adds the
 * {@linkcode Options.oxc | oxc} and {@linkcode Options.tsgo | tsgo} options.
 */
export interface Options extends GeneralOptions, TscOptions {
  //#region Oxc

  /**
   * If `true`, the plugin will generate `.d.ts` files using Oxc,
   * which is significantly faster than the TypeScript compiler. This option is
   * automatically enabled when
   * {@linkcode https://www.typescriptlang.org/tsconfig#isolatedDeclarations | isolatedDeclarations}
   * is set to `true` and neither {@linkcode Options.vue | vue} nor
   * {@linkcode Options.tsMacro | tsMacro} is enabled.
   *
   * @default false
   */
  oxc?: boolean | Omit<IsolatedDeclarationsOptions, 'sourcemap'>

  //#region TypeScript Go

  /**
   * Enables DTS generation using
   * {@linkcode https://github.com/microsoft/typescript-go | tsgo}. This is
   * automatically enabled when the TypeScript Go compiler (v7+) is installed
   * as the `typescript` package. Otherwise, make sure
   * {@linkcode https://github.com/microsoft/typescript-go | @typescript/native-preview}
   * is installed as a dependency, or provide a custom path to the `tsgo`
   * binary using the {@linkcode TsgoOptions.path | path} option.
   *
   * **Note:** TypeScript 7.0 does not yet have a stable API and is
   * experimental. This option is not yet recommended for production
   * environments, and some options (such as
   * {@linkcode GeneralOptions.tsconfigRaw | tsconfigRaw} and
   * {@linkcode https://www.typescriptlang.org/tsconfig#isolatedDeclarations | isolatedDeclarations})
   * will be unavailable when it is enabled.
   *
   * @default false
   *
   * @example
   * <caption>Use `tsgo` from the `@typescript/native-preview` dependency</caption>
   *
   * ```ts
   * import { defineConfig } from 'rolldown';
   * import { dts } from 'rolldown-plugin-dts';
   *
   * export default defineConfig({
   *   plugins: [
   *     dts({
   *       tsgo: true,
   *     }),
   *   ],
   * });
   * ```
   *
   * @example
   * <caption>Use a custom `tsgo` path (e.g., managed by Nix)</caption>
   *
   * ```ts
   * import { defineConfig } from 'rolldown';
   * import { dts } from 'rolldown-plugin-dts';
   *
   * export default defineConfig({
   *   plugins: [
   *     dts({
   *       tsgo: { path: '/path/to/tsgo' },
   *     }),
   *   ],
   * });
   * ```
   *
   * @experimental
   */
  tsgo?: boolean | TsgoOptions

  /**
   * @experimental Maybe changed in future versions.
   */
  volarPlugin?: VolarPlugin
}

/**
 * Options for the `tsgo` binary used when
 * {@linkcode Options.tsgo | tsgo} is specified as an object rather than a
 * `boolean`.
 *
 * @experimental
 */
export interface TsgoOptions {
  /**
   * Custom path to the `tsgo` binary. If not specified, the plugin will
   * attempt to locate `tsgo` from the
   * {@linkcode https://github.com/microsoft/typescript-go | @typescript/native-preview}
   * dependency or system `PATH`.
   */
  path?: string
}

/**
 * Internal utility that creates a new object type combining {@linkcode T} and
 * {@linkcode U}, with {@linkcode U}'s properties taking precedence over
 * {@linkcode T}'s.
 *
 * @template T - The base object type.
 * @template U - The override object type whose keys shadow those in `T`.
 */
type Overwrite<T, U> = Pick<T, Exclude<keyof T, keyof U>> & U

/**
 * The fully resolved and normalized form of {@linkcode Options} with all
 * defaults applied. Returned by {@linkcode resolveOptions()}.
 */
export type OptionsResolved = Overwrite<
  Required<Omit<Options, 'compilerOptions' | 'vue' | 'volarPlugin'>>,
  {
    entry?: string[]
    tsconfig?: string
    oxc: IsolatedDeclarationsOptions
    tsconfigRaw: TsconfigJson
    tsgo: TsgoOptions
    volarContext?: VolarContext
  }
>

let warnedTsgo = false

/**
 * Resolves raw user-provided {@linkcode Options} into a fully normalized
 * {@linkcode OptionsResolved} object with all defaults applied and derived
 * values (e.g. `compilerOptions`, `oxc`, `sourcemap`) computed.
 *
 * @param userOptions - Raw user-provided plugin options to normalize.
 * @returns The resolved options ready for use by the plugin internals.
 * @throws An {@linkcode Error} if the resolved generator is `'tsc'` but the `typescript` package is not installed, if the `'tsgo'` generator is used without a tsconfig file, or if {@linkcode TscOptions.vue | vue} or {@linkcode TscOptions.tsMacro | tsMacro} is enabled while TypeScript 7.0 is installed.
 */
export function resolveOptions(userOptions: Options): OptionsResolved {
  let {
    generator,
    entry,
    cwd = process.cwd(),
    dtsInput = false,
    emitDtsOnly = false,
    tsconfig,
    tsconfigRaw: overriddenTsconfigRaw = {},
    compilerOptions = {},
    sourcemap,
    resolver = 'oxc',
    cjsDefault = false,
    sideEffects = false,
    logger = console,
    volarPlugin,

    // tsc
    build = false,
    incremental = false,
    vue = false,
    parallel = false,
    eager = false,
    newContext = false,
    emitJs,

    oxc,
    tsgo,
  } = userOptions

  let resolvedTsconfig: TsconfigJsonResolved | undefined
  if (tsconfig === true || tsconfig == null) {
    const { config, path } = getTsconfig(cwd) || {}
    tsconfig = path
    resolvedTsconfig = config
  } else if (typeof tsconfig === 'string') {
    tsconfig = path.resolve(cwd || process.cwd(), tsconfig)
    resolvedTsconfig = readTsconfig(tsconfig).config
  } else {
    tsconfig = undefined
  }

  compilerOptions = {
    ...resolvedTsconfig?.compilerOptions,
    ...compilerOptions,
  }

  incremental ||=
    compilerOptions.incremental || !!compilerOptions.tsBuildInfoFile
  sourcemap ??= !!compilerOptions.declarationMap
  compilerOptions.declarationMap = sourcemap

  const tsconfigRaw = {
    ...resolvedTsconfig,
    ...overriddenTsconfigRaw,
    compilerOptions,
  }

  if (vue) {
    if (volarPlugin) {
      throw new Error(
        'The `volarPlugin` option is already set. The `vue` option is not compatible with `volarPlugin`.',
      )
    }
    volarPlugin = getVueVolarPlugin()
  }

  // Volar relate
  if (volarPlugin) {
    if (isTS70Installed()) {
      throw new Error(
        'TypeScript 7.0 does not yet have a stable API and is experimental. The `vue` and `volarPlugins` options are not yet supported with TypeScript 7.0.',
      )
    }
    if (generator && generator !== 'tsc') {
      logger.warn(
        'The `vue` and `volarPlugins` options are enabled, which requires the `tsc` generator. The `generator` option is ignored.',
      )
    }
    generator = 'tsc'
  }

  const volarContext = volarPlugin && new VolarContext(volarPlugin)

  if (!generator) {
    if (tsgo) {
      generator = 'tsgo'
    } else if (oxc || compilerOptions?.isolatedDeclarations) {
      generator = 'oxc'
    } else if (isTS70Installed()) {
      generator = 'tsgo'
    } else {
      generator = 'tsc'
    }
  }

  if (generator === 'tsc') {
    requireTS(
      'Or enable `isolatedDeclarations` in your `tsconfig.json` to use Oxc instead.',
    )
  } else if (generator === 'tsgo') {
    if (!tsconfig) {
      throw new Error(
        'tsgo generator requires a tsconfig file to be specified.',
      )
    }
    if (!warnedTsgo) {
      warnedTsgo = true
      logger.warn(
        'TypeScript 7.0 does not yet have a stable API and is experimental. Some options will be unavailable.',
      )
    }
  }

  if (oxc === true || !oxc) oxc = {}
  if (oxc) {
    oxc.stripInternal ??= !!compilerOptions?.stripInternal
    // @ts-expect-error omitted in user options
    oxc.sourcemap = !!compilerOptions.declarationMap
  }
  if (tsgo === true || !tsgo) tsgo = {}

  emitJs ??= !!(compilerOptions.checkJs || compilerOptions.allowJs)

  const resolvedEntry = entry
    ? Array.isArray(entry)
      ? entry
      : [entry]
    : undefined

  const resolved = {
    generator,
    entry: resolvedEntry,
    cwd,
    dtsInput,
    emitDtsOnly,
    tsconfig,
    tsconfigRaw,
    sourcemap,
    resolver,
    cjsDefault,
    sideEffects,

    // tsc
    build,
    incremental,
    parallel,
    eager,
    newContext,
    emitJs,
    volarContext,

    oxc,
    tsgo,
    logger,
  }
  debug('Resolved Options: %O', resolved)

  return resolved
}
