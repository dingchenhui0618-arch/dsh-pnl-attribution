// Client half of dsh-pnl-attribution: a floating contribution card plus a
// canvas-rendered closing-summary PNG.
//
// Must stay CommonJS — the build wraps this in window.__ModuleLoader__.load()
// and React is supplied by the harness.
//
// The host is the single source of truth: this half only polls
// /dsh-pnl-attribution/state and draws it. The PNG is produced locally from
// that same JSON, so exporting never needs another network call.

const React = require('react')
const h = React.createElement
const CSS = require('./client-css.cjs')

const API = '/dsh-pnl-attribution'
const POLL_MS = 20000
const COLLAPSE_KEY = 'dsh-pnl-attribution:collapsed'

// ---- poller ---------------------------------------------------------------
// Module-level poller shared by every mounted card. The host caches too, so a
// poll normally costs one cheap local request; the export path never polls.

let snap = { data: null, error: '', at: 0 }
const listeners = new Set()
let timer = null

function emit() {
  Array.from(listeners).forEach(function (fn) {
    try {
      fn(snap)
    } catch (error) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-pnl-attribution] listener failed', error)
    }
  })
}

function accept(data) {
  snap = { data: data, error: '', at: Date.now() }
  emit()
}

function load() {
  return fetch(API + '/state', { headers: { accept: 'application/json' } })
    .then(function (res) { return res.json() })
    .then(function (data) { accept(data) })
    .catch(function (error) {
      snap = { data: snap.data, error: String((error && error.message) || error), at: Date.now() }
      emit()
    })
}

function refresh() {
  return fetch(API + '/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
    .then(function (res) { return res.json() })
    .then(function (data) { accept(data); return data })
    .catch(function (error) {
      snap = { data: snap.data, error: String((error && error.message) || error), at: Date.now() }
      emit()
    })
}

function subscribe(fn) {
  listeners.add(fn)
  if (timer === null) {
    load()
    timer = setInterval(load, POLL_MS)
  }
  fn(snap)
  return function () {
    listeners.delete(fn)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

// ---- formatting -----------------------------------------------------------

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function grouped(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function amount(value) {
  if (!finite(value)) return '—'
  const rounded = Math.abs(value) < 0.005 ? 0 : value
  const sign = rounded > 0 ? '+' : (rounded < 0 ? '-' : '')
  return sign + grouped(Math.abs(rounded).toFixed(2))
}

function pct(value, digits) {
  if (!finite(value)) return '—'
  const rounded = Math.abs(value) < 0.00005 ? 0 : value
  const sign = rounded > 0 ? '+' : (rounded < 0 ? '-' : '')
  return sign + Math.abs(rounded).toFixed(digits === undefined ? 2 : digits) + '%'
}

function plainPct(value, digits) {
  if (!finite(value)) return '—'
  return (Math.abs(value) < 0.00005 ? 0 : value).toFixed(digits === undefined ? 2 : digits) + '%'
}

function pp(value) {
  if (!finite(value)) return '—'
  const rounded = Math.abs(value) < 0.005 ? 0 : value
  const sign = rounded > 0 ? '+' : (rounded < 0 ? '-' : '')
  return sign + Math.abs(rounded).toFixed(2) + 'pp'
}

function price(value) {
  return finite(value) ? value.toFixed(2) : '—'
}

function tone(value) {
  if (!finite(value) || Math.abs(value) < 0.00005) return 'pa-flat'
  return value > 0 ? 'pa-up' : 'pa-down'
}

function clockOf(ms) {
  if (!finite(ms)) return ''
  const date = new Date(ms)
  const pad = function (n) { return n < 10 ? '0' + n : String(n) }
  return pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function readCollapsed() {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch (error) {
    return false
  }
}

function writeCollapsed(value) {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0')
  } catch (error) {
    // private mode / storage disabled: collapse still works for this mount
  }
}

// ---- small view pieces ----------------------------------------------------

function Spark(props) {
  const points = Array.isArray(props.points) ? props.points : []
  if (points.length < 2) return null
  const width = 106
  const height = 30
  const pad = 1.5
  const values = points.map(function (point) { return point.p })
  if (finite(props.prevClose)) values.push(props.prevClose)
  let min = Math.min.apply(null, values)
  let max = Math.max.apply(null, values)
  if (max - min < 1e-9) {
    min -= 1
    max += 1
  }
  const xOf = function (index) { return pad + (index / (points.length - 1)) * (width - pad * 2) }
  const yOf = function (value) { return pad + ((max - value) / (max - min)) * (height - pad * 2) }
  let d = ''
  points.forEach(function (point, index) {
    d += (index === 0 ? 'M' : 'L') + xOf(index).toFixed(2) + ' ' + yOf(point.p).toFixed(2) + ' '
  })
  const area = d + 'L' + xOf(points.length - 1).toFixed(2) + ' ' + height + ' L' + xOf(0).toFixed(2) + ' ' + height + ' Z'
  const up = !finite(props.changePct) || props.changePct >= 0
  const color = up ? '#e5484d' : '#18a06a'
  const baseY = finite(props.prevClose) ? yOf(props.prevClose) : null
  return h('svg', { className: 'pa-spark', viewBox: '0 0 ' + width + ' ' + height, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
    h('path', { className: 'pa-spark-area', d: area, fill: color }),
    baseY !== null ? h('line', { className: 'pa-spark-base', x1: 0, y1: baseY, x2: width, y2: baseY }) : null,
    h('path', { className: 'pa-spark-line', d: d, stroke: color }),
  )
}

function LeaderRow(props) {
  const row = props.row
  const maxAbs = props.maxAbs
  const ratio = maxAbs > 0 ? Math.min(1, Math.abs(row.pnl) / maxAbs) : 0
  const width = Math.max(2, ratio * 100)
  return h('div', { className: 'pa-row' },
    h('span', { className: 'pa-rank' }, String(row.rank)),
    h('div', { className: 'pa-name' },
      row.name,
      h('span', { className: 'pa-code' }, row.code),
    ),
    h('span', { className: 'pa-value ' + tone(row.pnl) }, amount(row.pnl)),
    h('div', { className: 'pa-bar ' + tone(row.pnl) },
      h('i', { style: { width: width + '%' } }),
    ),
    h('span', { className: 'pa-rel ' + tone(row.relative) },
      finite(row.relative) ? '相对 ' + pp(row.relative) : '相对 —',
    ),
  )
}

function EmptyCard(props) {
  const data = props.data
  const guide = (data && data.guide) || { path: '', header: 'code,name,shares,cost', example: '' }
  const message = data && data.error ? data.error.message : ''
  return h('div', { className: 'pa-empty' },
    h('h4', null, '持仓贡献榜'),
    h('p', null, message || '还没有读到持仓数据。把券商或同花顺导出的持仓整理成下面三列。'),
    h('div', { className: 'pa-path' }, guide.path || '~/.dsh/pnl-attribution/holdings.csv'),
    h('pre', null, guide.example || (guide.header + '\n600519,贵州茅台,100,1320.00')),
    h('div', { className: 'pa-actions' },
      h('span', { className: 'pa-updated' }, '改完文件后点刷新'),
      h('button', { className: 'pa-btn', type: 'button', onClick: function () { refresh() } }, '刷新'),
    ),
  )
}

function Card(props) {
  const data = props.data
  const onCollapse = props.onCollapse
  const [busy, setBusy] = React.useState(false)
  const total = data.total || {}
  const index = data.index || null
  const leaders = Array.isArray(data.leaders) ? data.leaders : []
  const maxAbs = leaders.reduce(function (max, row) { return Math.max(max, Math.abs(row.pnl || 0)) }, 0)
  const stale = data.stale === true
  const canExport = !!(data.phase && data.phase.canExport)
  const upd = clockOf(data.generatedAt)

  function doRefresh() {
    setBusy(true)
    refresh().then(function () { setBusy(false) }, function () { setBusy(false) })
  }

  function doExport() {
    try {
      downloadReport(data)
    } catch (error) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-pnl-attribution] export failed', error)
    }
  }

  return h('div', { className: 'pa-card' },
    h('div', { className: 'pa-head' },
      h('div', { className: 'pa-brand' },
        h('span', { className: 'pa-mark', 'aria-hidden': 'true' }, '↗'),
        '持仓贡献榜',
      ),
      h('span', { className: 'pa-phase' + (data.phase && data.phase.trading ? ' pa-live' : '') }, data.phase ? data.phase.label : ''),
      h('span', { className: 'pa-spacer' }),
      h('button', { className: 'pa-icon-btn', type: 'button', title: '刷新', 'aria-label': '刷新', onClick: doRefresh, disabled: busy }, busy ? '…' : '↻'),
      h('button', { className: 'pa-icon-btn', type: 'button', title: '收起', 'aria-label': '收起', onClick: onCollapse }, '—'),
    ),
    stale && data.error ? h('div', { className: 'pa-stale' }, '行情刷新失败，显示上次数据：' + data.error.message) : null,
    h('div', { className: 'pa-total' },
      h('div', { className: 'pa-label' }, '今日盈亏'),
      h('div', null,
        h('span', { className: 'pa-amount ' + tone(total.pnl) }, amount(total.pnl)),
        h('span', { className: 'pa-pct ' + tone(total.pct) }, pct(total.pct)),
      ),
    ),
    index ? h('div', { className: 'pa-index' },
      h('div', null,
        h('div', { className: 'pa-index-name' }, index.name),
        h('div', null,
          h('span', { className: 'pa-index-val' }, price(index.price)),
          h('span', { className: 'pa-index-chg ' + tone(index.changePct) }, pct(index.changePct)),
        ),
      ),
      h(Spark, { points: index.points, prevClose: index.prevClose, changePct: index.changePct }),
    ) : null,
    h('div', { className: 'pa-board' },
      h('div', { className: 'pa-board-head' },
        h('b', null, '贡献前五'),
        h('span', null, '相对上证'),
      ),
      leaders.length === 0
        ? h('div', { className: 'pa-note' }, '暂无可用行情。')
        : leaders.map(function (row) {
          return h(LeaderRow, { key: row.symbol + '-' + row.rank, row: row, maxAbs: maxAbs })
        }),
    ),
    h('div', { className: 'pa-note' },
      (data.holdings ? data.holdings.count : total.count) + ' 只持仓 · 前五合计 ' + amount((leaders || []).reduce(function (sum, row) { return sum + row.pnl }, 0)) +
      (data.restCount > 0 ? ' · 其余 ' + data.restCount + ' 只 ' + amount(data.restPnl) : ''),
    ),
    h('div', { className: 'pa-actions' },
      h('span', { className: 'pa-updated' }, upd + ' 更新' + (stale ? ' · 缓存' : '')),
      h('button', { className: 'pa-btn', type: 'button', onClick: doRefresh, disabled: busy }, busy ? '刷新中' : '刷新'),
      h('button', {
        className: 'pa-btn pa-primary',
        type: 'button',
        disabled: !canExport,
        title: canExport ? '导出含贡献榜、分时图和自动摘要的收盘小结 PNG' : '15:00 收盘后可导出',
        onClick: doExport,
      }, '导出小结'),
    ),
  )
}

function Pill(props) {
  const data = props.data
  const total = (data && data.total) || {}
  return h('button', {
    className: 'pa-pill ' + tone(total.pnl),
    type: 'button',
    onClick: props.onExpand,
    title: '展开持仓贡献榜',
  },
    h('span', { className: 'pa-dot', 'aria-hidden': 'true' }),
    h('span', null, '贡献榜'),
    h('b', null, amount(total.pnl)),
  )
}

function Root() {
  const [state, setState] = React.useState(snap)
  const [collapsed, setCollapsed] = React.useState(readCollapsed)
  React.useEffect(function () { return subscribe(setState) }, [])

  const data = state.data
  function collapse() {
    setCollapsed(true)
    writeCollapsed(true)
  }
  function expand() {
    setCollapsed(false)
    writeCollapsed(false)
  }

  if (data === null) {
    return h('div', { className: 'pa-root' },
      h('div', { className: 'pa-empty' },
        h('h4', null, '持仓贡献榜'),
        h('p', null, state.error ? '读取失败：' + state.error : '正在读取持仓与行情…'),
      ),
    )
  }

  if (collapsed) {
    return h('div', { className: 'pa-root' }, h(Pill, { data: data, onExpand: expand }))
  }

  if (data.ok !== true) {
    return h('div', { className: 'pa-root' }, h(EmptyCard, { data: data }))
  }

  return h('div', { className: 'pa-root' }, h(Card, { data: data, onCollapse: collapse }))
}

// ---- closing-summary PNG --------------------------------------------------
// Fixed dark report, A-share red-up/green-down. 1080x1680 at 2x for crisp
// text when the PNG is forwarded into a chat group.

const REPORT = {
  width: 1080,
  height: 1680,
  margin: 60,
  bg: '#0b0d11',
  panel: '#14171d',
  line: 'rgba(255,255,255,0.07)',
  text: '#f2f4f7',
  muted: '#8d939e',
  dim: '#606671',
  up: '#ff5a5f',
  down: '#1fbd7a',
  font: '"PingFang SC","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif',
}

function reportFont(size, weight) {
  return String(weight || 400) + ' ' + size + 'px ' + REPORT.font
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

function fillRound(ctx, x, y, width, height, radius, fill) {
  roundRect(ctx, x, y, width, height, radius)
  ctx.fillStyle = fill
  ctx.fill()
}

function reportTone(value) {
  if (!finite(value) || Math.abs(value) < 0.00005) return REPORT.muted
  return value > 0 ? REPORT.up : REPORT.down
}

function reportAmount(value) {
  return amount(value)
}

function reportPct(value) {
  return pct(value)
}

function fitText(ctx, text, maxWidth) {
  let out = String(text)
  if (ctx.measureText(out).width <= maxWidth) return out
  while (out.length > 1 && ctx.measureText(out + '…').width > maxWidth) out = out.slice(0, -1)
  return out + '…'
}

function wrapText(ctx, text, maxWidth) {
  const lines = []
  let line = ''
  String(text).split('').forEach(function (char) {
    const next = line + char
    if (line.length > 0 && ctx.measureText(next).width > maxWidth) {
      lines.push(line)
      line = char
    } else {
      line = next
    }
  })
  if (line.length > 0) lines.push(line)
  return lines
}

function drawReport(data) {
  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = REPORT.width * scale
  canvas.height = REPORT.height * scale
  const ctx = canvas.getContext('2d')
  ctx.scale(scale, scale)
  ctx.textBaseline = 'alphabetic'

  // background
  const bg = ctx.createLinearGradient(0, 0, 0, REPORT.height)
  bg.addColorStop(0, '#0d1015')
  bg.addColorStop(0.55, '#0b0d11')
  bg.addColorStop(1, '#0a0c10')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, REPORT.width, REPORT.height)
  const glow = ctx.createRadialGradient(880, 80, 10, 880, 80, 520)
  glow.addColorStop(0, 'rgba(229,72,77,0.11)')
  glow.addColorStop(1, 'rgba(229,72,77,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, REPORT.width, 760)

  const index = data.index || null
  const total = data.total || {}
  const leaders = Array.isArray(data.leaders) ? data.leaders : []
  const dateLabel = data.tradeDate || ''

  // header
  ctx.fillStyle = REPORT.muted
  ctx.font = reportFont(21, 600)
  ctx.fillText('DSH · 持仓贡献榜', REPORT.margin, 72)
  ctx.textAlign = 'right'
  ctx.font = reportFont(21, 500)
  ctx.fillStyle = REPORT.dim
  ctx.fillText(dateLabel + ' · ' + (data.phase ? data.phase.label : ''), REPORT.width - REPORT.margin, 72)
  ctx.textAlign = 'left'

  ctx.fillStyle = REPORT.text
  ctx.font = reportFont(50, 700)
  ctx.fillText('收盘小结', REPORT.margin, 152)

  if (index) {
    const chipText = '上证指数 ' + reportPct(index.changePct)
    ctx.font = reportFont(22, 600)
    const chipWidth = ctx.measureText(chipText).width + 28
    fillRound(ctx, REPORT.width - REPORT.margin - chipWidth, 118, chipWidth, 38, 19, 'rgba(255,90,95,0.10)')
    ctx.fillStyle = reportTone(index.changePct)
    ctx.fillText(chipText, REPORT.width - REPORT.margin - chipWidth + 14, 144)
  }

  // total block
  ctx.fillStyle = REPORT.muted
  ctx.font = reportFont(20, 500)
  ctx.fillText('今日盈亏', REPORT.margin, 224)
  ctx.fillStyle = reportTone(total.pnl)
  ctx.font = reportFont(78, 700)
  const amountText = reportAmount(total.pnl)
  ctx.fillText(amountText, REPORT.margin, 312)
  const amountWidth = ctx.measureText(amountText).width
  ctx.font = reportFont(26, 600)
  ctx.fillStyle = reportTone(total.pct)
  ctx.fillText(reportPct(total.pct), REPORT.margin + amountWidth + 18, 300)

  ctx.textAlign = 'right'
  ctx.font = reportFont(20, 500)
  ctx.fillStyle = REPORT.muted
  ctx.fillText('组合 ' + reportPct(total.pct) + ' · 上证 ' + (index ? reportPct(index.changePct) : '—'), REPORT.width - REPORT.margin, 238)
  ctx.fillText(
    (data.holdings ? data.holdings.count : total.count) + ' 只持仓 · ' + total.up + ' 涨 ' + total.down + ' 跌',
    REPORT.width - REPORT.margin,
    276,
  )
  ctx.textAlign = 'left'

  // intraday chart panel
  const chartX = REPORT.margin
  const chartY = 360
  const chartW = REPORT.width - REPORT.margin * 2
  const chartH = 330
  fillRound(ctx, chartX, chartY, chartW, chartH, 24, REPORT.panel)
  ctx.strokeStyle = REPORT.line
  ctx.lineWidth = 1
  roundRect(ctx, chartX + 0.5, chartY + 0.5, chartW - 1, chartH - 1, 24)
  ctx.stroke()

  ctx.fillStyle = REPORT.muted
  ctx.font = reportFont(19, 500)
  ctx.fillText('上证指数 · 分时', chartX + 28, chartY + 40)
  if (index) {
    ctx.fillStyle = REPORT.text
    ctx.font = reportFont(28, 650)
    const indexPrice = price(index.price)
    ctx.fillText(indexPrice, chartX + 28, chartY + 78)
    const indexPriceWidth = ctx.measureText(indexPrice).width
    ctx.font = reportFont(20, 600)
    ctx.fillStyle = reportTone(index.changePct)
    ctx.fillText(reportPct(index.changePct), chartX + 28 + indexPriceWidth + 14, chartY + 77)
  }

  const plotX = chartX + 28
  const plotY = chartY + 104
  const plotW = chartW - 120
  const plotH = chartH - 158
  const points = index && Array.isArray(index.points) ? index.points : []

  if (points.length > 1) {
    const prevClose = index.prevClose
    const values = points.map(function (point) { return point.p })
    if (finite(prevClose)) values.push(prevClose)
    let min = Math.min.apply(null, values)
    let max = Math.max.apply(null, values)
    const span = Math.max(max - min, 1e-6)
    min -= span * 0.12
    max += span * 0.12
    const xOf = function (i) { return plotX + (i / (points.length - 1)) * plotW }
    const yOf = function (value) { return plotY + ((max - value) / (max - min)) * plotH }

    ctx.strokeStyle = 'rgba(255,255,255,0.055)'
    ctx.lineWidth = 1
    for (let grid = 0; grid <= 3; grid += 1) {
      const y = plotY + (grid / 3) * plotH
      ctx.beginPath()
      ctx.moveTo(plotX, y)
      ctx.lineTo(plotX + plotW, y)
      ctx.stroke()
    }

    if (finite(prevClose)) {
      const baseY = yOf(prevClose)
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'
      ctx.setLineDash([5, 5])
      ctx.beginPath()
      ctx.moveTo(plotX, baseY)
      ctx.lineTo(plotX + plotW, baseY)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = REPORT.dim
      ctx.font = reportFont(16, 500)
      ctx.textAlign = 'right'
      ctx.fillText('昨收 ' + price(prevClose), chartX + chartW - 26, baseY + 5)
      ctx.textAlign = 'left'
    }

    let path = ''
    points.forEach(function (point, i) {
      path += (i === 0 ? 'M' : 'L') + xOf(i).toFixed(2) + ' ' + yOf(point.p).toFixed(2) + ' '
    })
    const lastX = xOf(points.length - 1)
    const areaPath = new Path2D(path + 'L' + lastX.toFixed(2) + ' ' + (plotY + plotH) + ' L' + plotX + ' ' + (plotY + plotH) + ' Z')
    const gradient = ctx.createLinearGradient(0, plotY, 0, plotY + plotH)
    const toneColor = reportTone(index.changePct)
    gradient.addColorStop(0, toneColor + '55')
    gradient.addColorStop(1, toneColor + '00')
    ctx.fillStyle = gradient
    ctx.fill(areaPath)

    const linePath = new Path2D(path)
    ctx.strokeStyle = toneColor
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.stroke(linePath)

    ctx.fillStyle = REPORT.dim
    ctx.font = reportFont(16, 500)
    const labels = ['09:30', '11:30', '14:00', '15:00']
    labels.forEach(function (label, i) {
      const x = plotX + (i / (labels.length - 1)) * plotW
      ctx.textAlign = i === 0 ? 'left' : (i === labels.length - 1 ? 'right' : 'center')
      ctx.fillText(label, x, plotY + plotH + 26)
    })
    ctx.textAlign = 'left'
  } else {
    ctx.fillStyle = REPORT.dim
    ctx.font = reportFont(19, 500)
    ctx.fillText('分时数据暂缺', plotX, plotY + 30)
  }

  // contribution leaderboard panel
  const boardY = 720
  const boardH = 430
  fillRound(ctx, chartX, boardY, chartW, boardH, 24, REPORT.panel)
  ctx.strokeStyle = REPORT.line
  roundRect(ctx, chartX + 0.5, boardY + 0.5, chartW - 1, boardH - 1, 24)
  ctx.stroke()

  ctx.fillStyle = REPORT.muted
  ctx.font = reportFont(19, 600)
  ctx.fillText('贡献前五', chartX + 28, boardY + 42)
  ctx.textAlign = 'right'
  ctx.font = reportFont(17, 500)
  ctx.fillStyle = REPORT.dim
  ctx.fillText('金额 / 相对上证', chartX + chartW - 28, boardY + 42)
  ctx.textAlign = 'left'

  const maxAbs = leaders.reduce(function (max, row) { return Math.max(max, Math.abs(row.pnl || 0)) }, 0)
  const rowHeight = 70
  leaders.forEach(function (row, i) {
    const y = boardY + 78 + i * rowHeight
    ctx.fillStyle = REPORT.dim
    ctx.font = reportFont(18, 600)
    ctx.fillText(String(row.rank).padStart(2, '0'), chartX + 28, y + 22)

    ctx.fillStyle = REPORT.text
    ctx.font = reportFont(24, 600)
    const name = fitText(ctx, row.name, 240)
    ctx.fillText(name, chartX + 72, y + 24)
    const nameWidth = ctx.measureText(name).width
    ctx.fillStyle = REPORT.dim
    ctx.font = reportFont(16, 500)
    ctx.fillText(row.code, chartX + 72 + nameWidth + 10, y + 23)

    ctx.textAlign = 'right'
    ctx.fillStyle = reportTone(row.pnl)
    ctx.font = reportFont(24, 650)
    ctx.fillText(reportAmount(row.pnl), chartX + chartW - 28, y + 24)
    ctx.fillStyle = REPORT.dim
    ctx.font = reportFont(15, 500)
    ctx.fillText(finite(row.relative) ? '相对 ' + pp(row.relative) : '', chartX + chartW - 28, y + 47)
    ctx.textAlign = 'left'

    const barX = chartX + 72
    const barW = chartW - 200
    const barY = y + 34
    fillRound(ctx, barX, barY, barW, 7, 3.5, 'rgba(255,255,255,0.06)')
    const zeroX = barX + barW / 2
    const ratio = maxAbs > 0 ? Math.abs(row.pnl) / maxAbs : 0
    const barWidth = Math.max(4, (barW / 2 - 2) * ratio)
    const barColor = reportTone(row.pnl)
    if (row.pnl >= 0) fillRound(ctx, zeroX, barY, barWidth, 7, 3.5, barColor)
    else fillRound(ctx, zeroX - barWidth, barY, barWidth, 7, 3.5, barColor)
    ctx.fillStyle = 'rgba(255,255,255,0.18)'
    ctx.fillRect(zeroX - 0.5, barY - 2, 1, 11)
  })

  // summary panel
  const summaryY = 1180
  const summaryH = 380
  fillRound(ctx, chartX, summaryY, chartW, summaryH, 24, REPORT.panel)
  ctx.strokeStyle = REPORT.line
  roundRect(ctx, chartX + 0.5, summaryY + 0.5, chartW - 1, summaryH - 1, 24)
  ctx.stroke()

  ctx.fillStyle = REPORT.muted
  ctx.font = reportFont(19, 600)
  ctx.fillText('自动摘要', chartX + 28, summaryY + 42)
  ctx.textAlign = 'right'
  ctx.fillStyle = REPORT.dim
  ctx.font = reportFont(16, 500)
  ctx.fillText('数字口径 · 不含操作提示', chartX + chartW - 28, summaryY + 42)
  ctx.textAlign = 'left'

  const summaryLines = data.summary && Array.isArray(data.summary.lines) ? data.summary.lines : []
  const bodyWidth = chartW - 76
  let bodySize = 22
  let lineHeight = 33
  let wrapped = []
  for (let attempt = 0; attempt < 5; attempt += 1) {
    ctx.font = reportFont(bodySize, 450)
    wrapped = []
    summaryLines.forEach(function (line) {
      wrapText(ctx, line, bodyWidth).forEach(function (part) { wrapped.push(part) })
    })
    if (wrapped.length * lineHeight <= summaryH - 92) break
    bodySize -= 1
    lineHeight = bodySize + 11
  }
  ctx.font = reportFont(bodySize, 450)
  ctx.fillStyle = 'rgba(242,244,247,0.92)'
  wrapped.slice(0, 8).forEach(function (line, i) {
    ctx.fillText(line, chartX + 28, summaryY + 90 + i * lineHeight)
  })

  // footer
  ctx.strokeStyle = REPORT.line
  ctx.beginPath()
  ctx.moveTo(REPORT.margin, 1612)
  ctx.lineTo(REPORT.width - REPORT.margin, 1612)
  ctx.stroke()
  ctx.fillStyle = REPORT.dim
  ctx.font = reportFont(16, 500)
  ctx.fillText((dateLabel || '') + ' ' + (data.clock || '') + ' 生成 · 数据 ' + (data.source || 'tencent-quote'), REPORT.margin, 1644)
  ctx.textAlign = 'right'
  ctx.fillText('dsh-pnl-attribution · 仅作数据记录', REPORT.width - REPORT.margin, 1644)
  ctx.textAlign = 'left'

  return canvas
}

function downloadReport(data) {
  const canvas = drawReport(data)
  const filename = 'pnl-close-' + (data.tradeDate || 'today') + '.png'
  const anchor = document.createElement('a')
  const save = function (url) {
    anchor.href = url
    anchor.download = filename
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(function () { URL.revokeObjectURL(url) }, 5000)
  }
  if (typeof canvas.toBlob === 'function') {
    canvas.toBlob(function (blob) {
      if (blob === null) {
        save(canvas.toDataURL('image/png'))
        return
      }
      save(URL.createObjectURL(blob))
    }, 'image/png')
    return
  }
  save(canvas.toDataURL('image/png'))
}

// ---- plugin wiring --------------------------------------------------------

function apply(ctx) {
  // dsh can unload a plugin at runtime; the module-level poller outlives one
  // mount, so it needs its own teardown in addition to React's.
  ctx.effect(function () {
    return function () {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      listeners.clear()
      snap = { data: null, error: '', at: 0 }
    }
  })

  ctx.effect(function () {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-pnl-attribution'
    style.textContent = CSS
    document.head.appendChild(style)
    return function () { style.remove() }
  })

  // Frame-wide floating layer. Guarded and normalised to a disposer so a
  // changed slot contract degrades this card instead of aborting client boot.
  ctx.slots.inject('shell.overlay', function () {
    let disposeCard
    try {
      disposeCard = ctx.slots.register(
        { name: 'shell.overlay', id: 'pnl-attribution', order: 50, label: '持仓贡献榜' },
        Root,
      )
    } catch (error) {
      disposeCard = undefined
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[dsh-pnl-attribution] could not register the floating card', error)
      }
    }
    return typeof disposeCard === 'function' ? disposeCard : function () {}
  })
}

module.exports = {
  name: 'dsh-pnl-attribution',
  inject: ['slots'],
  apply: apply,
}
