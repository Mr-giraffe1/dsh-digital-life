/**
 * Path resolution for the digital-life data root.
 *
 * Deliberately dependency-free: this package is installed into a DSH profile by
 * link, and Node resolves a linked package's bare imports against its REAL path,
 * which is outside the profile's node_modules. Only `node:` builtins are safe.
 */

import { homedir, hostname } from 'node:os'
import { isAbsolute, join, normalize, sep } from 'node:path'

/** Placeholder tokens a portrait/manifest may use instead of absolute paths. */
export const TOKENS = Object.freeze(['DSH_HOME', 'WORKSPACE', 'DATA_ROOT'])

/**
 * Resolve the DSH data home: explicit config, then `$DSH_HOME`, then `~/.dsh`.
 * A blank env var counts as unset (never resolves to the process cwd).
 *
 * @param {string | undefined} configured - explicit path from plugin config.
 * @returns {string} absolute home directory.
 */
export function resolveDshHome(configured) {
  const explicit = typeof configured === 'string' ? configured.trim() : ''
  if (explicit !== '') return normalize(explicit)
  const env = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (env !== '') return normalize(env)
  return join(homedir(), '.dsh')
}

/**
 * Expand `${TOKEN}` placeholders. Unknown tokens are left untouched so a typo
 * surfaces as a literal path fragment instead of silently becoming cwd.
 *
 * @param {string} value - string possibly containing placeholders.
 * @param {Record<string, string>} vars - token values.
 * @returns {string} expanded string.
 */
export function interpolate(value, vars) {
  return String(value).replace(/\$\{([A-Z_]+)\}/g, (match, token) => {
    const replacement = vars[token]
    return typeof replacement === 'string' ? replacement : match
  })
}

/**
 * The data root: `${DSH_HOME}/digital-life` unless config overrides it.
 *
 * @param {object | undefined} config - plugin config.
 * @returns {{ dshHome: string, dataRoot: string }}
 */
export function resolveRoots(config) {
  const dshHome = resolveDshHome(config?.dshHome)
  const raw = typeof config?.dataRoot === 'string' && config.dataRoot.trim() !== ''
    ? config.dataRoot.trim()
    : '${DSH_HOME}/digital-life'
  const dataRoot = normalize(interpolate(raw, { DSH_HOME: dshHome }))
  return { dshHome, dataRoot }
}

/**
 * Reject traversal outside a root. Every path derived from user input passes here.
 *
 * @param {string} root - absolute root directory.
 * @param {string} candidate - absolute candidate path.
 * @returns {boolean} true when candidate is root itself or strictly inside it.
 */
export function isInside(root, candidate) {
  const a = normalize(root)
  const b = normalize(candidate)
  if (a === b) return true
  const prefix = a.endsWith(sep) ? a : a + sep
  return b.startsWith(prefix) && !b.includes('\0')
}

/**
 * Is this an absolute path we can hand to fs?
 *
 * @param {unknown} value - candidate.
 * @returns {boolean} true for a non-empty absolute string.
 */
export function isAbsolutePath(value) {
  return typeof value === 'string' && value.trim() !== '' && isAbsolute(value)
}

/** This machine's name; recorded in the instance lock and manifest.lastHost. */
export function machineName() {
  try {
    return hostname()
  } catch {
    return 'unknown-host'
  }
}
