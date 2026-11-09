// Client-half contract test: fake module loader, fake React, fake cordis context.
// Catches the mistakes that a browser would otherwise only show as a blank panel.

const records = []
let factoryFn = null

globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      if (id !== 'dsh-digital-life') throw new Error(`bad module id: ${id}`)
      factoryFn = factory
    }
  }
}

const styleNodes = []
globalThis.document = {
  head: { appendChild: (node) => styleNodes.push(node) },
  getElementById: (id) => styleNodes.find((n) => n.id === id) ?? null,
  createElement: () => ({ id: '', textContent: '' })
}

const React = {
  createElement: (type, props, ...children) => ({ $$el: true, type, props, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value })
}

const requires = { react: React }
const ctx = {
  effect: (fn, label) => {
    records.push({ kind: 'effect', label })
    return fn()
  },
  slots: {
    inject: (key, cb) => {
      records.push({ kind: 'inject', key })
      cb()
    },
    register: (options, Component) => {
      records.push({ kind: 'register', options, Component })
      return () => {}
    }
  }
}

const failures = []
function check(name, ok, detail = '') {
  if (!ok) failures.push({ name, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

await import('../packages/digital-life/lib/client.js')
check('模块以 dsh-digital-life 注册到 loader', typeof factoryFn === 'function')

const exports = factoryFn((name) => {
  if (!(name in requires)) throw new Error(`unexpected require: ${name}`)
  return requires[name]
})

check('exports.inject 含 slots', Array.isArray(exports.inject) && exports.inject.includes('slots'), JSON.stringify(exports.inject))
check('exports.apply 是函数', typeof exports.apply === 'function')

exports.apply(ctx)

const injects = records.filter((r) => r.kind === 'inject').map((r) => r.key)
check('注入 main', injects.includes('main'), injects.join(','))
check('注入 sidebar.panellist', injects.includes('sidebar.panellist'))

const registrations = records.filter((r) => r.kind === 'register')
const main = registrations.find((r) => r.options.name === 'main')
check('main 注册带 key=digital-life', main?.options?.key === 'digital-life', JSON.stringify(main?.options))
check('main 有组件', typeof main?.Component === 'function')

const entry = registrations.find((r) => r.options.name === 'sidebar.panellist')
check('侧栏条目 id=digital-life', entry?.options?.id === 'digital-life')
check('侧栏条目有中文 label', entry?.options?.label === '书房', String(entry?.options?.label))
check('侧栏条目有 order', Number.isInteger(entry?.options?.order), String(entry?.options?.order))

const glyph = entry.Component({ size: 16, active: true })
check('侧栏图标渲染 svg', glyph?.type === 'svg', String(glyph?.type))
check('侧栏图标吃 size', glyph?.props?.width === 16, String(glyph?.props?.width))

// apply must be re-entrant-safe: a second call registers cleanly, no throw.
let secondThrew = false
try {
  exports.apply(ctx)
} catch (error) {
  secondThrew = true
}
check('apply 可重复调用不抛错', !secondThrew)

// Without React the plugin must skip instead of throwing.
const noReactLoader = globalThis.window.__ModuleLoader__
globalThis.window.__ModuleLoader__ = { load: ({ factory }) => { factoryFn = factory } }
await import('../packages/digital-life/lib/client.js?no-react')
const noReactExports = factoryFn(() => {
  throw new Error('module not found')
})
let threw = false
try {
  noReactExports.apply(ctx)
} catch {
  threw = true
}
check('React 缺席时安静跳过', !threw)

globalThis.window.__ModuleLoader__ = noReactLoader

console.log(failures.length === 0 ? '\nall client checks passed' : `\n${failures.length} failed`)
process.exit(failures.length === 0 ? 0 : 1)
