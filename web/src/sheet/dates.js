// Dates. A date is NOT a new value type: it is a number wearing a date
// format, exactly as in Excel and Sheets. The number is a "serial" — days
// since 1899-12-30, with the fractional part being time of day. That one
// decision buys date arithmetic for free (=B1-A1 is days between, =A1+7 is
// a week later), keeps comparison and sorting working, and means the
// formula engine needs no new type at all.
//
// Serials are timezone-free CIVIL date-times: 2026-08-05 means that
// calendar day everywhere, not an instant. All conversion goes through the
// UTC accessors so daylight saving can never shift a date by a day.
//
// Epoch note: serial 1 = 1900-01-01, matching Excel for every date from
// 1900-03-01 onward. Excel believes 1900-02-29 existed (it did not) and
// Sheets copies the bug; we do not. Dates before March 1900 therefore
// differ from Excel by one day, which is the correct answer and an era
// nobody puts in a spreadsheet.

const MS_PER_DAY = 86400000
const EPOCH = Date.UTC(1899, 11, 30)

export const isDateFormat = (n) =>
  n === 'date' || n === 'isodate' || n === 'datelong' || n === 'datetime' || n === 'time'

export function serialFromParts(y, mo, d, hh = 0, mi = 0, ss = 0) {
  const days = (Date.UTC(y, mo - 1, d) - EPOCH) / MS_PER_DAY
  return days + (hh * 3600 + mi * 60 + ss) / 86400
}

export function partsFromSerial(serial) {
  // Round to the nearest second before splitting: serial arithmetic is
  // floating point, and 0.3 of a day must not display as 07:11:59.
  const ms = Math.round((EPOCH + serial * MS_PER_DAY) / 1000) * 1000
  const d = new Date(ms)
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    hh: d.getUTCHours(), mi: d.getUTCMinutes(), ss: d.getUTCSeconds(),
    dow: d.getUTCDay(), // 0 = Sunday
  }
}

// ---- display --------------------------------------------------------------

const fmtCache = new Map()
function intl(opts) {
  const key = JSON.stringify(opts)
  let f = fmtCache.get(key)
  if (!f) {
    // timeZone UTC is essential: the serial was built as UTC-civil, so it
    // must be read back the same way or it drifts by the viewer's offset.
    f = new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' })
    fmtCache.set(key, f)
  }
  return f
}

const asDate = (serial) => new Date(Math.round((EPOCH + serial * MS_PER_DAY) / 1000) * 1000)

const pad = (n) => String(n).padStart(2, '0')

export function formatDate(serial, spec) {
  if (!Number.isFinite(serial)) return null
  const d = asDate(serial)
  switch (spec) {
    case 'date':
      // Locale order (05/08/2026 in Australia, 08/05/2026 in the US) with
      // a full year, so it is never ambiguous about the century.
      return intl({ day: '2-digit', month: '2-digit', year: 'numeric' }).format(d)
    case 'isodate': {
      const p = partsFromSerial(serial)
      return `${p.y}-${pad(p.mo)}-${pad(p.d)}`
    }
    case 'datelong':
      return intl({ day: 'numeric', month: 'long', year: 'numeric' }).format(d)
    case 'time':
      return intl({ hour: 'numeric', minute: '2-digit' }).format(d)
    case 'datetime':
      // Built from the two formatters rather than dateStyle/timeStyle so
      // there is no locale comma in the middle: the result has to re-parse
      // when it comes back through the formula bar or the clipboard.
      return intl({ day: '2-digit', month: '2-digit', year: 'numeric' }).format(d) +
        ' ' + intl({ hour: 'numeric', minute: '2-digit' }).format(d)
    default:
      return null
  }
}

// ---- parsing --------------------------------------------------------------

// Does this locale write the day before the month in numeric dates? Asked
// of Intl rather than assumed, so "5/8/2026" means 5 August in Sydney and
// May 8 in New York — the same text, each user's own reading of it.
let dayFirstCache = null
export function localeDayFirst() {
  if (dayFirstCache === null) {
    dayFirstCache = false
    const parts = new Intl.DateTimeFormat(undefined, {
      day: 'numeric', month: 'numeric', year: 'numeric',
    }).formatToParts(new Date(Date.UTC(2000, 0, 2)))
    for (const p of parts) {
      if (p.type === 'day') { dayFirstCache = true; break }
      if (p.type === 'month') { dayFirstCache = false; break }
    }
  }
  return dayFirstCache
}

// Test seam: pin the locale ordering so tests don't depend on the machine.
export function setDayFirst(v) {
  dayFirstCache = v
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december']

function monthFromName(s) {
  const t = s.toLowerCase()
  if (t.length < 3) return 0
  const i = MONTHS.findIndex((m) => m.startsWith(t))
  return i < 0 ? 0 : i + 1
}

// Excel's window: a two-digit year under 30 is this century.
const fullYear = (y) => (y >= 100 ? y : y < 30 ? 2000 + y : 1900 + y)

// A real calendar date, not one that rolled over. Typed input must be
// rejected rather than silently becoming 2 March, unlike the DATE()
// function, which rolls over on purpose (Excel semantics for both).
function validate(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const s = serialFromParts(y, mo, d)
  const p = partsFromSerial(s)
  return p.y === y && p.mo === mo && p.d === d ? s : null
}

const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])\.?m?\.?$|^(\d{1,2}):(\d{2})(?::(\d{2}))?$/i

function parseTime(text) {
  const m = TIME_RE.exec(text.trim())
  if (!m) return null
  const ampm = m[4]
  let hh = Number(ampm ? m[1] : m[5])
  const mi = Number(ampm ? m[2] : m[6])
  const ss = Number((ampm ? m[3] : m[7]) || 0)
  if (mi > 59 || ss > 59) return null
  if (ampm) {
    if (hh < 1 || hh > 12) return null
    const pm = ampm.toLowerCase() === 'p'
    hh = (hh % 12) + (pm ? 12 : 0)
  } else if (hh > 23) return null
  return (hh * 3600 + mi * 60 + ss) / 86400
}

// Returns {serial, kind} where kind is the format the text implies, or
// null when the text is not a date or time at all.
export function parseDate(text) {
  let s = String(text).trim()
  if (s === '') return null

  // Time alone: a fraction of a day.
  const timeOnly = parseTime(s)
  if (timeOnly !== null) return { serial: timeOnly, kind: 'time' }

  // Split a trailing time off a date.
  let timePart = 0
  let hasTime = false
  const sp = s.match(/^(.*?)[ T]+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m?\.?)?)$/i)
  if (sp) {
    const t = parseTime(sp[2])
    if (t !== null) {
      timePart = t
      hasTime = true
      s = sp[1].trim()
    }
  }

  const done = (serial) => serial === null
    ? null
    : { serial: serial + timePart, kind: hasTime ? 'datetime' : 'date' }

  // ISO, always unambiguous.
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (m) {
    const serial = validate(Number(m[1]), Number(m[2]), Number(m[3]))
    return serial === null ? null : { serial: serial + timePart, kind: hasTime ? 'datetime' : 'isodate' }
  }

  // Numeric, locale-ordered. A slash date may omit the year (5/8 means
  // this year, as everywhere else); a dashed one may not, because "1-2" is
  // far more often a range than a date.
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s) || /^(\d{1,2})-(\d{1,2})-(\d{2,4})$/.exec(s)
  if (m) {
    const a = Number(m[1]), b = Number(m[2])
    const y = m[3] ? fullYear(Number(m[3])) : new Date().getFullYear()
    const dayFirst = localeDayFirst()
    return done(validate(y, dayFirst ? b : a, dayFirst ? a : b))
  }

  // Month names, either order: "5 Aug 2026" or "Aug 5, 2026".
  m = /^(\d{1,2})[ -]([A-Za-z]{3,})[ -](\d{2,4})$/.exec(s)
  if (m) {
    const mo = monthFromName(m[2])
    return mo ? done(validate(fullYear(Number(m[3])), mo, Number(m[1]))) : null
  }
  m = /^([A-Za-z]{3,})[ -](\d{1,2}),?[ -]?(\d{2,4})$/.exec(s)
  if (m) {
    const mo = monthFromName(m[1])
    return mo ? done(validate(fullYear(Number(m[3])), mo, Number(m[2]))) : null
  }
  return null
}
