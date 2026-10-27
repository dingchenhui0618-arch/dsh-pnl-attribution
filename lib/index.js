// Host half of dsh-pnl-attribution.
//
// Job: read the user's holdings file, fetch public quotes, and serve one
// computed snapshot at /dsh-pnl-attribution/state. All attribution maths lives
// in core.js; this file only owns config, I/O, caching and the HTTP route.
//
// No credential is read or written. The original plugin this project was
// inspired by drives a broker web session with a cookie; this implementation
// deliberately does not, and only ever reads the holdings file path below.

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  HOLDINGS_EXAMPLE,
  HOLDINGS_HEADER,
  INDEX_SYMBOL,
  buildSnapshot,
  marketPhase,
  parseHoldings,
} from './core.js'
import { QUOTE_SOURCE, fetchMarketData } from './quotes.js'

export const name = 'dsh-pnl-attribution'
export const inject = ['webServer']

const DEFAULT_REFRESH_MS = 20000
const MIN_REFRESH_MS = 5000
const MAX_REFRESH_MS = 600000

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise(function (resolve) {
    let raw = ''
    req.on('data', function (chunk) {
      raw += chunk
      if (raw.length > 65536) req.destroy()
    })
    req.on('end', function () {
      try {
        resolve(raw.length > 0 ? JSON.parse(raw) : {})
      } catch (error) {
        resolve({})
      }
    })
    req.on('error', function () {
      resolve({})
    })
  })
}

function methodFromUrl(url) {
  const path = String(url || '').split('?')[0]
  const rest = path.replace(/^\/dsh-pnl-attribution\/?/, '')
  return rest || 'state'
}

function clampRefresh(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_REFRESH_MS
  return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, Math.round(number)))
}

function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function failureState(settings, error) {
  const now = Date.now()
  const phase = marketPhase(now)
  const code = error && error.code ? error.code : 'unknown'
  return {
    ok: false,
    generatedAt: now,
    tradeDate: null,
    clock: '',
    phase: { key: phase.key, label: phase.label, canExport: false, trading: phase.trading },
    total: null,
    index: null,
    rows: [],
    leaders: [],
    restCount: 0,
    restPnl: 0,
    summary: null,
    errors: [],
    error: {
      code: code,
      message: String((error && error.message) || error),
    },
    holdings: {
      path: settings.holdingsPath,
      count: 0,
      warnings: [],
    },
    guide: {
      path: settings.holdingsPath,
      header: HOLDINGS_HEADER,
      example: HOLDINGS_EXAMPLE,
    },
    source: QUOTE_SOURCE,
    stale: false,
  }
}

export function apply(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {}
  const home = typeof settings.dshHome === 'string' && settings.dshHome.length > 0 ? settings.dshHome : dshHome()
  const holdingsPath = typeof settings.holdingsPath === 'string' && settings.holdingsPath.length > 0
    ? settings.holdingsPath
    : join(home, 'pnl-attribution', 'holdings.csv')
  const refreshMs = clampRefresh(settings.refreshMs)
  const fetchImpl = typeof settings.fetchImpl === 'function' ? settings.fetchImpl : undefined
  const clock = typeof settings.now === 'function' ? settings.now : Date.now
  const timeoutMs = Number(settings.quoteTimeoutMs) > 0 ? Number(settings.quoteTimeoutMs) : undefined

  let cache = null
  let cacheAt = 0
  let cacheMtime = -1
  let inflight = null

  function holdingsMtime() {
    try {
      return statSync(holdingsPath).mtimeMs
    } catch (error) {
      return -1
    }
  }

  async function collect() {
    let text
    try {
      text = readFileSync(holdingsPath, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw codedError('holdings-missing', '未找到持仓文件：' + holdingsPath)
      }
      throw codedError('holdings-unreadable', '读取持仓文件失败：' + String((error && error.message) || error))
    }

    const parsed = parseHoldings(text, holdingsPath)
    if (parsed.holdings.length === 0) {
      const detail = parsed.errors.length > 0
        ? '（' + parsed.errors.length + ' 行无法解析，首行问题：第 ' + parsed.errors[0].line + ' 行 ' + parsed.errors[0].reason + '）'
        : ''
      throw codedError('holdings-empty', '持仓文件里没有可用记录' + detail + '：' + holdingsPath)
    }

    const market = await fetchMarketData({
      symbols: parsed.holdings.map(function (holding) { return holding.symbol }),
      indexSymbol: INDEX_SYMBOL,
      fetchImpl: fetchImpl,
      timeoutMs: timeoutMs,
    })

    const snapshot = buildSnapshot({
      holdings: parsed.holdings,
      quotesBySymbol: market.quotes,
      indexQuote: market.indexQuote,
      indexPoints: market.indexPoints,
      now: clock(),
      holdingsPath: holdingsPath,
      source: QUOTE_SOURCE,
    })
    snapshot.holdings = {
      path: holdingsPath,
      count: parsed.holdings.length,
      warnings: parsed.errors,
    }
    return snapshot
  }

  function getState(force) {
    const now = Date.now()
    const mtime = holdingsMtime()
    if (!force && cache !== null && now - cacheAt < refreshMs && mtime === cacheMtime) {
      return Promise.resolve(cache)
    }
    if (inflight !== null) return inflight
    inflight = (async function () {
      try {
        const state = await collect()
        cache = state
        cacheAt = Date.now()
        cacheMtime = mtime
        return state
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  async function respondState(force) {
    try {
      return await getState(force)
    } catch (error) {
      if (cache !== null) {
        return Object.assign({}, cache, {
          stale: true,
          error: {
            code: error && error.code ? error.code : 'unknown',
            message: String((error && error.message) || error),
          },
        })
      }
      return failureState({ holdingsPath: holdingsPath }, error)
    }
  }

  // Defensive: if the route contract moves, the card degrades but apply() must
  // not abort, otherwise an unrelated plugin in the graph loses its host half.
  ctx.effect(function () {
    let disposeRoute
    try {
      disposeRoute = ctx.webServer.register({
        kind: 'prefix',
        path: '/dsh-pnl-attribution',
        handler: async function (req, res) {
          try {
            const method = methodFromUrl(req.url)
            if (req.method === 'GET') {
              if (method === 'health') {
                sendJson(res, 200, { ok: true, plugin: name, source: QUOTE_SOURCE, holdingsPath: holdingsPath })
                return
              }
              sendJson(res, 200, await respondState(false))
              return
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            await readBody(req)
            if (method === 'refresh') {
              sendJson(res, 200, await respondState(true))
              return
            }
            sendJson(res, 404, { error: 'unknown method' })
          } catch (error) {
            sendJson(res, 500, { error: String((error && error.message) || error) })
          }
        },
      })
    } catch (error) {
      disposeRoute = undefined
    }
    return function () {
      if (typeof disposeRoute === 'function') disposeRoute()
    }
  })
}
