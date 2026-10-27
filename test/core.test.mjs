// Pure-function coverage for the attribution core: holdings parsing, the
// Shanghai market clock, contribution maths, the numeric summary and the
// assembled snapshot. No network, no harness.

import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  INDEX_SYMBOL,
  buildSnapshot,
  buildSummary,
  computeRows,
  computeTotals,
  fmtAmount,
  fmtPp,
  fmtPrice,
  fmtSignedPct,
  marketOf,
  marketPhase,
  parseHoldings,
  parseHoldingsCsv,
  parseHoldingsJson,
  parseInstrument,
  quoteSymbol,
  rankRows,
  shanghaiClock,
  shanghaiDate,
} from '../src/core.js'

const HOLDINGS = [
  { code: '600519', market: 'sh', symbol: 'sh600519', name: '贵州茅台', shares: 100, cost: 1320 },
  { code: '300750', market: 'sz', symbol: 'sz300750', name: '宁德时代', shares: 400, cost: 245 },
]

const QUOTES = {
  sh600519: { code: '600519', name: '贵州茅台', price: 1355.9, prevClose: 1349.98, changePct: 0.4385, tradeDate: '20261027', at: 1793091000000 },
  sz300750: { code: '300750', name: '宁德时代', price: 233, prevClose: 238, changePct: -2.1008, tradeDate: '20261027', at: 1793091000000 },
}

const INDEX_QUOTE = { code: '000001', name: '上证指数', price: 3648.3, prevClose: 3697.52, changePct: -1.33, tradeDate: '20261027' }

const INDEX_POINTS = [
  { t: '09:30', p: 3698.44 },
  { t: '10:00', p: 3702.1 },
  { t: '11:30', p: 3660.2 },
  { t: '14:00', p: 3655.4 },
  { t: '15:00', p: 3648.3 },
]

function shanghaiIso(text) {
  return Date.parse(text + '+08:00')
}

// ---- parsing --------------------------------------------------------------

test('CSV holdings parse BOM, comments, header, prefixes and blank cost', () => {
  const text = [
    '\uFEFFcode,name,shares,cost',
    '# 备注行',
    '',
    'sh600519,贵州茅台,100,1320.00',
    '300750,宁德时代,400',
    'sz000001,平安银行,1000,10.50',
  ].join('\n')
  const parsed = parseHoldingsCsv(text)
  assert.equal(parsed.errors.length, 0)
  assert.equal(parsed.holdings.length, 3)
  assert.equal(parsed.holdings[0].symbol, 'sh600519')
  assert.equal(parsed.holdings[1].symbol, 'sz300750')
  assert.equal(parsed.holdings[1].cost, null)
  assert.equal(parsed.holdings[2].symbol, 'sz000001')
})

test('CSV holdings accept a Chinese header and report bad rows without dropping the file', () => {
  const text = [
    '代码,名称,数量,成本',
    '600519,贵州茅台,100,1320',
    '60051,坏代码,100,10',
    '600036,招商银行,0,38.6',
    'abc,不是代码,10,1',
    '000858,五粮液,-5,100',
  ].join('\n')
  const parsed = parseHoldingsCsv(text)
  assert.equal(parsed.holdings.length, 1)
  assert.equal(parsed.holdings[0].code, '600519')
  assert.equal(parsed.errors.length, 4)
  assert.deepEqual(parsed.errors.map((entry) => entry.reason), [
    'invalid-code',
    'invalid-shares',
    'invalid-code',
    'invalid-shares',
  ])
})

test('JSON holdings parse an array or a {holdings:[]} wrapper', () => {
  const array = parseHoldingsJson(JSON.stringify([{ code: 'sh600519', name: '贵州茅台', shares: 100, cost: 1320 }]))
  assert.equal(array.holdings.length, 1)
  assert.equal(array.holdings[0].symbol, 'sh600519')
  assert.equal(array.holdings[0].cost, 1320)

  const wrapped = parseHoldingsJson(JSON.stringify({ holdings: [{ symbol: '000858', shares: '200' }] }))
  assert.equal(wrapped.holdings.length, 1)
  assert.equal(wrapped.holdings[0].symbol, 'sz000858')
  assert.equal(wrapped.holdings[0].name, '000858')

  assert.equal(parseHoldingsJson('{oops').errors[0].reason, 'invalid-json')
  assert.equal(parseHoldingsJson('{"rows":[]}').errors[0].reason, 'invalid-shape')
})

test('holdings parser picks JSON by extension and CSV otherwise', () => {
  assert.equal(parseHoldings('[{"code":"600519","shares":100}]', 'C:\\a\\holdings.json').holdings.length, 1)
  assert.equal(parseHoldings('code,name,shares,cost\n600519,贵州茅台,100,1', 'C:\\a\\holdings.csv').holdings.length, 1)
})

test('codes map to the right exchange and quote symbol', () => {
  assert.equal(marketOf('600519'), 'sh')
  assert.equal(marketOf('900901'), 'sh')
  assert.equal(marketOf('000001'), 'sz')
  assert.equal(marketOf('300750'), 'sz')
  assert.equal(marketOf('830799'), 'bj')
  assert.equal(parseInstrument('SH600519').symbol, 'sh600519')
  assert.equal(parseInstrument('sz000001').symbol, 'sz000001')
  assert.equal(parseInstrument('60051'), null)
  assert.equal(quoteSymbol('600519'), 'sh600519')
  assert.equal(quoteSymbol('SZ300750'), 'sz300750')
  assert.equal(quoteSymbol('nope'), '')
})

// ---- market clock ---------------------------------------------------------

test('market phase follows the Shanghai session, not the host timezone', () => {
  const phase = (text) => marketPhase(shanghaiIso(text))
  assert.equal(phase('2026-10-27T08:00:00').key, 'pre')
  assert.equal(phase('2026-10-27T09:20:00').key, 'auction')
  assert.equal(phase('2026-10-27T10:00:00').key, 'morning')
  assert.equal(phase('2026-10-27T12:00:00').key, 'lunch')
  assert.equal(phase('2026-10-27T14:00:00').key, 'afternoon')
  assert.equal(phase('2026-10-27T15:00:00').key, 'closed')
  assert.equal(phase('2026-10-27T16:52:00').key, 'closed')
  assert.equal(phase('2026-10-31T10:00:00').key, 'closed')
  assert.equal(phase('2026-10-31T10:00:00').canExport, true)
  assert.equal(phase('2026-10-27T14:00:00').canExport, false)
  assert.equal(phase('2026-10-27T14:59:00').trading, true)
})

test('Shanghai date and clock label the quote day, not UTC', () => {
  const at = shanghaiIso('2026-10-27T00:30:00')
  assert.equal(shanghaiDate(at), '2026-10-27')
  assert.equal(shanghaiClock(at), '00:30')
})

// ---- formatting -----------------------------------------------------------

test('formatting keeps signs, thousands separators and negative zero clean', () => {
  assert.equal(fmtAmount(1234.5), '+1,234.50')
  assert.equal(fmtAmount(-2000), '-2,000.00')
  assert.equal(fmtAmount(0), '0.00')
  assert.equal(fmtAmount(-0.001), '0.00')
  assert.equal(fmtSignedPct(0.634), '+0.63%')
  assert.equal(fmtSignedPct(-1.336), '-1.34%')
  assert.equal(fmtPp(1.7685), '+1.77pp')
  assert.equal(fmtPrice(3648.3), '3648.30')
})

// ---- attribution ----------------------------------------------------------

test('per-holding P&L, percentage and relative strength use the index close', () => {
  const rows = computeRows(HOLDINGS, QUOTES, -1.33)
  assert.equal(rows.length, 2)
  assert.ok(Math.abs(rows[0].pnl - 592) < 1e-9)
  assert.ok(Math.abs(rows[0].pct - 0.4385) < 0.001)
  assert.ok(Math.abs(rows[0].relative - 1.7685) < 0.001)
  assert.ok(Math.abs(rows[1].pnl + 2000) < 1e-9)
  assert.ok(Math.abs(rows[1].relative - (-0.7708)) < 0.001)
  assert.equal(rows[0].marketValue, 135590)
})

test('a holding without a quote is marked missing and excluded from totals', () => {
  const rows = computeRows(HOLDINGS.concat([{ code: '601318', market: 'sh', symbol: 'sh601318', name: '中国平安', shares: 100 }]), QUOTES, -1.33)
  assert.equal(rows[2].missing, true)
  const total = computeTotals(rows)
  assert.equal(total.count, 2)
  assert.equal(total.pnl, -1408)
  assert.equal(total.up, 1)
  assert.equal(total.down, 1)
  assert.equal(total.beat, 1)
  assert.equal(total.lag, 1)
})

test('ranking sorts by contribution amount and keeps only the top five', () => {
  const many = [
    { code: '600001', name: 'A', shares: 100, symbol: 'sh600001' },
    { code: '600002', name: 'B', shares: 100, symbol: 'sh600002' },
    { code: '600003', name: 'C', shares: 100, symbol: 'sh600003' },
    { code: '600004', name: 'D', shares: 100, symbol: 'sh600004' },
    { code: '600005', name: 'E', shares: 100, symbol: 'sh600005' },
    { code: '600006', name: 'F', shares: 100, symbol: 'sh600006' },
  ]
  const quotes = {}
  many.forEach(function (holding, index) {
    quotes[holding.symbol] = {
      price: 10 + index + 1,
      prevClose: 10,
      changePct: (index + 1) * 10,
      tradeDate: '20261027',
    }
  })
  const rows = computeRows(many, quotes, 0)
  const total = computeTotals(rows)
  const ranked = rankRows(rows, total)
  assert.equal(ranked.leaders.length, 5)
  assert.equal(ranked.leaders[0].name, 'F')
  assert.equal(ranked.leaders[4].name, 'B')
  assert.equal(ranked.rest.length, 1)
  assert.equal(ranked.rest[0].name, 'A')
  assert.equal(ranked.restPnl, 100)
})

// ---- summary --------------------------------------------------------------

test('summary states numbers only, names the extremes and never gives advice', () => {
  const rows = computeRows(HOLDINGS, QUOTES, -1.33)
  const total = computeTotals(rows)
  const ranked = rankRows(rows, total)
  const summary = buildSummary({
    rows: rows,
    total: total,
    index: { changePct: -1.33 },
    date: '2026-10-27',
    leaders: ranked.leaders,
    restPnl: ranked.restPnl,
    restCount: ranked.rest.length,
  })
  assert.match(summary.text, /2026-10-27 收盘/)
  assert.match(summary.text, /组合今日盈亏 -1,408\.00 元（-0\.61%）/)
  assert.match(summary.text, /上证指数 -1\.33%/)
  assert.match(summary.text, /2 只持仓中 1 涨 1 跌/)
  assert.match(summary.text, /1 只跑赢、1 只跑输/)
  assert.match(summary.text, /最大正贡献 贵州茅台 \+592\.00 元/)
  assert.match(summary.text, /最大负贡献 宁德时代 -2,000\.00 元/)
  assert.equal(summary.text.includes('占组合当日盈亏'), false, 'a negative basket does not get a share sentence')
  assert.equal(summary.lines.length, 4)

  const forbidden = ['建议', '买入', '卖出', '加仓', '减仓', '止盈', '止损', '推荐', '看好', '看空', '应该', '值得']
  forbidden.forEach(function (word) {
    assert.equal(summary.text.includes(word), false, 'summary must not contain advice word: ' + word)
  })
})

test('summary omits the negative extreme when every holding is up', () => {
  const rows = computeRows([HOLDINGS[0]], { sh600519: QUOTES.sh600519 }, 0.5)
  const total = computeTotals(rows)
  const ranked = rankRows(rows, total)
  const summary = buildSummary({ rows: rows, total: total, index: { changePct: 0.5 }, date: '2026-10-27', leaders: ranked.leaders, restPnl: 0, restCount: 0 })
  assert.equal(summary.text.includes('最大负贡献'), false)
  assert.match(summary.text, /最大正贡献 贵州茅台/)
  assert.match(summary.text, /占组合当日盈亏 100\.0%/)
})

test('summary handles no usable quotes without inventing numbers', () => {
  const rows = computeRows(HOLDINGS, {}, null)
  const total = computeTotals(rows)
  const summary = buildSummary({ rows: rows, total: total, index: null, date: '2026-10-27', leaders: [], restPnl: 0, restCount: 0 })
  assert.equal(summary.text, '今日没有可用的持仓行情数据。')
})

// ---- snapshot -------------------------------------------------------------

test('snapshot is exportable after the close and carries the chart series', () => {
  const now = shanghaiIso('2026-10-27T16:52:00')
  const state = buildSnapshot({
    holdings: HOLDINGS,
    quotesBySymbol: QUOTES,
    indexQuote: INDEX_QUOTE,
    indexPoints: INDEX_POINTS,
    now: now,
    holdingsPath: 'C:\\demo\\holdings.csv',
  })
  assert.equal(state.ok, true)
  assert.equal(state.phase.key, 'closed')
  assert.equal(state.phase.canExport, true)
  assert.equal(state.tradeDate, '2026-10-27')
  assert.equal(state.index.name, '上证指数')
  assert.equal(state.index.points.length, 5)
  assert.equal(state.leaders.length, 2)
  assert.equal(state.leaders[0].rank, 1)
  assert.equal(state.holdingsPath, 'C:\\demo\\holdings.csv')
  assert.match(state.summary.text, /2026-10-27 收盘/)
  assert.equal(state.errors.length, 0)
})

test('snapshot refuses export before the close and without an index', () => {
  const before = buildSnapshot({
    holdings: HOLDINGS,
    quotesBySymbol: QUOTES,
    indexQuote: INDEX_QUOTE,
    indexPoints: INDEX_POINTS,
    now: shanghaiIso('2026-10-27T14:00:00'),
  })
  assert.equal(before.phase.canExport, false)

  const noIndex = buildSnapshot({
    holdings: HOLDINGS,
    quotesBySymbol: QUOTES,
    indexQuote: null,
    indexPoints: [],
    now: shanghaiIso('2026-10-27T16:52:00'),
  })
  assert.equal(noIndex.index, null)
  assert.equal(noIndex.phase.canExport, false)
  assert.equal(noIndex.summary.text.includes('上证指数'), false)
})

test('snapshot names missing quote rows instead of treating them as zero', () => {
  const state = buildSnapshot({
    holdings: HOLDINGS.concat([{ code: '601318', market: 'sh', symbol: 'sh601318', name: '中国平安', shares: 100 }]),
    quotesBySymbol: QUOTES,
    indexQuote: INDEX_QUOTE,
    indexPoints: INDEX_POINTS,
    now: shanghaiIso('2026-10-27T16:52:00'),
  })
  assert.equal(state.ok, true)
  assert.equal(state.total.count, 2)
  assert.equal(state.errors.length, 1)
  assert.equal(state.errors[0].name, '中国平安')
  assert.equal(state.errors[0].reason, 'no-quote')
})

test('the index symbol constant stays the Shanghai composite', () => {
  assert.equal(INDEX_SYMBOL, 'sh000001')
})
