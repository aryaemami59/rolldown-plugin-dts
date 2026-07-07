import { b, is } from 'yuku-ast'
import { isIdentifierName } from 'yuku-ast/identifier'
import { nameOf } from 'yuku-ast/utils'
import { print } from 'yuku-codegen'
import { parse, walk, type ParseResult } from 'yuku-parser'
import {
  filename_dts_to,
  filename_js_to_dts,
  RE_DTS,
  RE_DTS_MAP,
  RE_NODE_MODULES,
  replaceTemplateName,
  resolveTemplateFn,
} from './filename.ts'
import { EMPTY_STUB } from './generate.ts'
import type { OptionsResolved } from './options.ts'
import type {
  Plugin,
  RenderedChunk,
  SourceMapInput,
  TransformPluginContext,
  TransformResult,
} from 'rolldown'
import type * as t from 'yuku-parser'

// input:
// export declare function x(xx: X): void

// to:            const x   = [1, () => X  ]
// after compile: const x$1 = [1, () => X$1]

// replace X with X$1
// output:
// export declare function x$1(xx: X$1): void

/**
 * A runtime dependency expression collected from a declaration, optionally
 * carrying a {@linkcode replace()} callback that swaps the original node for
 * its transformed counterpart during chunk rendering.
 */
type Dep = t.Expression & { replace?: (newNode: t.Node) => void }

/**
 * A collection of type parameters grouped by parameter name.
 */
type TypeParams = Array<{
  /**
   * The type parameter name shared by all entries in this group.
   */
  name: string

  /**
   * The {@linkcode t.Identifier | Identifier} nodes extracted from the
   * {@linkcode t.TSTypeParameterDeclaration | TSTypeParameterDeclaration}
   * params for this type parameter name, collected so each one can be renamed
   * in lock-step.
   */
  typeParams: t.Identifier[]
}>

/**
 * Stores everything the plugin needs to reconstruct a TypeScript declaration
 * after Rolldown renames its bindings during the fake-JS bundling phase.
 */
interface DeclarationInfo {
  /**
   * The original TypeScript declaration node.
   */
  decl: t.Declaration

  /**
   * The identifier nodes that name this declaration (may be multiple for
   * `var a, b`).
   */
  bindings: t.Identifier[]

  /**
   * Type parameter groups collected from the declaration, used to propagate
   * renames.
   */
  params: TypeParams

  /**
   * Runtime expressions that represent type-level dependencies of this
   * declaration.
   */
  deps: Dep[]

  /**
   * Child identifier nodes whose source positions are tracked for source-map
   * accuracy.
   */
  children: t.Node[]
}

/**
 * The export metadata collected for a single `.d.ts` module, used to determine
 * which of its exports are type-only when reconstructing the bundled output.
 */
interface ModuleExports {
  /**
   * The local names imported with `import type` (or `import { type X }`),
   * tracked so re-exports of these locals can be marked type-only.
   */
  typeOnlyLocals: Set<string>

  /**
   * Maps each exported name to whether it is type-only (`true`) or a value
   * export (`false`).
   */
  exports: Map<string, boolean>

  /**
   * Re-export specifiers (`export { x } from './bar'`) whose type-only status
   * may depend on the resolved source module.
   */
  reExports: ReExportInfo[]

  /**
   * Wildcard re-exports (`export * from './bar'`) whose members are merged in
   * from the resolved source module.
   */
  exportAlls: ExportAllInfo[]
}

/**
 * A single named re-export (`export { local as exported } from './bar'`).
 */
interface ReExportInfo {
  /**
   * The resolved module ID of the re-export source, or `undefined` when the
   * source is external or could not be resolved.
   */
  source?: string

  /**
   * The name of the binding in the source module.
   */
  local: string

  /**
   * The name under which the binding is re-exported from this module.
   */
  exported: string

  /**
   * Whether this specific re-export is written as type-only.
   */
  typeOnly: boolean
}

/**
 * A single wildcard re-export (`export * from './bar'`).
 */
interface ExportAllInfo {
  /**
   * The resolved module ID of the re-export source, or `undefined` when the
   * source is external or could not be resolved.
   */
  source?: string

  /**
   * The source string exactly as written in the declaration.
   */
  rawSource: string

  /**
   * Whether this wildcard re-export is written as `export type *`.
   */
  typeOnly: boolean
}

/**
 * Aggregated, chunk-level export metadata derived from every module in a
 * rendered chunk, used to decide which emitted exports must be marked
 * type-only.
 */
interface ChunkExportInfo {
  /**
   * The set of exported names that resolve to type-only exports across the
   * whole chunk.
   */
  typeOnlyNames: Set<string>

  /**
   * The raw source strings of type-only `export *` declarations whose source
   * is external or unresolved, so they can be re-marked as `export type *`.
   */
  typeOnlyExportAllSources: Set<string>
}

/**
 * Maps a module source string (e.g. `'./foo'`) to the namespace import
 * statement and its local identifier, used when rewriting `import()`-style
 * `type` references.
 */
type NamespaceMap = Map<
  string,
  {
    /**
     * The `import * as X from './bar'` statement prepended to the module.
     */
    stmt: t.ProgramStatement

    /**
     * The local namespace identifier (or qualified name) introduced by the
     * import.
     */
    local: t.Identifier | t.TSQualifiedName
  }
>

export function createFakeJsPlugin({
  sourcemap,
  cjsDefault,
  sideEffects,
}: Pick<OptionsResolved, 'sourcemap' | 'cjsDefault' | 'sideEffects'>): Plugin {
  let declarationIdx = 0
  const declarationMap = new Map<number /* declaration id */, DeclarationInfo>()
  const commentsMap = new Map<string /* filename */, t.Comment[]>()
  const moduleExportsMap = new Map<string /* filename */, ModuleExports>()
  const warnedCjsDtsInputs = new Set<string>()

  return {
    name: 'rolldown-plugin-dts:fake-js',

    outputOptions(options) {
      if (options.format === 'cjs' || options.format === 'commonjs') {
        throw new Error(
          '[rolldown-plugin-dts] Cannot bundle dts files with `cjs` format.',
        )
      }

      const { chunkFileNames, entryFileNames } = options
      return {
        ...options,
        sourcemap: options.sourcemap || sourcemap,
        chunkFileNames(chunk) {
          const nameTemplate = resolveTemplateFn(
            chunk.isEntry
              ? entryFileNames || '[name].js'
              : chunkFileNames || '[name]-[hash].js',
            chunk,
          )

          if (chunk.name.endsWith('.d')) {
            const renderedNameWithoutD = filename_js_to_dts(
              replaceTemplateName(nameTemplate, chunk.name.slice(0, -2)),
            )
            if (RE_DTS.test(renderedNameWithoutD)) {
              return renderedNameWithoutD
            }

            const renderedName = filename_js_to_dts(
              replaceTemplateName(nameTemplate, chunk.name),
            )
            if (RE_DTS.test(renderedName)) {
              return renderedName
            }
          }

          return nameTemplate
        },
      }
    },

    transform: {
      filter: { id: RE_DTS },
      handler: transform,
    },
    renderChunk,

    generateBundle(options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (!RE_DTS_MAP.test(chunk.fileName)) continue

        if (sourcemap) {
          if (chunk.type === 'chunk' || typeof chunk.source !== 'string')
            continue
          const map = JSON.parse(chunk.source)
          map.sourcesContent = undefined
          chunk.source = JSON.stringify(map)
        } else {
          delete bundle[chunk.fileName]
        }
      }
    },
  }

  /**
   * The {@linkcode Plugin.transform | transform} hook handler: parses a
   * `.d.ts` module and lowers each TypeScript declaration into a
   * {@linkcode RuntimeBindingVariableDeclaration | runtime binding variable}
   * so Rolldown can bundle the module as JavaScript.
   *
   * @param code - The `.d.ts` source code.
   * @param id - The module id of the `.d.ts` file.
   * @returns The fake-JS code and its source map.
   */
  async function transform(
    this: TransformPluginContext,
    code: string,
    id: string,
  ): Promise<TransformResult> {
    let file: ParseResult
    try {
      file = parse(code, {
        lang: 'dts',
        sourceType: 'module',
        attachComments: true,
      })
    } catch (error) {
      throw new Error(
        `Failed to parse ${id}. This may be caused by a syntax error in the declaration file or a bug in the plugin. Please report this issue to https://github.com/sxzz/rolldown-plugin-dts\n${error}`,
        { cause: error },
      )
    }

    const { program } = file
    moduleExportsMap.set(id, await collectModuleExports(this, program.body, id))
    const identifierMap: Record<string, number> = Object.create(null)

    if (!warnedCjsDtsInputs.has(id) && program.body.some(isCjsDtsInputSyntax)) {
      warnedCjsDtsInputs.add(id)
      this.warn(
        `${id} uses CommonJS dts syntax. ${
          RE_NODE_MODULES.test(id)
            ? `CommonJS dts modules cannot be bundled by rolldown-plugin-dts. Please mark this module as external in your Rolldown config.`
            : `rolldown-plugin-dts does not support bundling CommonJS dts input.`
        }`,
      )
    }

    const directives = collectReferenceDirectives(file.comments)
    if (directives.length) {
      commentsMap.set(id, directives)
    }

    const appendStmts: t.ProgramStatement[] = []
    const namespaceStmts: NamespaceMap = new Map()

    for (const [i, stmt] of program.body.entries()) {
      const setStmt = (stmt: t.ProgramStatement) => (program.body[i] = stmt)
      if (rewriteImportExport(stmt, setStmt)) continue

      const sideEffect =
        stmt.type === 'TSModuleDeclaration' && stmt.kind !== 'namespace'

      if (
        sideEffect &&
        stmt.type === 'TSModuleDeclaration' &&
        is.StringLiteral(stmt.id) &&
        stmt.id.value[0] === '.'
      ) {
        this.warn(
          `\`declare module ${JSON.stringify(stmt.id.value)}\` will be kept as-is in the output. Relative module declaration may cause unexpected issues. Found in ${id}.`,
        )
      }

      const isDefaultExport = stmt.type === 'ExportDefaultDeclaration'
      const isExportDecl =
        is.oneOf(stmt, [
          'ExportNamedDeclaration', // export let x
          'ExportDefaultDeclaration', // export default function x() {}
        ]) && !!stmt.declaration

      const decl: t.Node = isExportDecl ? stmt.declaration! : stmt
      const setDecl = isExportDecl
        ? (decl: t.VariableDeclaration) => (stmt.declaration = decl)
        : setStmt

      if (decl.type !== 'TSDeclareFunction' && !is.Declaration(decl)) {
        continue
      }

      if (
        is.oneOf(decl, [
          'TSEnumDeclaration',
          'ClassDeclaration',
          'FunctionDeclaration',
          'TSDeclareFunction',
          'TSModuleDeclaration',
          'VariableDeclaration',
        ])
      ) {
        decl.declare = true
      }

      const bindings: t.Identifier[] = []
      if (decl.type === 'VariableDeclaration') {
        bindings.push(
          ...decl.declarations.map((decl) => decl.id as t.Identifier),
        )
      } else if ('id' in decl && decl.id) {
        let binding: t.Node = decl.id
        if (binding.type === 'TSQualifiedName') {
          binding = getIdFromTSEntityName(binding)
        }

        if (sideEffect) {
          binding = b.identifier(`_${getIdentifierIndex(identifierMap, '')}`)
        }

        if (binding.type !== 'Identifier') {
          throw new Error(`Unexpected ${binding.type} declaration id`)
        }

        bindings.push(binding)
      } else {
        const binding = b.identifier('export_default')
        bindings.push(binding)
        ;(decl as { id?: t.Identifier }).id = binding
      }

      const params: TypeParams = collectParams(decl)
      const childrenSet = new Set<t.Node>()
      const deps = await collectDependencies(
        this,
        decl,
        id,
        namespaceStmts,
        childrenSet,
        identifierMap,
      )
      const children = Array.from(childrenSet).filter((child) =>
        bindings.every((b) => child !== b),
      )

      if (decl !== stmt) {
        decl.comments = stmt.comments
      }

      const declarationId = registerDeclaration({
        decl,
        deps,
        bindings,
        params,
        children,
      })

      const declarationIdNode: t.NumericLiteral =
        b.numericLiteral(declarationId)
      const depsBody: t.ArrayExpression = b.arrayExpression(deps)
      const depsNode: t.ArrowFunctionExpression = b.arrowFunctionExpression(
        params.map(({ name }) => b.identifier(name)),
        depsBody,
      )
      const childrenNode: t.ArrayExpression = b.arrayExpression(
        children.map((node) => {
          const placeholder = b.stringLiteral('')
          placeholder.start = node.start
          placeholder.end = node.end
          return placeholder
        }),
      )
      const sideEffectNode: t.CallExpression | false =
        sideEffect &&
        b.callExpression(b.identifier('sideEffect'), [bindings[0]])
      const runtimeArrayNode = runtimeBindingArrayExpression([
        declarationIdNode,
        depsNode,
        childrenNode,
        ...(sideEffectNode ? ([sideEffectNode] as const) : ([] as const)),
      ])

      /*
      var ${binding} = [
        ${declarationId},
        (param, ...) => [dep, ...],
        ["children symbol name"],
        sideEffect()
      ]
      */
      const runtimeAssignment = b.variableDeclaration('var', [
        b.variableDeclarator(
          b.arrayPattern(
            bindings.map((binding) => ({ ...binding, typeAnnotation: null })),
          ),
          runtimeArrayNode,
        ),
      ]) as RuntimeBindingVariableDeclaration

      if (isDefaultExport) {
        // export { ${binding} as default }
        appendStmts.push(
          b.exportNamedDeclaration(null, [
            b.exportSpecifier(bindings[0], b.identifier('default')),
          ]),
        )
        // replace the whole statement
        setStmt(runtimeAssignment)
      } else {
        // replace declaration, keep `export`
        setDecl(runtimeAssignment)
      }
    }

    if (sideEffects) {
      // module side effect marker
      appendStmts.push(
        b.expressionStatement(b.callExpression(b.identifier('sideEffect'), [])),
      )
    }

    program.body = [
      ...Array.from(namespaceStmts.values()).map(({ stmt }) => stmt),
      ...program.body,
      ...appendStmts,
    ]

    const result = print(program, {
      comments: false,
      ...(sourcemap && {
        sourceMaps: { source: code, sourceFileName: id },
      }),
    })

    return {
      code: result.code,
      map: (result.map ?? null) as SourceMapInput | null,
    }
  }

  /**
   * The {@linkcode Plugin.renderChunk | renderChunk} hook handler: parses the
   * bundled fake-JS chunk and reconstructs the original TypeScript
   * declarations, applying the bindings, type parameters, and dependencies
   * renamed by Rolldown back onto the stored declaration nodes.
   *
   * @param code - The bundled chunk's JavaScript code.
   * @param chunk - The rendered chunk metadata.
   * @returns The reconstructed `.d.ts` code and source map, or `undefined` for non-`.d.ts` chunks.
   */
  function renderChunk(code: string, chunk: RenderedChunk) {
    if (!RE_DTS.test(chunk.fileName)) {
      return
    }

    const exportInfo = collectChunkExportInfo(chunk, moduleExportsMap)

    let file: ParseResult
    try {
      file = parse(code, {
        lang: 'ts',
        sourceType: 'module',
        attachComments: true,
      })
    } catch (error) {
      throw new Error(
        `Failed to parse generated code for chunk ${chunk.fileName}. This may be caused by a bug in the plugin. Please report this issue to https://github.com/sxzz/rolldown-plugin-dts\n${error}`,
        { cause: error },
      )
    }

    const { program } = file
    program.body = patchTsNamespace(program.body)
    program.body = patchReExport(program.body)

    program.body = program.body
      .map((node) => {
        if (isHelperImport(node)) return null
        if (node.type === 'ExpressionStatement') return null

        const newNode = patchImportExport(node, exportInfo, cjsDefault)
        if (newNode || newNode === false) {
          return newNode
        }

        if (node.type !== 'VariableDeclaration') return node

        if (!isRuntimeBindingVariableDeclaration(node)) {
          return null
        }

        const decl = node.declarations[0]
        const [declarationIdNode, depsFn, children /*, ignore sideEffect */] =
          decl.init.elements

        const declarationId = declarationIdNode.value
        const declaration = getDeclaration(declarationId!)

        if (sourcemap) {
          walk(declaration.decl, {
            enter(node) {
              node.start = undefined as never
              node.end = undefined as never
            },
          })
        }

        for (const [i, id] of decl.id.elements.entries()) {
          const transformedBinding = {
            ...id,
            typeAnnotation: declaration.bindings[i].typeAnnotation,
          }
          overwriteNode(declaration.bindings[i], transformedBinding)
        }

        if (sourcemap) {
          for (const [i, child] of (
            children.elements as t.StringLiteral[]
          ).entries()) {
            Object.assign(declaration.children[i], {
              start: child.start,
              end: child.end,
            })
          }
        }

        const transformedParams = depsFn.params as t.Identifier[]
        for (const [i, transformedParam] of transformedParams.entries()) {
          const transformedName = transformedParam.name
          for (const originalTypeParam of declaration.params[i].typeParams) {
            originalTypeParam.name = transformedName
          }
        }

        const transformedDeps = (depsFn.body as t.ArrayExpression)
          .elements as t.Expression[]
        for (const [i, originalDep] of declaration.deps.entries()) {
          let transformedDep = transformedDeps[i]
          if (
            transformedDep.type === 'UnaryExpression' &&
            transformedDep.operator === 'void'
          ) {
            const undefinedDep = b.identifier('undefined')
            undefinedDep.start = transformedDep.start
            undefinedDep.end = transformedDep.end
            transformedDep = undefinedDep
          } else if (isInfer(transformedDep)) {
            transformedDep.name = '__Infer'
          }

          if (originalDep.replace) {
            originalDep.replace(transformedDep)
          } else {
            Object.assign(originalDep, transformedDep)
          }
        }

        return inheritNodeComments(node, declaration.decl)
      })
      .filter((node) => !!node)

    if (program.body.length === 0) {
      return { code: EMPTY_STUB, map: null }
    }

    // recover comments
    const comments = new Set<t.Comment>()
    const commentsValue = new Set<string>() // deduplicate

    for (const id of chunk.moduleIds) {
      const preserveComments = commentsMap.get(id)
      if (preserveComments) {
        preserveComments.forEach((c) => {
          const id = c.type + c.value
          if (commentsValue.has(id)) return

          commentsValue.add(id)
          comments.add(c)
        })
        commentsMap.delete(id)
      }
    }
    if (comments.size) {
      program.body[0].comments ||= []
      program.body[0].comments.unshift(
        ...Array.from(
          comments,
          (c): t.AttachedComment => ({
            type: c.type,
            value: c.value,
            position: 'before',
            sameLine: false,
          }),
        ),
      )
    }

    const result = print(program, {
      comments: true,
      ...(sourcemap && {
        sourceMaps: {
          source: code,
          sourceFileName: chunk.fileName,
        },
      }),
    })

    return {
      code: result.code,
      map: (result.map ?? null) as SourceMapInput | null,
    }
  }

  /**
   * Stores a {@linkcode DeclarationInfo} in the plugin's
   * {@linkcode declarationMap} and returns its unique numeric ID.
   *
   * @param info - The declaration metadata to store.
   * @returns The unique numeric ID assigned to this declaration.
   */
  function registerDeclaration(info: DeclarationInfo) {
    const declarationId = declarationIdx++
    declarationMap.set(declarationId, info)
    return declarationId
  }

  /**
   * Retrieves the {@linkcode DeclarationInfo} for the given
   * {@linkcode declarationId}.
   *
   * @param declarationId - The numeric ID previously returned by {@linkcode registerDeclaration()}.
   * @returns The stored {@linkcode DeclarationInfo}.
   */
  function getDeclaration(declarationId: number) {
    return declarationMap.get(declarationId)!
  }
}

//#region Export metadata

/**
 * Collects the {@linkcode ModuleExports | export metadata} for a single
 * `.d.ts` module by first gathering its type-only local imports and then
 * scanning every top-level statement for export declarations.
 *
 * @param context - The Rolldown plugin context, used to resolve re-export sources.
 * @param nodes - The top-level AST statements of the module.
 * @param id - The module ID of the declaration file being analyzed.
 * @returns The collected {@linkcode ModuleExports} for the module.
 */
async function collectModuleExports(
  context: TransformPluginContext,
  nodes: t.ProgramStatement[],
  id: string,
): Promise<ModuleExports> {
  const info: ModuleExports = {
    typeOnlyLocals: new Set(),
    exports: new Map(),
    reExports: [],
    exportAlls: [],
  }

  for (const node of nodes) {
    collectTypeOnlyLocals(node, info.typeOnlyLocals)
  }

  for (const node of nodes) {
    await collectExportInfo(context, node, id, info)
  }

  return info
}

/**
 * Records the local names introduced by a
 * {@link https://www.typescriptlang.org/docs/handbook/modules/reference.html#type-only-imports-and-exports | type-only}
 * import declaration (either
 * {@linkcode https://www.typescriptlang.org/docs/handbook/2/modules.html#import-type | import type}
 * (`import type { X }`) or an
 * {@link https://www.typescriptlang.org/docs/handbook/2/modules.html#inline-type-imports | inline `type` specifier}
 * (`import { type X }`)) and adds them into {@linkcode typeOnlyLocals}.
 *
 * @param node - The AST statement to inspect; ignored unless it is an import declaration.
 * @param typeOnlyLocals - The set to populate with type-only local binding names.
 */
function collectTypeOnlyLocals(
  node: t.ProgramStatement,
  typeOnlyLocals: Set<string>,
): void {
  if (node.type !== 'ImportDeclaration') return

  for (const specifier of node.specifiers) {
    if (
      node.importKind === 'type' ||
      ('importKind' in specifier && specifier.importKind === 'type')
    ) {
      typeOnlyLocals.add(specifier.local.name)
    }
  }
}

/**
 * Extracts the binding names declared by a declaration node, handling variable
 * declarations (including destructuring patterns) and named declarations with
 * an `id`.
 *
 * @param node - The declaration AST node to inspect.
 * @returns The names bound by the declaration, or an empty array if none apply.
 */
function collectDeclarationNames(node: t.Node): string[] {
  if (node.type === 'VariableDeclaration') {
    return node.declarations.flatMap((decl) => collectPatternNames(decl.id))
  }

  if ('id' in node && node.id) {
    if (node.id.type !== 'Identifier' && node.id.type !== 'TSQualifiedName') {
      return []
    }

    const id = getIdFromTSEntityName(node.id)
    return id.type === 'Identifier' ? [id.name] : []
  }

  return []
}

/**
 * Recursively collects all identifier names bound by a binding pattern,
 * descending through rest elements, default assignments, and array/object
 * destructuring patterns.
 *
 * @param node - The binding pattern (or identifier) AST node to walk.
 * @returns The flat list of identifier names bound by the pattern.
 */
function collectPatternNames(node: t.Node | null | undefined): string[] {
  if (!node) return []

  if (node.type === 'Identifier') {
    return [node.name]
  }

  if (node.type === 'RestElement') {
    return collectPatternNames(node.argument)
  }

  if (node.type === 'AssignmentPattern') {
    return collectPatternNames(node.left)
  }

  if (node.type === 'ArrayPattern') {
    return node.elements.flatMap((element) => collectPatternNames(element))
  }

  if (node.type === 'ObjectPattern') {
    return node.properties.flatMap((property) => {
      if (property.type === 'RestElement') {
        return collectPatternNames(property.argument)
      }
      return collectPatternNames(property.value)
    })
  }

  return []
}

/**
 * Returns `true` if an export specifier is
 * {@link https://www.typescriptlang.org/docs/handbook/modules/reference.html#type-only-imports-and-exports | type-only},
 * either because the whole `export type { X }` declaration is type-only or
 * because the individual `export { type X }` specifier is.
 *
 * @param node - The {@linkcode t.ExportNamedDeclaration | ExportNamedDeclaration} containing the specifier.
 * @param specifier - The individual {@linkcode t.ExportSpecifier | ExportSpecifier} to test.
 * @returns `true` if the specifier is exported as type-only.
 */
function isTypeOnlyExport(
  node: t.ExportNamedDeclaration,
  specifier: t.ExportSpecifier,
): boolean {
  return node.exportKind === 'type' || specifier.exportKind === 'type'
}

/**
 * Inspects a single top-level statement and records any exports it declares
 * into {@linkcode info}, distinguishing local declarations, named re-exports,
 * default exports, and wildcard re-exports.
 *
 * @param context - The Rolldown plugin context, used to resolve re-export sources.
 * @param node - The AST statement to inspect.
 * @param id - The module ID of the declaration file being analyzed, used as the importer when resolving sources.
 * @param info - The {@linkcode ModuleExports} accumulator to populate in place.
 */
async function collectExportInfo(
  context: TransformPluginContext,
  node: t.ProgramStatement,
  id: string,
  info: ModuleExports,
): Promise<void> {
  if (node.type === 'ExportNamedDeclaration') {
    if (node.declaration) {
      for (const name of collectDeclarationNames(node.declaration)) {
        info.exports.set(name, false)
      }
      return
    }

    const source = await resolveExportSource(context, node.source, id)
    for (const specifier of node.specifiers) {
      const typeOnly = isTypeOnlyExport(node, specifier)

      const exported = nameOf(specifier.exported)!
      const local = nameOf(specifier.local)!
      if (source) {
        info.reExports.push({ source, local, exported, typeOnly })
      } else {
        info.exports.set(exported, typeOnly || info.typeOnlyLocals.has(local))
      }
    }
    return
  }

  if (node.type === 'ExportDefaultDeclaration') {
    info.exports.set('default', false)
    return
  }

  if (node.type === 'ExportAllDeclaration') {
    if (node.exported) {
      info.exports.set(nameOf(node.exported)!, node.exportKind === 'type')
      return
    }

    info.exportAlls.push({
      source: await resolveExportSource(context, node.source, id),
      rawSource: node.source.value,
      typeOnly: node.exportKind === 'type',
    })
  }
}

/**
 * Resolves a re-export source specifier to its module id via the plugin
 * context.
 *
 * @param context - The Rolldown plugin context.
 * @param [source] - The source string literal of the re-export, if any.
 * @param importer - The module id of the re-exporting module.
 * @returns The resolved module id, or `undefined` when there is no source or it resolves to an external or unresolvable module.
 */
async function resolveExportSource(
  context: TransformPluginContext,
  source: t.StringLiteral | null | undefined,
  importer: string,
): Promise<string | undefined> {
  if (!source) return

  const resolved = await context.resolve(source.value, importer)
  if (!resolved || resolved.external) return

  return resolved.id
}

/**
 * Computes the {@linkcode ChunkExportInfo} for a rendered chunk by merging
 * the resolved export maps of its modules (starting from the facade module
 * when available) and collecting unresolved type-only star re-exports.
 *
 * @param chunk - The rendered chunk to compute export info for.
 * @param moduleExportsMap - Per-module export metadata collected during the transform phase.
 * @returns The chunk's {@linkcode ChunkExportInfo}.
 */
function collectChunkExportInfo(
  chunk: RenderedChunk,
  moduleExportsMap: Map<string, ModuleExports>,
): ChunkExportInfo {
  const exportsByModule = resolveAllModuleExports(moduleExportsMap)
  const roots =
    chunk.facadeModuleId && moduleExportsMap.has(chunk.facadeModuleId)
      ? [chunk.facadeModuleId]
      : chunk.moduleIds
  const mergedExports = new Map<string, boolean>()
  const typeOnlyExportAllSources = new Set<string>()

  for (const root of roots) {
    const exports = exportsByModule.get(root)
    if (exports) {
      for (const [name, typeOnly] of exports) {
        setExportTypeOnly(mergedExports, name, typeOnly)
      }
    }

    const moduleExports = moduleExportsMap.get(root)
    if (!moduleExports) continue

    for (const exportAll of moduleExports.exportAlls) {
      if (!exportAll.typeOnly || exportAll.source) continue
      typeOnlyExportAllSources.add(exportAll.rawSource)
    }
  }

  const typeOnlyNames = new Set<string>()
  for (const [name, typeOnly] of mergedExports) {
    if (typeOnly) typeOnlyNames.add(name)
  }

  return { typeOnlyNames, typeOnlyExportAllSources }
}

/**
 * Resolves each module's full export map (exported name to type-only flag)
 * by propagating re-exports and star re-exports across modules until a fixed
 * point is reached.
 *
 * @param moduleExportsMap - Per-module export metadata collected during the transform phase.
 * @returns A map of module id to its resolved export map.
 */
function resolveAllModuleExports(
  moduleExportsMap: Map<string, ModuleExports>,
): Map<string, Map<string, boolean>> {
  const exportsByModule = new Map<string, Map<string, boolean>>()

  for (const [id, info] of moduleExportsMap) {
    exportsByModule.set(id, new Map(info.exports))
  }

  let changed = true
  while (changed) {
    changed = false

    for (const [id, info] of moduleExportsMap) {
      const exports = exportsByModule.get(id)!

      for (const reExport of info.reExports) {
        const sourceExports = reExport.source
          ? exportsByModule.get(reExport.source)
          : undefined
        const sourceTypeOnly = sourceExports?.get(reExport.local) ?? false
        if (
          setExportTypeOnly(
            exports,
            reExport.exported,
            reExport.typeOnly || sourceTypeOnly,
          )
        ) {
          changed = true
        }
      }

      for (const exportAll of info.exportAlls) {
        if (!exportAll.source) continue

        const sourceExports = exportsByModule.get(exportAll.source)
        if (!sourceExports) continue

        for (const [name, typeOnly] of sourceExports) {
          if (name === 'default') continue
          if (
            setExportTypeOnly(exports, name, exportAll.typeOnly || typeOnly)
          ) {
            changed = true
          }
        }
      }
    }
  }

  return exportsByModule
}

/**
 * Merges a type-only flag for {@linkcode name} into {@linkcode exports}. A
 * value export always wins over a type-only export of the same name.
 *
 * @param exports - The export map to update.
 * @param name - The exported name.
 * @param typeOnly - Whether this occurrence of the export is type-only.
 * @returns `true` if the map was changed.
 */
function setExportTypeOnly(
  exports: Map<string, boolean>,
  name: string,
  typeOnly: boolean,
): boolean {
  const current = exports.get(name)
  if (current === false || current === typeOnly) return false

  if (current === undefined || !typeOnly) {
    exports.set(name, typeOnly)
    return true
  }

  return false
}

// #endregion

//#region Declaration dependency collection

/**
 * Collects all {@linkcode t.TSTypeParameter | TSTypeParameter} nodes from
 * the given node and groups them by their name. One name can associate with
 * one or more type parameters. These names will be used as the parameter
 * name in the generated JavaScript dependency function.
 *
 * @param node - The AST node to walk when collecting type parameters.
 * @returns An array of {@linkcode TypeParams | name/typeParams pairs}, one entry per unique type parameter name found in the {@linkcode node}.
 */
function collectParams(node: t.Node): TypeParams {
  const typeParams: t.Identifier[] = []
  walk(node, {
    leave(node) {
      if (
        'typeParameters' in node &&
        node.typeParameters?.type === 'TSTypeParameterDeclaration'
      ) {
        typeParams.push(...node.typeParameters.params.map(({ name }) => name))
      }
    },
  })

  const paramMap = new Map<string, t.Identifier[]>()
  for (const typeParam of typeParams) {
    const name = typeParam.name
    const group = paramMap.get(name)
    if (group) {
      group.push(typeParam)
    } else {
      paramMap.set(name, [typeParam])
    }
  }

  return Array.from(paramMap.entries()).map(([name, typeParams]) => ({
    name,
    typeParams,
  }))
}

/**
 * Walks {@linkcode node} and collects all runtime dependency expressions
 * needed to preserve type-level references after Rolldown renames bindings.
 *
 * @param context - The Rolldown plugin context, used to resolve dynamic `import()` type references.
 * @param node - The TypeScript declaration AST node to analyze.
 * @param importer - The module ID of the declaration file being transformed, used as the importer when resolving `import()` type references.
 * @param namespaceStmts - Accumulator map for `import * as` statements added for `import()` type references.
 * @param children - Set populated with child identifier nodes whose source positions need to be tracked.
 * @param identifierMap - Counter map used to generate unique identifiers for namespace imports.
 * @returns An array of {@linkcode Dep | runtime dependency expressions}.
 */
async function collectDependencies(
  context: TransformPluginContext,
  node: t.Node,
  importer: string,
  namespaceStmts: NamespaceMap,
  children: Set<t.Node>,
  identifierMap: Record<string, number>,
): Promise<Dep[]> {
  const deps = new Set<Dep>()
  const seen = new Set<t.Node>()
  const preserveImportTypeCache = new Map<string, boolean>()

  const importSources = new Set<string>()
  walk(node, {
    TSImportType(node) {
      importSources.add(node.source.value)
    },
  })
  if (importSources.size) {
    await Promise.all(
      Array.from(importSources, async (source) => {
        const resolved = await context.resolve(source, importer)
        preserveImportTypeCache.set(source, !resolved || !!resolved.external)
      }),
    )
  }

  const inferredStack: string[][] = []
  let currentInferred = new Set<string>()
  function isInferred(node: t.Node): boolean {
    return node.type === 'Identifier' && currentInferred.has(node.name)
  }

  walk(node, {
    enter(node) {
      if (node.type === 'TSConditionalType') {
        const inferred = collectInferredNames(node.extendsType)
        inferredStack.push(inferred)
      }
    },
    leave(node, path) {
      const { parent } = path

      // handle infer scope
      if (node.type === 'TSConditionalType') {
        inferredStack.pop()
      } else if (parent?.type === 'TSConditionalType') {
        const trueBranch = parent.trueType === node
        currentInferred = new Set<string>(
          (trueBranch ? inferredStack : inferredStack.slice(0, -1)).flat(),
        )
      } else {
        currentInferred = new Set<string>()
      }

      if (node.type === 'ExportNamedDeclaration') {
        for (const specifier of node.specifiers) {
          if (specifier.type === 'ExportSpecifier') {
            addDependency(specifier.local)
          }
        }
      } else if (node.type === 'TSInterfaceDeclaration' && node.extends) {
        for (const heritage of node.extends || []) {
          addDependency(heritage.expression)
        }
      } else if (node.type === 'ClassDeclaration') {
        if (node.superClass) addDependency(node.superClass)
        if (node.implements) {
          for (const implement of node.implements) {
            addDependency(implement.expression)
          }
        }
      } else if (
        is.oneOf(node, [
          'Property',
          'PropertyDefinition',
          'TSAbstractPropertyDefinition',
          'MethodDefinition',
          'TSAbstractMethodDefinition',
          'TSPropertySignature',
          'TSMethodSignature',
        ])
      ) {
        if (node.computed && isReferenceId(node.key)) {
          addDependency(node.key)
        }
        if ('value' in node && isReferenceId(node.value)) {
          addDependency(node.value)
        }
      } else {
        switch (node.type) {
          case 'TSTypeReference': {
            addDependency(TSEntityNameToRuntime(node.typeName))
            break
          }
          case 'TSTypeQuery': {
            if (seen.has(node.exprName)) return
            if (node.exprName.type === 'TSImportType') break

            addDependency(TSEntityNameToRuntime(node.exprName))

            break
          }
          case 'TSImportType': {
            seen.add(node)
            const { source, qualifier } = node

            const dep = importNamespace(
              node,
              qualifier,
              source,
              namespaceStmts,
              identifierMap,
              preserveImportTypeCache,
            )
            if (dep) addDependency(dep)
            break
          }
        }
      }

      if (parent && !deps.has(node as Dep) && isChildSymbol(node, parent)) {
        children.add(node)
      }
    },
  })

  return Array.from(deps)

  function addDependency(node: Dep) {
    if (isThisExpression(node) || isInferred(node)) return
    deps.add(node)
  }
}

/**
 * Generates a namespace import for a
 * {@linkcode t.TSImportType | TSImportType} node and rewrites the node in
 * place to a qualified name (`_$module.Qualifier`).
 *
 * @param node - The {@linkcode t.TSImportType | TSImportType} AST node to rewrite.
 * @param imported - Optional qualifier path inside the imported namespace.
 * @param source - The string-literal source of the import.
 * @param namespaceStmts - Accumulator map that deduplicates namespace imports.
 * @param identifierMap - Counter map for generating unique local identifiers.
 * @param preserveCache - Cache map for whether to preserve the import type or rewrite it to a namespace import.
 * @returns A {@linkcode Dep | runtime dependency expression} referencing the namespace member.
 * @throws An {@linkcode Error} when the imported qualifier's left-most name is `this`.
 */
function importNamespace(
  node: t.TSImportType,
  imported: t.TSTypeName | null | undefined,
  source: t.StringLiteral,
  namespaceStmts: NamespaceMap,
  identifierMap: Record<string, number>,
  preserveCache: Map<string, boolean>,
): Dep | undefined {
  const preserve = preserveCache.get(source.value) ?? true

  if (preserve) return

  const sourceText = source.value.replaceAll(/\W/g, '_')
  // Use original source if it's already a valid identifier,
  // otherwise use formatted text with index.
  const localName = `_$${
    isIdentifierName(source.value)
      ? source.value
      : `${sourceText}${getIdentifierIndex(identifierMap, sourceText)}`
  }`
  let local: t.Identifier | t.TSQualifiedName = b.identifier(localName)

  if (namespaceStmts.has(source.value)) {
    local = namespaceStmts.get(source.value)!.local
  } else {
    // prepend: import * as ${local} from ${source}
    namespaceStmts.set(source.value, {
      stmt: b.importDeclaration(
        [b.importNamespaceSpecifier(local as t.Identifier)],
        source,
      ),
      local,
    })
  }

  if (imported) {
    const importedLeft = getIdFromTSEntityName(imported)
    if (
      imported.type === 'ThisExpression' ||
      importedLeft.type === 'ThisExpression'
    ) {
      throw new Error('Cannot import `this` from module.')
    }
    overwriteNode(importedLeft, b.tsQualifiedName(local, { ...importedLeft }))
    local = imported
  }

  let replacement: t.Node = node
  if (node.typeArguments) {
    overwriteNode(node, b.tsTypeReference(local, node.typeArguments))
    replacement = local
  } else {
    overwriteNode(node, local)
  }

  const dep: Dep = {
    ...TSEntityNameToRuntime(local),
    replace(newNode) {
      overwriteNode(replacement, newNode)
    },
  }
  return dep
}

// #endregion

/**
 * Returns `true` if {@linkcode node} represents a child symbol within
 * {@linkcode parent}, i.e. an {@linkcode t.Identifier | Identifier} or a
 * computed key in a
 * {@linkcode t.TSPropertySignature | TSPropertySignature} / {@linkcode t.TSMethodSignature | TSMethodSignature}
 * whose source position should be tracked for source-map accuracy.
 *
 * @param node - The AST node to test.
 * @param parent - The parent AST node of {@linkcode node}.
 * @returns `true` if {@linkcode node} is a trackable child symbol.
 */
function isChildSymbol(node: t.Node, parent: t.Node) {
  if (node.type === 'Identifier') return true
  if (
    is.oneOf(parent, ['TSPropertySignature', 'TSMethodSignature']) &&
    parent.key === node
  )
    return true

  return false
}

/**
 * Collects all type-parameter names introduced by `infer` clauses inside a
 * conditional type's {@linkcode t.TSConditionalType.extendsType | extendsType}
 * branch, so they can be excluded from dependency tracking.
 *
 * @param node - The AST node to walk (typically a {@linkcode t.TSConditionalType | TSConditionalType}'s {@linkcode t.TSConditionalType.extendsType | extendsType}).
 * @returns An array of inferred type-parameter names.
 */
function collectInferredNames(node: t.Node) {
  const inferred: string[] = []
  walk(node, {
    enter(node) {
      if (node.type === 'TSInferType' && node.typeParameter) {
        inferred.push(node.typeParameter.name.name)
      }
    },
  })
  return inferred
}

/**
 * Matches
 * {@linkcode https://www.typescriptlang.org/docs/handbook/triple-slash-directives.html#-reference-path- | /// <reference path=...>}
 * and
 * {@linkcode https://www.typescriptlang.org/docs/handbook/triple-slash-directives.html#-reference-types- | /// <reference types=...>}
 * directive comments.
 */
const REFERENCE_RE = /\/\s*<reference\s+(?:path|types)=/

/**
 * Filters the {@linkcode comments} array to those that are
 * {@linkcode https://www.typescriptlang.org/docs/handbook/triple-slash-directives.html#-reference-path- | /// <reference path=...>}
 * or
 * {@linkcode https://www.typescriptlang.org/docs/handbook/triple-slash-directives.html#-reference-types- | /// <reference types=...>}
 * directives, optionally inverting the filter.
 *
 * @param comments - The array of {@linkcode t.Comment | Comment} nodes to filter.
 * @param [negative] - When `true`, returns comments that do NOT match the {@linkcode REFERENCE_RE | reference pattern} instead. Defaults to `false`.
 * @returns The filtered array of reference-directive {@linkcode t.Comment | Comment} nodes.
 */
function collectReferenceDirectives(comments: t.Comment[], negative = false) {
  return comments.filter((c) => REFERENCE_RE.test(c.value) !== negative)
}

/**
 * Matches `#sourceMappingURL=` and `#sourceURL=` pragma comment values.
 */
const SOURCE_MAP_PRAGMA_RE = /^#\s*source(?:Mapping)?URL=/

/**
 * Returns `true` if the comment is a source-map pragma (`#sourceMappingURL=`
 * or `#sourceURL=`).
 *
 * @param comment - The comment to test.
 * @param comment.value - The comment text without the leading comment markers.
 * @returns `true` if the comment value matches {@linkcode SOURCE_MAP_PRAGMA_RE}.
 */
function isSourceMapPragma(comment: { value: string }): boolean {
  return SOURCE_MAP_PRAGMA_RE.test(comment.value)
}

/**
 * Returns `true` if a statement uses
 * {@link https://www.typescriptlang.org/docs/handbook/modules/reference.html#export--and-import--require | CommonJS-style declaration syntax}
 * (`export = ...` or `import x = require('...')`) that this plugin cannot
 * bundle.
 *
 * @param node - The top-level AST statement to test.
 * @returns `true` if the statement uses CommonJS `.d.ts` input syntax.
 */
function isCjsDtsInputSyntax(node: t.ProgramStatement): boolean {
  return (
    node.type === 'TSExportAssignment' ||
    (node.type === 'TSImportEqualsDeclaration' &&
      node.moduleReference.type === 'TSExternalModuleReference')
  )
}

//#region Runtime binding variable

/**
 * A variable declaration that declares a runtime binding variable. It
 * represents a declaration like:
 *
 * ```js
 * var binding = [
 *   declarationId,
 *   (param, ...) => [dep, ...],
 *   ['children symbol name'],
 *   sideEffect(),
 * ];
 * ```
 *
 * For a more concrete example, the following TypeScript declaration:
 *
 * ```ts
 * interface Bar extends Foo {
 *   bar: number;
 * }
 * ```
 *
 * Will be transformed to the following JavaScript code:
 *
 * ```js
 * const Bar = [123, () => [Foo], []];
 * ```
 *
 * Which will be represented by this type.
 */
type RuntimeBindingVariableDeclaration = t.VariableDeclaration & {
  declarations: [
    t.VariableDeclarator & {
      id: t.ArrayPattern
      init: RuntimeBindingArrayExpression
    },
    ...t.VariableDeclarator[],
  ]
}

/**
 * Check if the given {@linkcode node} is a
 * {@linkcode RuntimeBindingVariableDeclaration}.
 *
 * @param node - The AST node to test.
 * @returns `true` if {@linkcode node} is a {@linkcode RuntimeBindingVariableDeclaration}.
 */
function isRuntimeBindingVariableDeclaration(
  node: t.Node | null | undefined,
): node is RuntimeBindingVariableDeclaration {
  return (
    node?.type === 'VariableDeclaration' &&
    node.declarations.length === 1 &&
    node.declarations[0].type === 'VariableDeclarator' &&
    node.declarations[0].id.type === 'ArrayPattern' &&
    isRuntimeBindingArrayExpression(node.declarations[0].init)
  )
}

/**
 * An array expression that contains {@linkcode RuntimeBindingArrayElements}.
 *
 * It can be used to represent the following JavaScript code:
 *
 * ```js
 * [declarationId, (param, ...) => [dep, ...], ['children'], sideEffect()];
 * ```
 */
type RuntimeBindingArrayExpression = t.ArrayExpression & {
  elements: RuntimeBindingArrayElements
}

/**
 * Check if the given {@linkcode node} is a
 * {@linkcode RuntimeBindingArrayExpression}.
 *
 * @param node - The AST node to test.
 * @returns `true` if {@linkcode node} is a {@linkcode RuntimeBindingArrayExpression}.
 */
function isRuntimeBindingArrayExpression(
  node: t.Node | null | undefined,
): node is RuntimeBindingArrayExpression {
  return (
    node?.type === 'ArrayExpression' &&
    isRuntimeBindingArrayElements(node.elements)
  )
}

/**
 * Check if the given array is a {@linkcode RuntimeBindingArrayElements}.
 *
 * @param elements - The array of AST nodes to test.
 * @returns `true` if {@linkcode elements} matches the shape of {@linkcode RuntimeBindingArrayElements}.
 */
function isRuntimeBindingArrayElements(
  elements: Array<t.Node | null | undefined>,
): elements is RuntimeBindingArrayElements {
  const [declarationId, deps, children, effect] = elements
  return (
    is.NumericLiteral(declarationId) &&
    deps?.type === 'ArrowFunctionExpression' &&
    children?.type === 'ArrayExpression' &&
    (!effect || effect.type === 'CallExpression')
  )
}

/**
 * Wraps {@linkcode elements} in a {@linkcode RuntimeBindingArrayExpression}
 * object.
 *
 * @param elements - The tuple elements for the runtime binding array.
 * @returns A new {@linkcode RuntimeBindingArrayExpression} node.
 */
function runtimeBindingArrayExpression(
  elements: RuntimeBindingArrayElements,
): RuntimeBindingArrayExpression {
  return b.arrayExpression([...elements]) as RuntimeBindingArrayExpression
}

/**
 * The required leading elements of a
 * {@linkcode RuntimeBindingArrayExpression}: the declaration id, the
 * dependency arrow function, and the children array.
 */
type RuntimeBindingArrayElementsBase = [
  declarationId: t.NumericLiteral,
  deps: t.ArrowFunctionExpression,
  children: t.ArrayExpression,
]

/**
 * An array that represents the elements in a
 * {@linkcode RuntimeBindingArrayExpression}.
 */
type RuntimeBindingArrayElements =
  | RuntimeBindingArrayElementsBase
  | [...RuntimeBindingArrayElementsBase, effect: t.CallExpression]

// #endregion

/**
 * Returns `true` if {@linkcode node} represents a
 * {@linkcode t.ThisExpression | ThisExpression}
 * (including `this.member` chains).
 *
 * @param node - The AST node to test.
 * @returns `true` if {@linkcode node} is or contains a `this` reference.
 */
function isThisExpression(node: t.Node): boolean {
  return (
    is.Identifier(node, 'this') ||
    node.type === 'ThisExpression' ||
    (node.type === 'MemberExpression' && isThisExpression(node.object))
  )
}

/**
 * Returns `true` if {@linkcode node} is an
 * {@linkcode t.Identifier | Identifier} named `infer`.
 *
 * @param node - The AST node to test.
 * @returns `true` if {@linkcode node} is an {@linkcode t.Identifier | Identifier} named `infer`.
 */
function isInfer(node: t.Node): node is t.Identifier {
  return is.Identifier(node, 'infer')
}

/**
 * Converts a TypeScript qualified name (`A.B.C`) to an equivalent JavaScript
 * member expression (`A.B.C`) by mutating the node in place.
 *
 * @param node - The {@linkcode t.TSTypeName | TSTypeName} AST node to convert.
 * @returns The rewritten node as a {@linkcode t.MemberExpression | MemberExpression}, {@linkcode t.Identifier | Identifier}, or {@linkcode t.ThisExpression | ThisExpression}.
 */
function TSEntityNameToRuntime(
  node: t.TSTypeName,
): t.MemberExpression | t.Identifier | t.ThisExpression {
  if (node.type === 'Identifier' || node.type === 'ThisExpression') {
    return node
  }

  const left = TSEntityNameToRuntime(node.left)
  return Object.assign(node, {
    type: 'MemberExpression' as const,
    object: left,
    property: node.right,
    computed: false,
  })
}

/**
 * Walks a qualified name left-recursively and returns its leftmost
 * {@linkcode t.Identifier | Identifier} or
 * {@linkcode t.ThisExpression | ThisExpression} node.
 *
 * @param node - The {@linkcode t.TSTypeName | TSTypeName} to unwrap.
 * @returns The leftmost {@linkcode t.Identifier | Identifier} or {@linkcode t.ThisExpression | ThisExpression} node.
 */
function getIdFromTSEntityName(
  node: t.TSTypeName,
): t.Identifier | t.ThisExpression {
  if (node.type === 'Identifier' || node.type === 'ThisExpression') {
    return node
  }
  return getIdFromTSEntityName(node.left)
}

/**
 * Returns `true` if {@linkcode node} is an
 * {@linkcode t.Identifier | Identifier} or
 * {@linkcode t.MemberExpression | MemberExpression}, i.e. a node that can
 * appear as a runtime reference to a `type`.
 *
 * @param [node] - The AST node to test.
 * @returns `true` if {@linkcode node} is a referenceable {@linkcode t.Identifier | Identifier} or {@linkcode t.MemberExpression | MemberExpression}.
 */
function isReferenceId(
  node?: t.Node | null,
): node is t.Identifier | t.MemberExpression {
  return is.oneOf(node, ['Identifier', 'MemberExpression'])
}

/**
 * Returns `true` if {@linkcode node} is an import declaration that imports
 * only Rolldown's internal helpers (`__exportAll`, `__reExport`), which must
 * be stripped from the final `.d.ts` output.
 *
 * @param node - The AST node to test.
 * @returns `true` if {@linkcode node} is a Rolldown-helper-only import declaration.
 */
function isHelperImport(node: t.Node) {
  return (
    node.type === 'ImportDeclaration' &&
    node.specifiers.length &&
    node.specifiers.every(
      (spec) =>
        spec.type === 'ImportSpecifier' &&
        spec.imported.type === 'Identifier' &&
        ['__exportAll', '__reExport'].includes(spec.local.name),
    )
  )
}

/**
 * Rewrites `import`/`export` sources by replacing `.d.ts` extensions with
 * `.js` and applies `export =` rewriting for CommonJS `default` exports when
 * {@linkcode cjsDefault} is enabled.
 *
 * @param node - The AST statement node to inspect and possibly rewrite.
 * @param exportInfo - The export metadata for the current chunk, used to determine which exports are type-only and whether to rewrite them as such.
 * @param cjsDefault - Whether to rewrite a `export { x as default }` into `export = x` for CommonJS compatibility.
 * @returns The (possibly mutated) {@linkcode t.Statement | Statement}, `false` to signal the `node` should be removed, or `undefined` if no rewrite applies.
 */
function patchImportExport(
  node: t.ProgramStatement,
  exportInfo: ChunkExportInfo,
  cjsDefault: boolean,
): t.ProgramStatement | false | undefined {
  if (
    node.type === 'ExportNamedDeclaration' &&
    !node.declaration &&
    !node.source &&
    !node.specifiers.length &&
    !node.attributes?.length
  ) {
    return false
  }

  if (node.type === 'ImportDeclaration' && node.specifiers.length) {
    for (const specifier of node.specifiers) {
      if (isInfer(specifier.local)) {
        specifier.local.name = '__Infer'
      }
    }
  }

  if (
    is.oneOf(node, [
      'ImportDeclaration',
      'ExportAllDeclaration',
      'ExportNamedDeclaration',
    ])
  ) {
    if (
      node.type === 'ExportAllDeclaration' &&
      node.source &&
      exportInfo.typeOnlyExportAllSources.has(node.source.value)
    ) {
      node.exportKind = 'type'
    }

    if (
      node.type === 'ExportNamedDeclaration' &&
      exportInfo.typeOnlyNames.size
    ) {
      for (const spec of node.specifiers) {
        const name = nameOf(spec.exported)!
        if (exportInfo.typeOnlyNames.has(name)) {
          if (spec.type === 'ExportSpecifier') {
            spec.exportKind = 'type'
          } else {
            node.exportKind = 'type'
          }
        }
      }
      normalizeTypeOnlyExport(node)
    }

    if (node.source?.value && RE_DTS.test(node.source.value)) {
      node.source.value = filename_dts_to(node.source.value, 'js')
      return node
    }

    if (
      cjsDefault &&
      node.type === 'ExportNamedDeclaration' &&
      !node.source &&
      node.specifiers.length === 1 &&
      node.specifiers[0].type === 'ExportSpecifier' &&
      nameOf(node.specifiers[0].exported) === 'default'
    ) {
      const defaultExport = node.specifiers[0]
      return b.tsExportAssignment(defaultExport.local as t.Expression)
    }
  }
}

/**
 * Collapses an `export { type X, type Y }` declaration whose specifiers are
 * all type-only into a single `export type { X, Y }`, resetting each
 * specifier's kind back to `value` so the type keyword only appears once.
 *
 * @param node - The {@linkcode t.ExportNamedDeclaration | ExportNamedDeclaration} to normalize in place.
 */
function normalizeTypeOnlyExport(node: t.ExportNamedDeclaration): void {
  if (node.declaration || !node.specifiers.length) return

  for (const specifier of node.specifiers) {
    if (
      specifier.type !== 'ExportSpecifier' ||
      specifier.exportKind !== 'type'
    ) {
      return
    }
  }

  node.exportKind = 'type'
  for (const specifier of node.specifiers) {
    if (specifier.type === 'ExportSpecifier') {
      specifier.exportKind = 'value'
    }
  }
}

/**
 * Rewrites `__exportAll` helper calls emitted by Rolldown into proper
 * {@linkcode https://www.typescriptlang.org/docs/handbook/namespaces.html#ambient-namespaces | declare namespace}
 * blocks so the output remains valid TypeScript declaration syntax.
 *
 * @param nodes - The list of top-level AST statements to scan and rewrite in-place.
 * @returns The filtered statement list with `__exportAll` calls replaced by `declare namespace` declarations.
 */
function patchTsNamespace(nodes: t.ProgramStatement[]) {
  const removed = new Set<t.Node>()

  for (const [i, node] of nodes.entries()) {
    const result = getExportAllNamespace(node)
    if (!result) continue

    const [binding, exports] = result
    if (!exports.properties.length) continue

    const namespaceExport = b.exportNamedDeclaration(
      null,
      exports.properties
        .filter((property) => property.type === 'Property')
        .map((property) => {
          const local = (property.value as t.ArrowFunctionExpression)
            .body as t.Identifier
          const exported = property.key as t.Identifier
          return b.exportSpecifier(local, exported)
        }),
    )
    nodes[i] = b.tsModuleDeclaration(
      binding,
      b.tsModuleBlock([namespaceExport]),
      { kind: 'namespace', declare: true },
    )
  }

  return nodes.filter((node) => !removed.has(node))
}

/**
 * Matches a `var ns = __exportAll({ ... })` statement emitted by Rolldown and
 * extracts the namespace binding and its exports object, returning `false`
 * when the statement is not such a helper call.
 *
 * @param node - The top-level AST statement to match.
 * @returns A `[binding, exports]` tuple for the matched helper call, or `false` if it does not match.
 */
function getExportAllNamespace(
  node: t.ProgramStatement,
): false | [t.Identifier, t.ObjectExpression] {
  if (
    node.type !== 'VariableDeclaration' ||
    node.declarations.length !== 1 ||
    node.declarations[0].id.type !== 'Identifier' ||
    node.declarations[0].init?.type !== 'CallExpression' ||
    node.declarations[0].init.callee.type !== 'Identifier' ||
    node.declarations[0].init.callee.name !== '__exportAll' ||
    node.declarations[0].init.arguments.length !== 1 ||
    node.declarations[0].init.arguments[0].type !== 'ObjectExpression'
  ) {
    return false
  }

  const source = node.declarations[0].id

  const exports = node.declarations[0].init.arguments[0]
  return [source, exports] as const
}

/**
 * Rewrites `__reExport` helper calls emitted by Rolldown into `type` alias
 * declarations, preserving cross-module `type` re-exports in the bundled
 * declaration output.
 *
 * @param nodes - The list of top-level AST statements to scan and rewrite in-place.
 * @returns The (mutated) statement list with `__reExport` patterns replaced by {@linkcode t.TSTypeAliasDeclaration | TSTypeAliasDeclaration} nodes.
 */
function patchReExport(nodes: t.ProgramStatement[]) {
  const exportsNames = new Map<string, string>()

  for (const [i, node] of nodes.entries()) {
    if (
      node.type === 'ImportDeclaration' &&
      node.specifiers.length === 1 &&
      node.specifiers[0].type === 'ImportSpecifier' &&
      node.specifiers[0].local.type === 'Identifier' &&
      node.specifiers[0].local.name.endsWith('_exports')
    ) {
      // record: import { t as a_exports } from "..."
      exportsNames.set(
        node.specifiers[0].local.name,
        node.specifiers[0].local.name,
      )
    } else if (
      node.type === 'ExpressionStatement' &&
      node.expression.type === 'CallExpression' &&
      is.Identifier(node.expression.callee, '__reExport')
    ) {
      // record: __reExport(a_exports, import_lib)

      const args = node.expression.arguments
      exportsNames.set(
        (args[0] as t.Identifier).name,
        (args[1] as t.Identifier).name,
      )
    } else if (
      node.type === 'VariableDeclaration' &&
      node.declarations.length === 1 &&
      node.declarations[0].init?.type === 'MemberExpression' &&
      node.declarations[0].init.object.type === 'Identifier' &&
      exportsNames.has(node.declarations[0].init.object.name)
    ) {
      // var B = a_exports.A
      // to
      // type B = [mapping].A
      // TODO how to support value import? currently only type import is supported

      nodes[i] = b.tsTypeAliasDeclaration(
        b.identifier((node.declarations[0].id as t.Identifier).name),
        b.tsTypeReference(
          b.tsQualifiedName(
            b.identifier(
              exportsNames.get(node.declarations[0].init.object.name)!,
            ),
            b.identifier(
              (node.declarations[0].init.property as t.Identifier).name,
            ),
          ),
        ),
      )
    } else if (
      node.type === 'ExportNamedDeclaration' &&
      node.specifiers.length === 1 &&
      node.specifiers[0].type === 'ExportSpecifier' &&
      node.specifiers[0].local.type === 'Identifier' &&
      exportsNames.has(node.specifiers[0].local.name)
    ) {
      // export { a_exports as t }
      // to
      // export { [mapping] as t }
      node.specifiers[0].local.name = exportsNames.get(
        node.specifiers[0].local.name,
      )!
    }
  }

  return nodes
}

/**
 * Rewrites {@link https://www.typescriptlang.org/docs/handbook/modules/reference.html#type-only-imports-and-exports | type-only imports and exports}
 * and special-case syntax ({@link https://www.typescriptlang.org/docs/handbook/modules/reference.html#export--and-import--require | `export = Foo` and `import Foo = require('./bar')`},
 * {@linkcode https://www.typescriptlang.org/docs/handbook/2/modules.html#es-module-syntax | export default Foo})
 * into plain (value) import/export syntax so Rolldown can process them as
 * JavaScript.
 * Handles:
 * - `import type { X } from './bar'` -> `import { X } from './bar'`
 * - `import { type X } from './bar'` -> `import { X } from './bar'`
 * - `export type { X }` -> `export { X }`
 * - `export { type X }` -> `export { X }`
 * - `export type * as X from './bar'` -> `export * as X from './bar'`
 * - `import Foo = require('./bar')` -> `import Foo from './bar'`
 * - `export = Foo` -> `export { Foo as default }`
 * - `export default Foo` -> `export { Foo as default }`
 *
 * @param node - The AST statement node to inspect and (for type-only import/export syntax) rewrite in place.
 * @param set - Callback that replaces {@linkcode node} in its parent's body array; used only for the three declaration forms that must become a different node type.
 * @returns `true` if {@linkcode node} was an `import`/`export` statement that was handled (and should be skipped by the caller), `false` otherwise.
 */
function rewriteImportExport(
  node: t.Node,
  set: (node: t.ProgramStatement) => void,
): node is
  | t.ImportDeclaration
  | t.ExportAllDeclaration
  | t.TSImportEqualsDeclaration {
  if (
    node.type === 'ImportDeclaration' ||
    (node.type === 'ExportNamedDeclaration' && !node.declaration)
  ) {
    for (const specifier of node.specifiers) {
      // rewrite `import { type X } from './bar'` to `import { X } from './bar'`
      if (specifier.type === 'ImportSpecifier') {
        specifier.importKind = 'value'

        // `export { type X }` to `export { X }`
      } else if (specifier.type === 'ExportSpecifier') {
        specifier.exportKind = 'value'
      }
    }

    // rewrite `import type * as X from './bar'` to `import * as X from './bar'`
    if (node.type === 'ImportDeclaration') {
      node.importKind = 'value'

      // rewrite `export type { X }` to `export { X }`
    } else if (node.type === 'ExportNamedDeclaration') {
      node.exportKind = 'value'
    }

    return true

    // rewrite `export type * as X from './bar'` to `export * as X from './bar'`
  } else if (node.type === 'ExportAllDeclaration') {
    node.exportKind = 'value'
    return true

    // `import Foo = require('./bar')` to `import Foo from './bar'`
  } else if (node.type === 'TSImportEqualsDeclaration') {
    if (node.moduleReference.type === 'TSExternalModuleReference') {
      set(
        b.importDeclaration(
          [b.importDefaultSpecifier(node.id)],
          node.moduleReference.expression,
        ),
      )
    }
    return true

    // `export = Foo` to `export { Foo as default }`
  } else if (
    node.type === 'TSExportAssignment' &&
    node.expression.type === 'Identifier'
  ) {
    set(
      b.exportNamedDeclaration(null, [
        b.exportSpecifier(node.expression, b.identifier('default')),
      ]),
    )
    return true

    // `export default Foo` to `export { Foo as default }`
  } else if (
    node.type === 'ExportDefaultDeclaration' &&
    node.declaration.type === 'Identifier'
  ) {
    set(
      b.exportNamedDeclaration(null, [
        b.exportSpecifier(node.declaration, b.identifier('default')),
      ]),
    )
    return true
  }

  return false
}

/**
 * Clears all own properties of {@linkcode node} and assigns
 * {@linkcode newNode}'s properties onto it, effectively mutating the original
 * AST node in place. This preserves any object references that point to
 * {@linkcode node} while changing its content.
 *
 * @template T - The shape of the new node.
 *
 * @param node - The AST node to overwrite.
 * @param newNode - The replacement data to assign.
 * @returns The mutated {@linkcode node} cast to {@linkcode T}.
 */
function overwriteNode<T>(node: t.Node, newNode: T): T {
  // clear object keys
  for (const key of Object.keys(node)) {
    Reflect.deleteProperty(node, key)
  }
  Object.assign(node, newNode)
  return node as T
}

/**
 * Copies leading comments from {@linkcode oldNode} to {@linkcode newNode},
 * keeping only non-reference-directive leading comments and filtering out
 * reference directives from the result.
 *
 * @template T - The shape of the new node.
 *
 * @param oldNode - The original node to copy comments from.
 * @param newNode - The target node to attach comments to.
 * @returns The {@linkcode newNode} with the inherited leading comments applied.
 */
function inheritNodeComments<T extends t.Node>(oldNode: t.Node, newNode: T): T {
  newNode.comments ||= []

  const pragmas = oldNode.comments?.filter(
    (comment) =>
      comment.position === 'before' &&
      comment.value.startsWith('#') &&
      !isSourceMapPragma(comment),
  )
  if (pragmas) {
    newNode.comments.unshift(...pragmas)
  }

  newNode.comments = newNode.comments.filter(
    (comment) =>
      !REFERENCE_RE.test(comment.value) && !isSourceMapPragma(comment),
  )

  return newNode
}

/**
 * Returns (and bumps) the usage count for {@linkcode name} in
 * {@linkcode identifierMap}, returning `0` on the first use.
 *
 * @param identifierMap - Mutable map from identifier base name to usage count.
 * @param name - The identifier base name to look up.
 * @returns The zero-based index for this name.
 */
function getIdentifierIndex(
  identifierMap: Record<string, number>,
  name: string,
): number {
  if (name in identifierMap) {
    return ++identifierMap[name]
  }
  return (identifierMap[name] = 0)
}

/**
 * A compile-time
 * {@link https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-7.html#assertion-functions | assertion}
 * that narrows {@linkcode value} to exclude `false`, `null`, and `undefined`.
 * It performs no runtime check.
 *
 * @template T - The type of the asserted value.
 *
 * @param value - The value to narrow.
 */
export function typeAssert<T>(
  // eslint-disable-next-line unused-imports/no-unused-vars
  value: T,
): asserts value is Exclude<T, false | null | undefined> {}
