// Quote adapter coverage: GBK decoding, the Tencent field layout, the minute
// series, and the failure paths the card has to survive.

import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  MINUTE_BASE,
  QUOTE_BASE,
  decodeQuoteBody,
  fetchMarketData,
  fetchMinuteTrend,
  fetchQuotes,
  parseMinutePayload,
  parseQuotePayload,
  parseQuoteRecord,
} from '../src/quotes.js'

function fields(overrides) {
  const cells = new Array(56).fill('')
  cells[0] = '1'
  cells[1] = 'MOUTAI'
  cells[2] = '600519'
  cells[3] = '1355.90'
  cells[4] = '1349.98'
  cells[5] = '1343.88'
  cells[30] = '20261027150500'
  cells[31] = '5.92'
  cells[32] = '0.44'
  Object.keys(overrides || {}).forEach(function (key) { cells[Number(key)] = overrides[key] })
  return cells.join('~')
}

function quoteResponse(body) {
  return {
    ok: true,
    status: 200,
    async arrayBuffer() {
      return Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'latin1')
    },
  }
}

function jsonResponse(value) {
  return { ok: true, status: 200, async json() { return value } }
}

test('GBK quote bodies decode to the Chinese display name', () => {
  const bytes = Buffer.from([0xb9, 0xf3, 0xd6, 0xdd, 0xc3, 0xa9, 0xcc, 0xa8])
  assert.equal(decodeQuoteBody(bytes), '贵州茅台')
})

test('a Tencent quote record maps price, previous close, timestamp and percent', () => {
  const record = parseQuoteRecord('sh600519', fields())
  assert.equal(record.price, 1355.9)
  assert.equal(record.prevClose, 1349.98)
  assert.equal(record.changePct, 0.44)
  assert.equal(record.tradeDate, '20261027')
  assert.equal(record.time, '15:05')
  assert.equal(record.at, Date.parse('2026-10-27T15:05:00+08:00'))
})

test('a quote record with no usable price is dropped, not zero-filled', () => {
  assert.equal(parseQuoteRecord('sh600519', fields({ 3: '0' })), null)
  assert.equal(parseQuoteRecord('sh600519', fields({ 4: '' })), null)
  assert.equal(parseQuoteRecord('sh600519', 'short'), null)
})

test('quote payload parses every v_ line and ignores unrelated text', () => {
  const text = [
    'v_sh600519="' + fields() + '";',
    'v_sz300750="' + fields({ 1: 'CATL', 2: '300750', 3: '233.00', 4: '238.00', 31: '-5.00', 32: '-2.10' }) + '";',
    'v_pv_none_match="1";',
  ].join('\n')
  const quotes = parseQuotePayload(text)
  assert.deepEqual(Object.keys(quotes).sort(), ['sh600519', 'sz300750'])
  assert.equal(quotes.sz300750.changePct, -2.1)
})

test('fetchQuotes dedupes symbols, batches and decodes the response', async () => {
  const urls = []
  const body = 'v_sh600519="' + fields() + '";'
  const fetchImpl = async function (url) {
    urls.push(url)
    return quoteResponse(body)
  }
  const quotes = await fetchQuotes(['600519', 'sh600519', '600519'], { fetchImpl: fetchImpl })
  assert.deepEqual(urls, [QUOTE_BASE + 'sh600519'])
  assert.equal(quotes.sh600519.price, 1355.9)
})

test('fetchQuotes splits more than 60 symbols into several requests', async () => {
  let calls = 0
  const fetchImpl = async function () {
    calls += 1
    return quoteResponse('')
  }
  const symbols = Array.from({ length: 61 }, function (_, index) {
    return String(600000 + index)
  })
  await fetchQuotes(symbols, { fetchImpl: fetchImpl })
  assert.equal(calls, 2)
})

test('fetchQuotes refuses an HTTP error instead of returning an empty map', async () => {
  await assert.rejects(
    fetchQuotes(['600519'], { fetchImpl: async function () { return { ok: false, status: 502 } } }),
    /HTTP 502/,
  )
})

test('the minute payload keeps the 09:30-15:00 series and its trade date', () => {
  const payload = {
    data: {
      sh000001: {
        data: {
          date: '20261027',
          data: ['0930 3698.44 3461176 5877302815.70', '1130 3660.20 1 2', '1500 3648.30 417789532 672414398244.30'],
        },
      },
    },
  }
  const parsed = parseMinutePayload('sh000001', payload)
  assert.equal(parsed.tradeDate, '20261027')
  assert.deepEqual(parsed.points, [
    { t: '09:30', p: 3698.44 },
    { t: '11:30', p: 3660.2 },
    { t: '15:00', p: 3648.3 },
  ])
  assert.equal(parseMinutePayload('sh000001', { data: {} }), null)
})

test('fetchMinuteTrend requests the index and rejects a payload without a series', async () => {
  const urls = []
  const parsed = await fetchMinuteTrend('sh000001', {
    fetchImpl: async function (url) {
      urls.push(url)
      return jsonResponse({ data: { sh000001: { data: { date: '20261027', data: ['1500 3648.30 1 2'] } } } })
    },
  })
  assert.equal(urls[0], MINUTE_BASE + 'sh000001')
  assert.equal(parsed.points.length, 1)

  await assert.rejects(
    fetchMinuteTrend('sh000001', { fetchImpl: async function () { return jsonResponse({ data: {} }) } }),
    /minute series missing/,
  )
})

test('fetchMarketData always asks for the index and returns quote plus series', async () => {
  const urls = []
  const fetchImpl = async function (url) {
    urls.push(url)
    if (url.startsWith(QUOTE_BASE)) {
      return quoteResponse('v_sh600519="' + fields() + '";\nv_sh000001="' + fields({ 1: 'INDEX', 2: '000001', 3: '3648.30', 4: '3697.52', 31: '-49.22', 32: '-1.33' }) + '";')
    }
    return jsonResponse({ data: { sh000001: { data: { date: '20261027', data: ['0930 3698.44 1 2', '1500 3648.30 1 2'] } } } })
  }
  const market = await fetchMarketData({ symbols: ['sh600519'], fetchImpl: fetchImpl })
  assert.equal(urls.length, 2)
  assert.match(urls[0], /sh600519,sh000001/)
  assert.equal(market.indexQuote.changePct, -1.33)
  assert.equal(market.indexPoints.length, 2)
  assert.equal(market.tradeDate, '20261027')
})

test('fetchMarketData fails when the index quote is absent', async () => {
  const fetchImpl = async function (url) {
    if (url.startsWith(QUOTE_BASE)) return quoteResponse('v_sh600519="' + fields() + '";')
    return jsonResponse({ data: { sh000001: { data: { date: '20261027', data: ['1500 3648.30 1 2'] } } } })
  }
  await assert.rejects(fetchMarketData({ symbols: ['sh600519'], fetchImpl: fetchImpl }), /index quote missing/)
})
