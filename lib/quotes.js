// Quote adapter for dsh-pnl-attribution.
//
// Uses the public Tencent quote endpoints because they answer a plain Node
// HTTPS request without a login, a cookie or a broker session:
//
//   https://qt.gtimg.cn/q=sh600519                  (GBK, one line per symbol)
//   https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=sh000001
//
// The plugin never sends a credential anywhere. The only network input is the
// list of six-digit codes read from the user's own holdings file.

import { quoteSymbol } from './core.js'

export const QUOTE_BASE = 'https://qt.gtimg.cn/q='
export const MINUTE_BASE = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code='
export const QUOTE_SOURCE = 'tencent-quote'
const CHUNK = 60
const TIMEOUT_MS = 9000

const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-pnl-attribution',
  accept: '*/*',
}

function defaultFetch() {
  if (typeof globalThis.fetch !== 'function') throw new Error('fetch is unavailable in this host')
  return globalThis.fetch
}

function signalOf(timeoutMs) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs)
  }
  return undefined
}

// The endpoint answers GBK. Full-ICU Node decodes it correctly; on a build
// without the GBK decoder the numeric fields are still ASCII, so falling back
// to latin1 keeps the maths intact and only costs the display name — which
// comes from the holdings file anyway.
export function decodeQuoteBody(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || 0)
  try {
    return new TextDecoder('gbk').decode(bytes)
  } catch (error) {
    return Buffer.from(bytes).toString('latin1')
  }
}

function epochFromTencentStamp(stamp) {
  if (!/^\d{14}$/.test(stamp)) return null
  const iso = stamp.slice(0, 4) + '-' + stamp.slice(4, 6) + '-' + stamp.slice(6, 8) +
    'T' + stamp.slice(8, 10) + ':' + stamp.slice(10, 12) + ':' + stamp.slice(12, 14) + '+08:00'
  const value = Date.parse(iso)
  return Number.isFinite(value) ? value : null
}

export function parseQuoteRecord(symbol, body) {
  const fields = String(body || '').split('~')
  if (fields.length < 35) return null
  const price = Number(fields[3])
  const prevClose = Number(fields[4])
  if (!Number.isFinite(price) || price <= 0) return null
  if (!Number.isFinite(prevClose) || prevClose <= 0) return null
  const stamp = fields[30] || ''
  const change = Number(fields[31])
  const rawPct = Number(fields[32])
  const changePct = Number.isFinite(rawPct) ? rawPct : (price / prevClose - 1) * 100
  return {
    symbol: symbol,
    code: String(fields[2] || symbol.replace(/^[a-z]+/, '')).padStart(6, '0'),
    name: String(fields[1] || ''),
    price: price,
    prevClose: prevClose,
    open: Number.isFinite(Number(fields[5])) ? Number(fields[5]) : null,
    change: Number.isFinite(change) ? change : price - prevClose,
    changePct: changePct,
    at: epochFromTencentStamp(stamp),
    tradeDate: /^\d{8}/.test(stamp) ? stamp.slice(0, 8) : '',
    time: stamp.length >= 12 ? stamp.slice(8, 10) + ':' + stamp.slice(10, 12) : '',
  }
}

export function parseQuotePayload(text) {
  const quotes = {}
  const pattern = /v_([a-z]{2}\d{6})="([^"]*)"/g
  let match
  while ((match = pattern.exec(String(text || ''))) !== null) {
    const record = parseQuoteRecord(match[1], match[2])
    if (record !== null) quotes[record.symbol] = record
  }
  return quotes
}

export async function fetchQuotes(symbols, options) {
  const settings = options || {}
  const fetchImpl = settings.fetchImpl || defaultFetch()
  const timeoutMs = Number(settings.timeoutMs) > 0 ? Number(settings.timeoutMs) : TIMEOUT_MS
  const unique = Array.from(new Set((Array.isArray(symbols) ? symbols : []).map(quoteSymbol).filter(Boolean)))
  const quotes = {}

  for (let start = 0; start < unique.length; start += CHUNK) {
    const chunk = unique.slice(start, start + CHUNK)
    const response = await fetchImpl(QUOTE_BASE + chunk.join(','), {
      headers: HEADERS,
      signal: signalOf(timeoutMs),
    })
    if (!response || response.ok === false) {
      throw new Error('quote request failed: HTTP ' + (response ? response.status : 'no response'))
    }
    const buffer = await response.arrayBuffer()
    Object.assign(quotes, parseQuotePayload(decodeQuoteBody(buffer)))
  }
  return quotes
}

export function parseMinutePayload(symbol, payload) {
  const bucket = payload && payload.data ? payload.data[symbol] : null
  const series = bucket && bucket.data ? bucket.data.data : null
  if (!Array.isArray(series)) return null
  const points = []
  series.forEach(function (line) {
    const cells = String(line || '').trim().split(/\s+/)
    if (cells.length < 2) return
    const stamp = cells[0]
    const price = Number(cells[1])
    if (!/^\d{4}$/.test(stamp) || !Number.isFinite(price) || price <= 0) return
    points.push({ t: stamp.slice(0, 2) + ':' + stamp.slice(2), p: price })
  })
  if (points.length === 0) return null
  const date = bucket.data.date && /^\d{8}$/.test(String(bucket.data.date)) ? String(bucket.data.date) : ''
  return { symbol: symbol, points: points, tradeDate: date }
}

export async function fetchMinuteTrend(symbol, options) {
  const settings = options || {}
  const fetchImpl = settings.fetchImpl || defaultFetch()
  const timeoutMs = Number(settings.timeoutMs) > 0 ? Number(settings.timeoutMs) : TIMEOUT_MS
  const target = quoteSymbol(symbol)
  const response = await fetchImpl(MINUTE_BASE + target, {
    headers: HEADERS,
    signal: signalOf(timeoutMs),
  })
  if (!response || response.ok === false) {
    throw new Error('minute request failed: HTTP ' + (response ? response.status : 'no response'))
  }
  const payload = await response.json()
  const parsed = parseMinutePayload(target, payload)
  if (parsed === null) throw new Error('minute series missing for ' + target)
  return parsed
}

// One call site for the host: batch quotes plus the index intraday series.
export async function fetchMarketData(input) {
  const settings = input || {}
  const indexSymbol = settings.indexSymbol || 'sh000001'
  const symbols = (settings.symbols || []).slice()
  if (!symbols.includes(indexSymbol)) symbols.push(indexSymbol)
  const quotes = await fetchQuotes(symbols, settings)
  const indexQuote = quotes[indexSymbol]
  if (indexQuote === undefined) throw new Error('index quote missing: ' + indexSymbol)
  const trend = await fetchMinuteTrend(indexSymbol, settings)
  return { quotes: quotes, indexQuote: indexQuote, indexPoints: trend.points, tradeDate: trend.tradeDate }
}
