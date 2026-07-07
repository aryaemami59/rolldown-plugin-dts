import {
  RUNTIME_MODULE_ID,
  type ChunkFileNamesFunction,
  type PreRenderedChunk,
} from 'rolldown'
import { exactRegex } from 'rolldown/filter'
import type { VolarPlugin } from './volar.ts'

/**
 * Matches JavaScript file extensions (`.js`, `.jsx`, `.cjs`, `.mjs`),
 * capturing the `c`/`m` modifier.
 */
export const RE_JS: RegExp = /\.([cm]?)jsx?$/

/**
 * Matches TypeScript file extensions (`.ts`, `.tsx`, `.cts`, `.mts`),
 * capturing the `c`/`m` modifier.
 */
export const RE_TS: RegExp = /\.([cm]?)tsx?$/

/**
 * Matches TypeScript declaration file extensions (`.d.ts`, `.d.cts`,
 * `.d.mts`), capturing the `c`/`m` modifier.
 */
export const RE_DTS: RegExp = /\.d\.([cm]?)ts$/

/**
 * Matches declaration map file extensions (`.d.ts.map`, `.d.cts.map`,
 * `.d.mts.map`), capturing the `c`/`m` modifier.
 */
export const RE_DTS_MAP: RegExp = /\.d\.([cm]?)ts\.map$/

/**
 * Matches paths that contain a `node_modules` segment, with either `/` or
 * `\` as the separator.
 */
export const RE_NODE_MODULES: RegExp = /[\\/]node_modules[\\/]/

/**
 * Matches style sheet file extensions (`.css`, `.scss`, `.sass`, `.less`,
 * `.styl`, `.stylus`).
 */
export const RE_CSS: RegExp = /\.(?:css|scss|sass|less|styl|stylus)$/

/**
 * Matches the `.json` file extension.
 */
export const RE_JSON: RegExp = /\.json$/

/**
 * Matches exactly Rolldown's runtime module id
 * ({@linkcode RUNTIME_MODULE_ID}).
 */
export const RE_ROLLDOWN_RUNTIME: RegExp = exactRegex(RUNTIME_MODULE_ID)

/**
 * Converts a JavaScript filename into its declaration filename, preserving
 * the `c`/`m` modifier (e.g. `foo.js` becomes `foo.d.ts`, `foo.cjs` becomes
 * `foo.d.cts`).
 *
 * @param id - The JavaScript filename to convert.
 * @returns The corresponding declaration filename.
 */
export function filename_js_to_dts(id: string): string {
  return id.replace(RE_JS, '.d.$1ts')
}

/**
 * Converts any supported source filename (TypeScript, JavaScript, Vue, or
 * JSON) into its declaration filename (e.g. `foo.ts` becomes `foo.d.ts`,
 * `foo.vue` becomes `foo.vue.d.ts`, `foo.json` becomes `foo.json.d.ts`).
 *
 * @param id - The source filename to convert.
 * @returns The corresponding declaration filename.
 */
export function filename_to_dts(id: string, volarPlugin?: VolarPlugin): string {
  id = volarPlugin?.toTsFilename?.(id) ?? id
  return id
    .replace(RE_TS, '.d.$1ts')
    .replace(RE_JS, '.d.$1ts')
    .replace(RE_JSON, '.json.d.ts')
}

/**
 * Converts a declaration filename back into a source filename with the given
 * extension kind, preserving the `c`/`m` modifier (e.g. `foo.d.cts` with
 * `'js'` becomes `foo.cjs`).
 *
 * @param id - The declaration filename to convert.
 * @param ext - The target extension kind, either `'js'` or `'ts'`.
 * @returns The corresponding source filename.
 */
export function filename_dts_to(id: string, ext: 'js' | 'ts'): string {
  return id.replace(RE_DTS, `.$1${ext}`)
}

/**
 * Resolves a Rolldown file-name template to a string. If {@linkcode fn} is a
 * {@linkcode ChunkFileNamesFunction | function}, it is called with
 * {@linkcode chunk}; otherwise the string template is returned as-is.
 *
 * @param fn - The file-name template string or function to resolve.
 * @param chunk - The {@linkcode PreRenderedChunk | chunk} passed to a template function.
 * @returns The resolved file-name template string.
 */
export function resolveTemplateFn(
  fn: string | ChunkFileNamesFunction,
  chunk: PreRenderedChunk,
): string {
  return typeof fn === 'function' ? fn(chunk) : fn
}

/**
 * Replaces every `[name]` placeholder in a file-name template with the given
 * name.
 *
 * @param template - The file-name template containing `[name]` placeholders.
 * @param name - The value to substitute for `[name]`.
 * @returns The template with all `[name]` placeholders replaced.
 */
export function replaceTemplateName(template: string, name: string): string {
  return template.replaceAll('[name]', name)
}
