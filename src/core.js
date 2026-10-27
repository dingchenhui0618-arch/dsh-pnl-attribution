// Pure, side-effect-free attribution core for dsh-pnl-attribution.
//
// Everything in this file is deterministic: holdings parsing, market phase,
// contribution maths and the numeric closing summary. The host half only
// fetches quotes and hands them here, which keeps the interesting logic
// testable without a network or a running harness.

export const TIME_ZONE = 'Asia/Shanghai'
export const MAX_LEADERS = 5
export const INDEX_SYMBOL = 'sh000001'
export const INDEX_NAME = '上证指数'

export const HOLDINGS_HEADER = 'code,name,shares,cost'
export const HOLDINGS_EXAMPLE = [
  HOLDINGS_HEADER,
  '600519,贵州茅台,100,1320.00',
  '300750,宁德时代,400,245.00',
  '000858,五粮液,500,128.50',
].join('\n')

const CSV_HEADER = /^(?:code|代码|证券代码)\s*[,，\t]\s*(?:name|名称|证券名称)\s*[,，\t]\s*(?:shares|qty|quantity|数量|持股数)\s*(?:[,，\t]\s*(?:cost|成本|成本价))?$/i
const SYMBOL_RE = /^(?:(sh|sz|bj))?(\d{6})$/i

const AMOUNT_FORMAT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const SHARE_FORMAT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function cleanCell(value) {
  return String(value === undefined || value === null ? '' : value)
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .trim()
}

// A-share market prefixes accepted by the public quote endpoint.
export function marketOf(code) {
  const digits = String(code || '').replace(/\D/g, '')
  if (digits.length !== 6) return ''
  if (/^(4|8|92)/.test(digits)) return 'bj'
  if (/^(5|6|9)/.test(digits)) return 'sh'
  return 'sz'
}

// Accepts "600519", "sh600519" or "SH600519" and returns a normalised
// instrument, or null when the value is not a six-digit code.
export function parseInstrument(raw) {
  const match = String(raw === undefined || raw === null ? '' : raw).trim().match(SYMBOL_RE)
  if (!match) return null
  const code = match[2]
  const market = match[1] ? match[1].toLowerCase() : marketOf(code)
  if (!market) return null
  return { code: code, market: market, symbol: market + code }
}

export function quoteSymbol(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase()
  if (/^(sh|sz|bj)\d{6}$/.test(text)) return text
  const instrument = parseInstrument(text)
  return instrument ? instrument.symbol : ''
}

// ---- holdings input -------------------------------------------------------
// The card is deliberately broker-agnostic: it reads a flat holdings file that
// any export can be massaged into, instead of driving a broker web session.

export function parseHoldingsCsv(text) {
  const holdings = []
  const errors = []
  const lines = String(text === undefined || text === null ? '' : text)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
  let headerSkipped = false

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim()
    if (raw.length === 0 || raw.startsWith('#')) continue
    if (!headerSkipped && CSV_HEADER.test(raw)) {
      headerSkipped = true
      continue
    }
    const cells = raw.split(/[,，\t]/).map(cleanCell)
    const instrument = parseInstrument(cells[0])
    if (instrument === null) {
      errors.push({ line: index + 1, reason: 'invalid-code', value: cells[0] || raw })
      continue
    }
    const shares = Number(cells[2])
    if (!finite(shares) || shares <= 0) {
      errors.push({ line: index + 1, reason: 'invalid-shares', value: cells[2] || '' })
      continue
    }
    const cost = cells[3] === '' || cells[3] === undefined ? null : Number(cells[3])
    holdings.push({
      code: instrument.code,
      market: instrument.market,
      symbol: instrument.symbol,
      name: cells[1] && cells[1].length > 0 ? cells[1] : instrument.code,
      shares: shares,
      cost: finite(cost) && cost > 0 ? cost : null,
    })
  }
  return { holdings: holdings, errors: errors }
}

export function parseHoldingsJson(text) {
  const holdings = []
  const errors = []
  let parsed
  try {
    parsed = JSON.parse(String(text || '').replace(/^\uFEFF/, ''))
  } catch (error) {
    return { holdings: holdings, errors: [{ line: 0, reason: 'invalid-json' }] }
  }
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.holdings) ? parsed.holdings : null)
  if (list === null) return { holdings: holdings, errors: [{ line: 0, reason: 'invalid-shape' }] }

  list.forEach(function (entry, index) {
    if (entry === null || typeof entry !== 'object') {
      errors.push({ line: index + 1, reason: 'invalid-row' })
      return
    }
    const instrument = parseInstrument(entry.code !== undefined ? entry.code : entry.symbol)
    if (instrument === null) {
      errors.push({ line: index + 1, reason: 'invalid-code', value: entry.code })
      return
    }
    const shares = Number(entry.shares)
    if (!finite(shares) || shares <= 0) {
      errors.push({ line: index + 1, reason: 'invalid-shares', value: entry.shares })
      return
    }
    const cost = Number(entry.cost)
    holdings.push({
      code: instrument.code,
      market: instrument.market,
      symbol: instrument.symbol,
      name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : instrument.code,
      shares: shares,
      cost: finite(cost) && cost > 0 ? cost : null,
    })
  })
  return { holdings: holdings, errors: errors }
}

export function parseHoldings(text, filePath) {
  const path = String(filePath || '').toLowerCase()
  if (path.endsWith('.json')) return parseHoldingsJson(text)
  return parseHoldingsCsv(text)
}

// ---- market clock ---------------------------------------------------------

function shanghaiParts(nowMs) {
  const date = nowMs instanceof Date ? nowMs : new Date(nowMs)
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const bag = {}
  parts.forEach(function (part) { bag[part.type] = part.value })
  const hour = Number(bag.hour)
  const minute = Number(bag.minute)
  return {
    weekday: bag.weekday,
    minutes: (finite(hour) ? hour : 0) * 60 + (finite(minute) ? minute : 0),
  }
}

export function marketPhase(nowMs) {
  const clock = shanghaiParts(nowMs)
  const weekend = clock.weekday === 'Sat' || clock.weekday === 'Sun'
  if (weekend) {
    return { key: 'closed', label: '周末休市', canExport: true, trading: false, minutes: clock.minutes }
  }
  const minutes = clock.minutes
  if (minutes < 9 * 60 + 15) {
    return { key: 'pre', label: '盘前', canExport: false, trading: false, minutes: minutes }
  }
  if (minutes < 9 * 60 + 30) {
    return { key: 'auction', label: '集合竞价', canExport: false, trading: true, minutes: minutes }
  }
  if (minutes <= 11 * 60 + 30) {
    return { key: 'morning', label: '上午盘', canExport: false, trading: true, minutes: minutes }
  }
  if (minutes < 13 * 60) {
    return { key: 'lunch', label: '午间休市', canExport: false, trading: false, minutes: minutes }
  }
  if (minutes < 15 * 60) {
    return { key: 'afternoon', label: '下午盘', canExport: false, trading: true, minutes: minutes }
  }
  return { key: 'closed', label: '已收盘', canExport: true, trading: false, minutes: minutes }
}

export function shanghaiDate(nowMs) {
  const date = nowMs instanceof Date ? nowMs : new Date(nowMs)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const bag = {}
  parts.forEach(function (part) { bag[part.type] = part.value })
  return bag.year + '-' + bag.month + '-' + bag.day
}

export function shanghaiClock(nowMs) {
  const date = nowMs instanceof Date ? nowMs : new Date(nowMs)
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const bag = {}
  parts.forEach(function (part) { bag[part.type] = part.value })
  return bag.hour + ':' + bag.minute
}

// ---- formatting -----------------------------------------------------------

export function fmtAmount(value) {
  if (!finite(value)) return '—'
  const rounded = Math.abs(value) < 0.005 ? 0 : value
  const sign = rounded > 0 ? '+' : (rounded < 0 ? '-' : '')
  return sign + AMOUNT_FORMAT.format(Math.abs(rounded))
}

export function fmtSignedPct(value, digits) {
  if (!finite(value)) return '—'
  const rounded = Math.abs(value) < 0.00005 ? 0 : value
  const sign = rounded > 0 ? '+' : (rounded < 0 ? '-' : '')
  return sign + Math.abs(rounded).toFixed(digits === undefined ? 2 : digits) + '%'
}

export function fmtPct(value, digits) {
  if (!finite(value)) return '—'
  const rounded = Math.abs(value) < 0.00005 ? 0 : value
  return rounded.toFixed(digits === undefined ? 2 : digits) + '%'
}

export function fmtShare(value) {
  if (!finite(value)) return '—'
  return SHARE_FORMAT.format(Math.abs(value) < 0.05 ? 0 : value) + '%'
}

export function fmtPp(value) {
  if (!finite(value)) return '—'
  const rounded = Math.abs(value) < 0.005 ? 0 : value
  const sign = rounded > 0 ? '+' : (rounded < 0 ? '-' : '')
  return sign + Math.abs(rounded).toFixed(2) + 'pp'
}

export function fmtPrice(value, digits) {
  if (!finite(value)) return '—'
  return value.toFixed(digits === undefined ? 2 : digits)
}

// ---- attribution ----------------------------------------------------------

function dateText(value) {
  if (typeof value !== 'string' || value.length !== 8) return ''
  return value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6, 8)
}

export function computeRows(holdings, quotesBySymbol, indexPct) {
  return holdings.map(function (holding) {
    const quote = quotesBySymbol ? quotesBySymbol[holding.symbol] : undefined
    if (quote === undefined || quote === null || !finite(quote.price) || !finite(quote.prevClose) || quote.prevClose <= 0) {
      return {
        code: holding.code,
        name: holding.name,
        symbol: holding.symbol,
        shares: holding.shares,
        cost: holding.cost,
        missing: true,
      }
    }
    const prevValue = holding.shares * quote.prevClose
    const marketValue = holding.shares * quote.price
    const pnl = marketValue - prevValue
    const pct = (quote.price / quote.prevClose - 1) * 100
    return {
      code: holding.code,
      name: holding.name,
      symbol: holding.symbol,
      shares: holding.shares,
      cost: holding.cost,
      price: quote.price,
      prevClose: quote.prevClose,
      open: finite(quote.open) ? quote.open : null,
      pnl: pnl,
      pct: pct,
      relative: finite(indexPct) ? pct - indexPct : null,
      prevValue: prevValue,
      marketValue: marketValue,
      at: finite(quote.at) ? quote.at : null,
      tradeDate: dateText(quote.tradeDate),
      missing: false,
    }
  })
}

export function computeTotals(rows) {
  const total = {
    pnl: 0,
    pct: null,
    prevValue: 0,
    marketValue: 0,
    count: 0,
    up: 0,
    down: 0,
    flat: 0,
    beat: 0,
    lag: 0,
  }
  rows.forEach(function (row) {
    if (row.missing) return
    total.count += 1
    total.pnl += row.pnl
    total.prevValue += row.prevValue
    total.marketValue += row.marketValue
    if (row.pct > 0.0001) total.up += 1
    else if (row.pct < -0.0001) total.down += 1
    else total.flat += 1
    if (finite(row.relative) && row.relative > 0.0001) total.beat += 1
    else if (finite(row.relative) && row.relative < -0.0001) total.lag += 1
  })
  total.pct = total.prevValue > 0 ? (total.pnl / total.prevValue) * 100 : null
  return total
}

export function rankRows(rows, total) {
  const valid = rows.filter(function (row) { return !row.missing }).slice()
  valid.sort(function (a, b) {
    if (b.pnl !== a.pnl) return b.pnl - a.pnl
    return a.code.localeCompare(b.code)
  })
  const leaders = valid.slice(0, MAX_LEADERS).map(function (row, index) {
    return Object.assign({}, row, {
      rank: index + 1,
      weight: total.marketValue > 0 ? (row.marketValue / total.marketValue) * 100 : null,
      share: total.pnl !== 0 ? (row.pnl / total.pnl) * 100 : null,
    })
  })
  const rest = valid.slice(MAX_LEADERS)
  const restPnl = rest.reduce(function (sum, row) { return sum + row.pnl }, 0)
  return { leaders: leaders, rest: rest, restPnl: restPnl }
}

export function buildSummary(input) {
  const rows = input.rows
  const total = input.total
  const index = input.index
  const date = input.date || ''
  const valid = rows.filter(function (row) { return !row.missing })
  const leaders = input.leaders || []

  if (valid.length === 0) {
    return {
      date: date,
      lines: ['今日没有可用的持仓行情数据。'],
      text: '今日没有可用的持仓行情数据。',
    }
  }

  const topPnl = leaders.reduce(function (sum, row) { return sum + row.pnl }, 0)
  const topShare = total.pnl !== 0 ? (topPnl / total.pnl) * 100 : null
  const positives = valid.filter(function (row) { return row.pnl > 0 })
  const negatives = valid.filter(function (row) { return row.pnl < 0 })
  positives.sort(function (a, b) { return b.pnl - a.pnl })
  negatives.sort(function (a, b) { return a.pnl - b.pnl })
  const best = positives.length > 0 ? positives[0] : null
  const worst = negatives.length > 0 ? negatives[0] : null
  const lines = []

  const indexPart = index && finite(index.changePct) ? '，' + INDEX_NAME + ' ' + fmtSignedPct(index.changePct) : ''
  lines.push(date + ' 收盘，组合今日盈亏 ' + fmtAmount(total.pnl) + ' 元（' + fmtSignedPct(total.pct) + '）' + indexPart + '。')

  const flatPart = total.flat > 0 ? ' ' + total.flat + ' 平' : ''
  const relativePart = finite(index && index.changePct)
    ? '；相对' + INDEX_NAME + ' ' + total.beat + ' 只跑赢、' + total.lag + ' 只跑输'
    : ''
  lines.push(valid.length + ' 只持仓中 ' + total.up + ' 涨 ' + total.down + ' 跌' + flatPart + relativePart + '。')

  const extremes = []
  if (best !== null) extremes.push('最大正贡献 ' + best.name + ' ' + fmtAmount(best.pnl) + ' 元')
  if (worst !== null) extremes.push('最大负贡献 ' + worst.name + ' ' + fmtAmount(worst.pnl) + ' 元')
  if (extremes.length > 0) {
    // Only quote the share when the basket and its top five point the same
    // way; "占组合当日盈亏 -262%" is arithmetic, not a sentence a reader can
    // use. On a down day the two totals are enough.
    const sharePart = total.pnl > 0 && topShare !== null ? '，占组合当日盈亏 ' + fmtShare(topShare) : ''
    // Keep the two extremes on their own line: a comma inside an amount such
    // as "-2,000.00" is a line-break trap for the PNG's character wrapper.
    lines.push('贡献前五合计 ' + fmtAmount(topPnl) + ' 元' + sharePart + '。')
    lines.push(extremes.join('，') + '。')
  }

  if (input.restPnl !== undefined && input.restPnl !== null && input.restCount > 0) {
    lines.push('其余 ' + input.restCount + ' 只合计 ' + fmtAmount(input.restPnl) + ' 元。')
  }

  return { date: date, lines: lines, text: lines.join('') }
}

export function buildSnapshot(input) {
  const now = finite(input.now) ? input.now : Date.now()
  const holdings = Array.isArray(input.holdings) ? input.holdings : []
  const quotes = input.quotesBySymbol || {}
  const indexQuote = input.indexQuote || null
  const indexPct = indexQuote && finite(indexQuote.changePct) ? indexQuote.changePct : null
  const phase = marketPhase(now)
  const rows = computeRows(holdings, quotes, indexPct)
  const total = computeTotals(rows)
  const ranked = rankRows(rows, total)
  const date = indexQuote && indexQuote.tradeDate
    ? dateText(indexQuote.tradeDate) || shanghaiDate(now)
    : shanghaiDate(now)
  const points = Array.isArray(input.indexPoints) ? input.indexPoints : []
  const summary = buildSummary({
    rows: rows,
    total: total,
    index: indexQuote ? { changePct: indexQuote.changePct } : null,
    date: date,
    leaders: ranked.leaders,
    restPnl: ranked.restPnl,
    restCount: ranked.rest.length,
  })
  const valid = total.count > 0
  const index = indexQuote
    ? {
      symbol: INDEX_SYMBOL,
      code: indexQuote.code || '000001',
      name: INDEX_NAME,
      price: indexQuote.price,
      prevClose: indexQuote.prevClose,
      changePct: indexQuote.changePct,
      points: points,
      tradeDate: date,
      at: finite(indexQuote.at) ? indexQuote.at : null,
    }
    : null

  const errors = []
  rows.forEach(function (row) {
    if (row.missing) errors.push({ code: row.code, name: row.name, reason: 'no-quote' })
  })

  return {
    ok: valid,
    generatedAt: now,
    tradeDate: date,
    clock: shanghaiClock(now),
    phase: {
      key: phase.key,
      label: phase.label,
      canExport: phase.canExport && valid && index !== null && points.length > 1,
      trading: phase.trading,
    },
    total: total,
    index: index,
    rows: rows,
    leaders: ranked.leaders,
    restCount: ranked.rest.length,
    restPnl: ranked.restPnl,
    summary: summary,
    errors: errors,
    holdingsPath: input.holdingsPath || '',
    source: input.source || 'tencent-quote',
    stale: false,
  }
}
