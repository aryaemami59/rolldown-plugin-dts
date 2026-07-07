import path from 'node:path'
import { createDebug } from 'obug'
import { globalContext } from './context.ts'
import { requireTS } from './load-tsc.ts'
import { createFsSystem } from './system.ts'
import { customTransformers, formatHost, setSourceMapRoot } from './utils.ts'
import type { tscEmitBuild } from './emit-build.ts'
import type { TscModule, TscOptions, TscResult } from './types.ts'
import type { ExistingRawSourceMap } from 'rolldown'
import type {
  CompilerHost,
  CompilerOptions,
  ParsedCommandLine,
  Program,
  ScriptTarget,
  SourceFile,
  System,
} from 'typescript'

const debug = createDebug('rolldown-plugin-dts:tsc-compiler')
const ts = requireTS()

/**
 * Default {@linkcode CompilerOptions | compilerOptions} applied to every
 * {@linkcode Program | program} created in compiler mode. These are merged
 * with - and overridden by - the user's `tsconfig` options, but ensure that
 * declaration-emit-specific flags are always set to safe values.
 */
const defaultCompilerOptions: CompilerOptions = {
  declaration: true,
  noEmit: false,
  emitDeclarationOnly: true,
  noEmitOnError: true,
  checkJs: false,
  declarationMap: false,
  skipLibCheck: true,
  target: 99 satisfies ScriptTarget.ESNext,
  resolveJsonModule: true,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
}

/**
 * Create or get a {@linkcode Program | program} for the given module. The
 * plugin will try to reuse existing programs in the context if they contain
 * the module, but if not, a new {@linkcode Program | program} will be created
 * for it.
 *
 * @param options - The options for creating or getting the {@linkcode Program | program}.
 * @returns A {@linkcode TscModule | module} containing the {@linkcode Program | program} and the {@linkcode SourceFile} for the module.
 */
function createOrGetTsModule(options: TscOptions): TscModule {
  const { id, entries, context = globalContext } = options
  const program = context.programs.find((program) => {
    const roots = program.getRootFileNames()
    if (entries) {
      return entries.every((entry) => roots.includes(entry))
    }
    return roots.includes(id)
  })
  if (program) {
    const sourceFile = program.getSourceFile(id)
    if (sourceFile) {
      return { program, file: sourceFile }
    }
  }

  debug(`create program for module: ${id}`)
  const module = createTsProgram(options)
  debug(`created program for module: ${id}`)

  context.programs.push(module.program)
  return module
}

/**
 * Create a {@linkcode Program | program} for the given module using the
 * TypeScript compiler API. This function parses the provided TypeScript
 * configuration and sets up the necessary
 * {@linkcode CompilerOptions | compilerOptions} and
 * {@linkcode CompilerHost | host} for the {@linkcode Program | program}.
 *
 * @param tscOptions - The options for creating the {@linkcode Program | program}, including the module ID, entries, and any relevant TypeScript configuration.
 * @returns A {@linkcode TscModule | module} containing the {@linkcode Program | program} and the {@linkcode SourceFile} for the module.
 */
function createTsProgram(tscOptions: TscOptions): TscModule {
  const {
    entries,
    id,
    tsconfig,
    tsconfigRaw,
    volarContext,
    cwd,
    context = globalContext,
  } = tscOptions

  const fsSystem = createFsSystem(context.files)
  const baseDir = tsconfig ? path.dirname(tsconfig) : cwd
  const parsedConfig = ts.parseJsonConfigFileContent(
    tsconfigRaw,
    fsSystem,
    baseDir,
    undefined,
    undefined,
    undefined,
    volarContext?.getExtraFileExtensions(),
  )

  debug(`creating program for root project: ${baseDir}`)
  return createTsProgramFromParsedConfig({
    parsedConfig,
    fsSystem,
    baseDir,
    id,
    entries,
    volarContext,
  })
}

/**
 * Create a {@linkcode Program | program} from the given parsed TypeScript
 * configuration. This function sets up the necessary
 * {@linkcode CompilerOptions | compilerOptions} and
 * {@linkcode CompilerHost | host} for the {@linkcode Program | program}.
 *
 * @param tscOptions - The options for creating the {@linkcode Program | program}, including the parsed TypeScript configuration, file system, base directory, and any relevant TypeScript features.
 * @returns A {@linkcode TscModule | module} containing the {@linkcode Program | program} and the {@linkcode SourceFile} for the module.
 * @throws An {@linkcode Error} if the source file cannot be found in the created {@linkcode Program | program}.
 */
function createTsProgramFromParsedConfig(
  tscOptions: {
    parsedConfig: ParsedCommandLine
    fsSystem: System
    baseDir: string
  } & Pick<TscOptions, 'entries' | 'volarContext' | 'id'>,
): TscModule {
  const { parsedConfig, fsSystem, baseDir, id, entries, volarContext } =
    tscOptions

  const compilerOptions: CompilerOptions = {
    ...defaultCompilerOptions,
    ...parsedConfig.options,
    $configRaw: parsedConfig.raw,
    $rootDir: baseDir,
    // Allow non-TS extensions (e.g. `.vue`) to be used as root files. Without
    // this, TypeScript silently drops root files whose extension is not in its
    // built-in supported list, so `program.getSourceFile(id)` returns
    // `undefined` for a `.vue` entry that is not imported by a `.ts` file.
    // Only relevant when a language plugin (Vue/Volar plugin) registers such
    // extensions; module resolution already handles the imported-file case.
    ...(volarContext ? { allowNonTsExtensions: true } : undefined),
  }

  const rootNames = [
    ...new Set(
      [id, ...(entries || parsedConfig.fileNames)].map((f) =>
        fsSystem.resolvePath(f),
      ),
    ),
  ]

  const host = ts.createCompilerHost(compilerOptions, true)
  const createProgram = volarContext
    ? volarContext.plugin.getCreateProgram(ts)
    : ts.createProgram
  const program = createProgram({
    rootNames,
    options: compilerOptions,
    host,
    projectReferences: parsedConfig.projectReferences,
  })

  const sourceFile = program.getSourceFile(id)

  if (!sourceFile) {
    debug(`source file not found in program: ${id}`)

    const hasReferences = !!parsedConfig.projectReferences?.length

    if (hasReferences) {
      throw new Error(
        `[rolldown-plugin-dts] Unable to load ${id}; You have "references" in your tsconfig file. Perhaps you want to add \`dts: { build: true }\` in your config?`,
      )
    }

    if (fsSystem.fileExists(id)) {
      debug(`File ${id} exists on disk.`)
      throw new Error(
        `Unable to load file ${id} from the program. This seems like a bug of rolldown-plugin-dts. Please report this issue to https://github.com/sxzz/rolldown-plugin-dts/issues`,
      )
    } else {
      debug(`File ${id} does not exist on disk.`)
      throw new Error(`Source file not found: ${id}`)
    }
  }

  return {
    program,
    file: sourceFile,
  }
}

/**
 * Emits a TypeScript declaration file for a single source file using the
 * standard TypeScript compiler (`tsc`) mode (without the
 * {@linkcode https://www.typescriptlang.org/docs/handbook/project-references.html#build-mode-for-typescript | --build}
 * flag). Uses {@linkcode createOrGetTsModule()} to reuse or create a
 * {@linkcode Program | program}, then invokes the emit pipeline with
 * {@linkcode customTransformers} applied. If the source file is already a
 * `.d.ts` file (e.g. a redirected output from a composite project build),
 * its text is returned as-is. Use {@linkcode tscEmitBuild()} instead when
 * {@linkcode TscOptions.build | build} is `true`.
 *
 * @param tscOptions - The options for emitting the declaration file.
 * @returns The result of the emit operation, including the emitted code, source map, and any errors that occurred.
 */
export function tscEmitCompiler(tscOptions: TscOptions): TscResult {
  debug(`running tscEmitCompiler ${tscOptions.id}`)

  const module = createOrGetTsModule(tscOptions)
  const { program, file } = module
  debug(`got source file: ${file.fileName}`)
  let dtsCode: string | undefined
  let map: ExistingRawSourceMap | undefined

  const { emitSkipped, diagnostics } = program.emit(
    file,
    (fileName, code) => {
      if (fileName.endsWith('.map')) {
        debug(`emit dts sourcemap: ${fileName}`)
        map = JSON.parse(code)
        setSourceMapRoot(map, fileName, tscOptions.id)
      } else {
        debug(`emit dts: ${fileName}`)
        dtsCode = code
      }
    },
    undefined,
    true,
    customTransformers,
    // @ts-expect-error private API: forceDtsEmit
    true,
  )
  if (emitSkipped && diagnostics.length) {
    return { error: ts.formatDiagnostics(diagnostics, formatHost) }
  }

  // If TypeScript skipped emitting because the file is already a .d.ts (e.g. a
  // redirected output from a composite project build), the emit callback above
  // will never be invoked. In that case, fall back to the text of the source
  // file itself so that callers still receive a declaration string.
  if (!dtsCode) {
    debug('nothing was emitted.')

    if (file.isDeclarationFile) {
      debug('source file is a declaration file.')
      dtsCode = file.getFullText()
    } else {
      console.warn(
        '[rolldown-plugin-dts] Warning: Failed to emit declaration file. Please try to enable `eager` option (`dts.eager` for tsdown).',
      )
    }
  }

  return { code: dtsCode, map }
}
