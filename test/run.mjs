/**
 * Test runner. No dependencies: each suite is a plain ESM script that exits
 * non-zero on failure.
 *
 *   node test/run.mjs            store + client (no DSH needed)
 *   node test/run.mjs --live     ... plus the live HTTP/SSE/lock suite, which
 *                                needs a running DSH with the plugin loaded
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const live = process.argv.includes('--live')

const suites = [
  ['store', join(here, 'store.test.mjs')],
  ['memory', join(here, 'memory.test.mjs')],
  ['life', join(here, 'life.test.mjs')],
  ['lunar', join(here, 'lunar.test.mjs')],
  ['outreach', join(here, 'outreach.test.mjs')],
  ['feed', join(here, 'feed.test.mjs')],
  ['qq', join(here, 'qq.test.mjs')],
  ['archive', join(here, 'archive.test.mjs')],
  ['exchange', join(here, 'exchange.test.mjs')],
  ['turn', join(here, 'turn.test.mjs')],
  ['generate', join(here, 'generate.test.mjs')],
  ['engine', join(here, 'engine.test.mjs')],
  ['client', join(here, 'client.test.mjs')]
]
if (live) suites.push(['http (live)', join(here, 'http.test.mjs')])

let failed = 0
for (const [label, file] of suites) {
  console.log(`\n=== ${label} ===`)
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { stdio: 'inherit' })
    // A suite that cannot even be spawned (EPERM inside a sandbox, a missing
    // file) emits `error` and never `exit`, which used to hang the runner with
    // no child process alive and nothing in the log. Fail loudly instead.
    child.on('error', (error) => {
      console.error(`!! ${label} 起不来：${String(error?.message ?? error)}`)
      resolve(1)
    })
    child.on('exit', (value) => resolve(value ?? 1))
  })
  if (code !== 0) failed += 1
}

console.log(`\n${failed === 0 ? 'ALL SUITES PASSED' : `${failed} SUITE(S) FAILED`}`)
process.exit(failed === 0 ? 0 : 1)
