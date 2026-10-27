// Host-half tests. These drive the real apply() against a stub ctx and a stub
// fetch, so the card's data contract, cache, stale fallback and runtime unload
// are pinned without a network or a running harness.

import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/host.js'
import { MINUTE_BASE, QUOTE_BASE } from '../src/quotes.js'

const NOW = Date.parse('2026-10-27T16:52:00+08:00')

const HOLDINGS_CSV = [
  'code,name,shares,cost',
  '600519,贵州茅台,100,1320.00',
  '300750,宁德时代,400,245.00',
  '601318,中国平安,1200,48.20',
  '000858,五粮液,500,128.50',
  '002594,比亚迪,300,310.00',
  '600036,招商银行,1500,38.60',
  '601899,紫金矿业,2000,18.90',
  '000651,格力电器,1000,42.30',
].join('\n')

const PRICES = {
  sh600519: [1355.9, 1349.98],
  sz300750: [233, 238],
  sh601318: [50, 48.2],
  sz000858: [130, 128.5],
  sz002594: [315, 310],
  sh600036: [39.5, 38.6],
  sh601899: [20, 18.9],
  sz000651: [41, 42.3],
}

function quoteLine(symbol, price, prevClose, pct) {
  const cells = new Array(56).fill('')
  cells[0] = '1'
  cells[1] = symbol
  cells[2] = symbol.slice(2)
  cells[3] = price.toFixed(2)
  cells[4] = prevClose.toFixed(2)
  cells[5] = prevClose.toFixed(2)
  cells[30] = '20261027150000'
  cells[31] = (price - prevClose).toFixed(2)
  cells[32] = pct.toFixed(2)
  return 'v_' + symbol + '="' + cells.join('~') + '";'
}

function quoteBody(state) {
  const lines = []
  Object.keys(PRICES).forEach(function (symbol) {
    if (state.missing === symbol) return
    const pair = PRICES[symbol]
    lines.push(quoteLine(symbol, pair[0], pair[1], ((pair[0] / pair[1]) - 1) * 100))
  })
  if (state.missingIndex !== true) lines.push(quoteLine('sh000001', 3648.3, 3697.52, -1.33))
  return lines.join('\n')
}

const MINUTE_JSON = {
  data: {
    sh000001: {
      data: {
        date: '20261027',
        data: ['0930 3698.44 1 2', '1030 3701.20 1 2', '1130 3660.20 1 2', '1400 3655.40 1 2', '1500 3648.30 1 2'],
      },
    },
  },
}

function marketFetch(state) {
  const calls = []
  const fetchImpl = async function (url) {
    calls.push(url)
    if (state.fail === true) throw new Error('socket closed')
    if (url.startsWith(QUOTE_BASE)) {
      return {
        ok: true,
        status: 200,
        async arrayBuffer() { return Buffer.from(quoteBody(state), 'latin1') },
      }
    }
    if (url.startsWith(MINUTE_BASE)) {
      return { ok: true, status: 200, async json() { return MINUTE_JSON } }
    }
    throw new Error('unexpected URL: ' + url)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'pnl-attribution-'))
  const holdingsPath = join(home, 'holdings.csv')
  writeFileSync(holdingsPath, HOLDINGS_CSV, 'utf8')
  return { home: home, holdingsPath: holdingsPath }
}

function setup(options) {
  const settings = options || {}
  const routes = []
  const disposers = []
  const webServer = {
    register(route) {
      if (settings.registerThrows === true) throw new Error('webServer.register is unavailable')
      routes.push(route)
      return function () {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
  const ctx = {
    webServer: webServer,
    get() { return undefined },
    on() {},
    effect(fn) {
      const dispose = fn()
      disposers.push(typeof dispose === 'function' ? dispose : function () {})
      return dispose
    },
  }
  const home = settings.home || makeHome()
  const fetchImpl = settings.fetchImpl || marketFetch(settings.fetchState || {})
  apply(ctx, {
    holdingsPath: home.holdingsPath,
    refreshMs: settings.refreshMs === undefined ? 20000 : settings.refreshMs,
    now: function () { return NOW },
    fetchImpl: fetchImpl,
  })

  return {
    home: home,
    routes: routes,
    fetchImpl: fetchImpl,
    dispose() {
      const pending = disposers.splice(0)
      pending.forEach(function (dispose) { dispose() })
    },
    async call(method, url) {
      assert.equal(routes.length, 1, 'the state route is registered')
      const route = routes[0]
      const req = new EventEmitter()
      req.method = method
      req.url = url
      const res = {
        statusCode: 0,
        headers: {},
        setHeader(key, value) { this.headers[key] = value },
        end(text) {
          this.body = JSON.parse(text)
          this.done = true
        },
      }
      const pending = new Promise(function (resolve) {
        const timer = setTimeout(function () { resolve(res) }, 2000)
        res.end = function (text) {
          this.body = JSON.parse(text)
          clearTimeout(timer)
          resolve(this)
        }
      })
      route.handler(req, res)
      setImmediate(function () { req.emit('end') })
      return pending
    },
  }
}

test('the state route assembles the leaderboard, summary and export gate', async () => {
  const h = setup()
  const res = await h.call('GET', '/dsh-pnl-attribution/state')
  assert.equal(res.statusCode, 200)
  const state = res.body
  assert.equal(state.ok, true)
  assert.equal(state.phase.key, 'closed')
  assert.equal(state.phase.canExport, true)
  assert.equal(state.tradeDate, '2026-10-27')
  assert.equal(state.holdings.count, 8)
  assert.equal(state.total.count, 8)
  assert.equal(state.total.pnl, 5252)
  assert.equal(state.total.up, 6)
  assert.equal(state.total.down, 2)
  assert.equal(state.leaders.length, 5)
  assert.equal(state.leaders[0].name, '紫金矿业')
  assert.equal(state.leaders[4].name, '五粮液')
  assert.equal(state.index.points.length, 5)
  assert.match(state.summary.text, /组合今日盈亏 \+5,252\.00 元/)
  assert.equal(state.errors.length, 0)
  assert.match(state.summary.text, /上证指数 -1\.33%/)
})

test('the cache serves a second poll without another network call, and refresh forces it', async () => {
  const h = setup()
  await h.call('GET', '/dsh-pnl-attribution/state')
  assert.equal(h.fetchImpl.calls.length, 2)
  await h.call('GET', '/dsh-pnl-attribution/state')
  assert.equal(h.fetchImpl.calls.length, 2, 'cached poll did not fetch')
  const refreshed = await h.call('POST', '/dsh-pnl-attribution/refresh')
  assert.equal(refreshed.body.ok, true)
  assert.equal(h.fetchImpl.calls.length, 4, 'force refresh fetched quotes and the series again')
})

test('a failed refresh keeps the last good snapshot and marks it stale', async () => {
  const state = { fail: false }
  const h = setup({ fetchState: state })
  await h.call('GET', '/dsh-pnl-attribution/state')
  state.fail = true
  const res = await h.call('POST', '/dsh-pnl-attribution/refresh')
  assert.equal(res.body.ok, true, 'old data is still served')
  assert.equal(res.body.stale, true)
  assert.match(res.body.error.message, /socket closed/)
  assert.equal(res.body.total.pnl, 5252)
})

test('a missing holdings file returns a setup guide instead of throwing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pnl-attribution-missing-'))
  const h = setup({ home: { home: home, holdingsPath: join(home, 'holdings.csv') } })
  const res = await h.call('GET', '/dsh-pnl-attribution/state')
  assert.equal(res.body.ok, false)
  assert.equal(res.body.error.code, 'holdings-missing')
  assert.match(res.body.error.message, /holdings\.csv/)
  assert.equal(res.body.guide.header, 'code,name,shares,cost')
  assert.match(res.body.guide.example, /600519,贵州茅台,100,1320\.00/)
  assert.equal(h.fetchImpl.calls.length, 0, 'no network call without holdings')
})

test('an empty holdings file explains the parse failure', async () => {
  const home = makeHome()
  writeFileSync(home.holdingsPath, 'code,name,shares,cost\n# nothing here\n', 'utf8')
  const h = setup({ home: home })
  const res = await h.call('GET', '/dsh-pnl-attribution/state')
  assert.equal(res.body.ok, false)
  assert.equal(res.body.error.code, 'holdings-empty')
})

test('one missing quote does not zero-fill the holding', async () => {
  const h = setup({ fetchState: { missing: 'sh601318' } })
  const res = await h.call('GET', '/dsh-pnl-attribution/state')
  assert.equal(res.body.ok, true)
  assert.equal(res.body.total.count, 7)
  assert.equal(res.body.errors.length, 1)
  assert.equal(res.body.errors[0].name, '中国平安')
  assert.equal(res.body.leaders.length, 5)
  assert.equal(res.body.holdings.warnings.length, 0)
})

test('a first fetch failure returns a structured error state', async () => {
  const h = setup({ fetchState: { fail: true } })
  const res = await h.call('GET', '/dsh-pnl-attribution/state')
  assert.equal(res.body.ok, false)
  assert.match(res.body.error.message, /socket closed/)
  assert.equal(res.body.holdings.count, 0)
})

test('an index quote failure is reported rather than silently drawing an empty chart', async () => {
  const h = setup({ fetchState: { missingIndex: true } })
  const res = await h.call('GET', '/dsh-pnl-attribution/state')
  assert.equal(res.body.ok, false)
  assert.match(res.body.error.message, /index quote missing/)
})

test('editing the holdings file busts the cache through its mtime', async () => {
  const home = makeHome()
  const h = setup({ home: home })
  const first = await h.call('GET', '/dsh-pnl-attribution/state')
  assert.equal(first.body.total.count, 8)

  writeFileSync(home.holdingsPath, 'code,name,shares,cost\n600519,贵州茅台,100,1320.00\n', 'utf8')
  utimesSync(home.holdingsPath, new Date(), new Date(Date.now() + 5000))
  const second = await h.call('GET', '/dsh-pnl-attribution/state')
  assert.equal(second.body.total.count, 1)
  assert.equal(second.body.holdings.warnings.length, 0)
})

test('the health route exposes the configured path without touching the network', async () => {
  const h = setup()
  const res = await h.call('GET', '/dsh-pnl-attribution/health')
  assert.equal(res.body.ok, true)
  assert.equal(res.body.plugin, 'dsh-pnl-attribution')
  assert.match(res.body.holdingsPath, /holdings\.csv$/)
  assert.equal(h.fetchImpl.calls.length, 0)
})

test('unknown POST methods are 404, not a silent success', async () => {
  const h = setup()
  const res = await h.call('POST', '/dsh-pnl-attribution/export')
  assert.equal(res.statusCode, 404)
})

test('unloading removes the route', () => {
  const h = setup()
  assert.equal(h.routes.length, 1)
  h.dispose()
  assert.equal(h.routes.length, 0)
})

test('a webServer that refuses to register does not abort apply()', () => {
  const home = makeHome()
  assert.doesNotThrow(function () { setup({ home: home, registerThrows: true }) })
})

test('the plugin only ever calls the two documented quote hosts', async () => {
  const h = setup()
  await h.call('GET', '/dsh-pnl-attribution/state')
  h.fetchImpl.calls.forEach(function (url) {
    assert.ok(url.startsWith(QUOTE_BASE) || url.startsWith(MINUTE_BASE), 'unexpected host: ' + url)
  })
})
