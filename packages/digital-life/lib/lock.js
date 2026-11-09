/**
 * Single-instance lock.
 *
 * A digital life opened twice splits into two of her. This refuses to run rather
 * than run two copies silently — the refusal is a state the UI reports, not a
 * crash, so DSH itself keeps working.
 */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { machineName } from './paths.js'

/** A lock older than this whose owner cannot be probed is treated as stale. */
const HEARTBEAT_STALE_MS = 5 * 60 * 1000

/** @param {number} pid - process id. @returns {boolean} */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

/** Read the lock body; null when absent or unparsable. */
async function readLock(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null
    return { corrupt: true }
  }
}

/**
 * Who currently holds this data root, according to the lock file.
 *
 * @param {string} path - lock file path.
 * @returns {Promise<null | { pid: number, hostname: string, startedAt: string, heartbeatAt: string, corrupt?: boolean }>}
 */
export async function peek(path) {
  return readLock(path)
}

/**
 * Acquire the lock, or explain who holds it.
 *
 * @param {string} path - lock file path.
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'held-by-live-process' | 'foreign-host', holder: object }>}
 */
export async function acquire(path) {
  const holder = await readLock(path)
  if (holder !== null) {
    const sameHost = holder.hostname === machineName()
    const alive = sameHost && isProcessAlive(holder.pid)
    if (alive && holder.pid !== process.pid) {
      return { ok: false, reason: 'held-by-live-process', holder }
    }
    let mtime = 0
    try {
      mtime = (await stat(path)).mtimeMs
    } catch {
      mtime = 0
    }
    const stale = Date.now() - mtime > HEARTBEAT_STALE_MS
    if (!sameHost && !holder.corrupt) {
      // A different machine's name in the lock means the root was copied while
      // running. Its pid may well exist here, so never trust it — but a fresh
      // heartbeat from another host is a real conflict.
      if (!stale && Date.parse(holder.heartbeatAt ?? holder.startedAt ?? '') > Date.now() - HEARTBEAT_STALE_MS) {
        return { ok: false, reason: 'foreign-host', holder }
      }
    }
  }
  const body = {
    pid: process.pid,
    hostname: machineName(),
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString()
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  return { ok: true }
}

/**
 * Start a heartbeat that keeps the lock fresh and marks it stale on dispose.
 *
 * @param {string} path - lock file path.
 * @returns {{ stop: () => Promise<void>, timer: NodeJS.Timeout }}
 */
export function heartbeat(path) {
  const body = {
    pid: process.pid,
    hostname: machineName(),
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString()
  }
  const tick = async () => {
    try {
      body.heartbeatAt = new Date().toISOString()
      await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
    } catch {
      /* heartbeat failure must never take the life down */
    }
  }
  const timer = setInterval(tick, 30_000)
  if (typeof timer.unref === 'function') timer.unref()
  return {
    timer,
    stop: async () => {
      clearInterval(timer)
      try {
        await rm(path, { force: true })
      } catch {
        /* nothing to clean */
      }
    }
  }
}
