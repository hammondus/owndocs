package main

// Sobek is a language engine with no ICU, so there is no Intl. This covers
// exactly the option sets format.js and dates.js ask for, and no more.
//
// Fixed-locale on purpose: a headless runner wants output that is the same
// on every machine and in every timezone far more than it wants to guess a
// locale from a server's environment. Day-first dates and comma grouping
// match what the browser shows here; if that ever needs to vary, it should
// become a flag rather than an accident of the host.
const intlShim = `
;(function () {
  function group(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',') }

  function NumberFormat(locale, opts) {
    opts = opts || {}
    var min = opts.minimumFractionDigits || 0
    var max = opts.maximumFractionDigits === undefined
      ? Math.max(3, min) : opts.maximumFractionDigits
    var useGrouping = opts.useGrouping !== false
    return {
      format: function (n) {
        var neg = n < 0
        var s = Math.abs(n).toFixed(max)
        if (max > min && s.indexOf('.') >= 0) {
          s = s.replace(/0+$/, '')
          var decimals = s.length - s.indexOf('.') - 1
          if (decimals < min) s = Math.abs(n).toFixed(min)
          else s = s.replace(/\.$/, '')
        }
        var parts = s.split('.')
        if (useGrouping) parts[0] = group(parts[0])
        return (neg ? '-' : '') + parts.join('.')
      }
    }
  }

  var MONTHS = ['January','February','March','April','May','June','July',
    'August','September','October','November','December']
  function pad(n) { return n < 10 ? '0' + n : String(n) }

  function DateTimeFormat(locale, opts) {
    opts = opts || {}
    return {
      format: function (d) {
        var y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, day = d.getUTCDate()
        var hh = d.getUTCHours(), mi = d.getUTCMinutes()
        if (opts.month === 'long') return day + ' ' + MONTHS[mo - 1] + ' ' + y
        if (opts.hour) {
          var h12 = hh % 12 === 0 ? 12 : hh % 12
          return h12 + ':' + pad(mi) + ' ' + (hh < 12 ? 'am' : 'pm')
        }
        return pad(day) + '/' + pad(mo) + '/' + y
      },
      // dates.js only asks which of day/month comes first.
      formatToParts: function () {
        return [{ type: 'day' }, { type: 'literal' },
                { type: 'month' }, { type: 'literal' }, { type: 'year' }]
      }
    }
  }

  globalThis.Intl = { NumberFormat: NumberFormat, DateTimeFormat: DateTimeFormat }
})()
`
