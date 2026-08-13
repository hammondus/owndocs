// Tests for the exact decimal type. Run from web/: node scripts/exact_test.mjs
//
// Dense on purpose. This is hand-rolled arithmetic replacing a primitive
// the platform gives away, so the bar is that every rounding and scale
// decision in exact.js is pinned by a case here — division and negative
// scales especially, since those are where hand-rolled decimals go wrong.
import {
  Dec, isDec, parseDec, fromNumber, decToString, decToNumber, decIsZero,
  decAdd, decSub, decMul, decDiv, decCmp, decNeg, decAbs, decRound, decPow,
  decSigRound,
} from '../src/sheet/exact.js'

let failures = 0
function eq(got, want, what) {
  if (got === want) console.log('ok:', what)
  else { failures++; console.error(`FAIL: ${what}\n  got  ${got}\n  want ${want}`) }
}

const d = (s) => parseDec(s)
const str = (x) => (x === null ? 'null' : decToString(x))

// ---- parsing and canonical form -------------------------------------------
{
  eq(str(d('0')), '0', 'zero')
  eq(str(d('-0')), '0', 'negative zero is just zero')
  eq(str(d('42')), '42', 'an integer')
  eq(str(d('-1234.5')), '-1234.5', 'a negative decimal')
  eq(str(d('.5')), '0.5', 'a leading point gets its zero')
  eq(str(d('1234.50')), '1234.5', 'a trailing zero is not information')
  eq(str(d('0.000000000000000000001')), '0.000000000000000000001', 'tiny values keep every place')
  eq(str(d('987654321098765432109876543210')), '987654321098765432109876543210', 'no size limit')
  eq(str(d('1.5e3')), '1500', 'an exponent shifts the point')
  eq(str(d('1.5e-3')), '0.0015', 'a negative exponent')
  eq(str(d('1e40')), '10000000000000000000000000000000000000000', 'a big exponent expands exactly')
  eq(d('hello'), null, 'text is not a decimal')
  eq(d(''), null, 'empty is not a decimal')
  eq(d('.'), null, 'a bare point is not a decimal')
  eq(d('e5'), null, 'a bare exponent is not a decimal')
  eq(d('1,234'), null, 'grouping is stripped before this point, not here')

  eq(isDec(d('1')), true, 'isDec recognises its own')
  eq(isDec(1), false, 'a double is not a Dec')
  eq(decIsZero(d('0.000')), true, 'zero at any scale is zero')
  eq(str(fromNumber(0.1)), '0.1', 'a double promotes through what the user typed, not its binary value')
  eq(str(fromNumber(1e21)), '1000000000000000000000', 'exponent form from String() survives')
  eq(fromNumber(Infinity), null, 'infinity has no exact value')
  eq(decToNumber(d('1234.5')), 1234.5, 'back to a double when something needs one')
}

// ---- addition, subtraction, multiplication --------------------------------
{
  eq(str(decAdd(d('0.1'), d('0.2'))), '0.3', 'the canonical double failure is exact here')
  eq(str(decAdd(d('1.10'), d('0.90'))), '2', 'a result whose fraction cancels is an integer')
  eq(str(decAdd(d('987654321098765432'), d('1'))), '987654321098765433',
    'past 2^53, where a double silently rounds')
  eq(str(decSub(d('1'), d('0.9'))), '0.1', 'subtraction with unlike scales')
  eq(str(decSub(d('5'), d('5'))), '0', 'to zero')
  eq(str(decSub(d('0'), d('3.5'))), '-3.5', 'through zero')
  eq(str(decMul(d('999999999999999999'), d('3'))), '2999999999999999997',
    'the product a double reports as ...000')
  eq(str(decMul(d('0.1'), d('0.2'))), '0.02', 'scales add')
  eq(str(decMul(d('-1.5'), d('4'))), '-6', 'signs')
  eq(str(decMul(d('12345678901234567890'), d('98765432109876543210'))),
    '1219326311370217952237463801111263526900', 'a 40-digit product, exactly')
  eq(str(decMul(d('7'), d('0'))), '0', 'times zero')
}

// ---- division: the only operation with a policy ---------------------------
{
  eq(str(decDiv(d('1'), d('4'))), '0.25', 'a terminating quotient is exact, not padded')
  eq(str(decDiv(d('1'), d('8'))), '0.125', 'and at more places')
  eq(str(decDiv(d('10'), d('2'))), '5', 'an even division is an integer')
  eq(str(decDiv(d('1'), d('3'))),
    '0.3333333333333333333333333333333333', '1/3 rounds at 34 significant digits')
  eq(str(decDiv(d('2'), d('3'))),
    '0.6666666666666666666666666666666667', '2/3 rounds the last digit up, not down')
  eq(str(decDiv(d('-2'), d('3'))),
    '-0.6666666666666666666666666666666667', 'and away from zero when negative')
  eq(decDiv(d('1'), d('0')), null, 'division by zero is the caller\'s error to name')
  eq(str(decDiv(d('0'), d('5'))), '0', 'zero divided is zero')
  // The case that motivated the exact-division fast path: rounding to 34
  // significant digits would have silently truncated a 40-digit numerator.
  eq(str(decDiv(d('1234567890123456789012345678901234567890'), d('1'))),
    '1234567890123456789012345678901234567890', 'dividing a 40-digit integer by 1 keeps all 40')
  eq(str(decDiv(d('1000000000000000000000000000000000000000'), d('8'))),
    '125000000000000000000000000000000000000', 'and by 8')
  eq(str(decDiv(d('1e40'), d('3'))),
    // 1e40/3 is 3.33...×10³⁹, so 40 digits: 34 significant, then zeros.
    '3333333333333333333333333333333333000000',
    'a non-terminating huge quotient keeps 34 significant digits, then zeros')
  eq(str(decDiv(d('0.0001'), d('8'))), '0.0000125', 'small over small')
  eq(str(decDiv(d('1'), d('1e40'))),
    '0.0000000000000000000000000000000000000001', 'a huge divisor drives the scale, not a crash')
}

// ---- comparison -----------------------------------------------------------
{
  eq(decCmp(d('1'), d('1.000')), 0, 'equal across scales')
  eq(decCmp(d('0.1'), d('0.2')), -1, 'less')
  eq(decCmp(d('2'), d('1.9999')), 1, 'greater')
  eq(decCmp(d('-1'), d('1')), -1, 'signs compare')
  eq(decCmp(d('987654321098765432'), d('987654321098765433')), -1,
    'two values a double cannot tell apart')
  eq(str(decNeg(d('4.5'))), '-4.5', 'negate')
  eq(str(decNeg(d('-4.5'))), '4.5', 'and back')
  eq(str(decAbs(d('-4.5'))), '4.5', 'abs')
  eq(str(decAbs(d('4.5'))), '4.5', 'of a positive is itself')
}

// ---- rounding -------------------------------------------------------------
{
  eq(str(decRound(d('2.5'), 0)), '3', 'half rounds away from zero')
  eq(str(decRound(d('-2.5'), 0)), '-3', 'in both directions')
  eq(str(decRound(d('2.4'), 0)), '2', 'below half rounds down')
  eq(str(decRound(d('1.2345'), 2)), '1.23', 'to places')
  eq(str(decRound(d('1.2355'), 2)), '1.24', 'and rounds up at the boundary')
  eq(str(decRound(d('1234'), -2)), '1200', 'a negative place rounds to hundreds')
  eq(str(decRound(d('1250'), -2)), '1300', 'half up there too')
  eq(str(decRound(d('5'), 2)), '5', 'asking for more places than exist changes nothing')

  // A visible divergence from the default engine, and the clearest small
  // demonstration of why exact mode exists. Typing 2326.95 gets you the
  // double 2326.94999999999981..., which is below the halfway point and so
  // rounds DOWN: (2326.95).toFixed(1) is '2326.9'. The exact value is
  // exactly half and rounds up. Around 4% of two-decimal values are
  // misplaced this way, so this is not an exotic case.
  eq(str(decRound(d('2326.95'), 1)), '2327', 'an exact half rounds up where the double rounds down')
  eq((2326.95).toFixed(1), '2326.9', 'the double really is on the other side of the half')
}

// ---- powers ---------------------------------------------------------------
{
  eq(str(decPow(d('2'), d('10'))), '1024', 'an integer power is exact')
  eq(str(decPow(d('2'), d('100'))), '1267650600228229401496703205376', 'at any size')
  eq(str(decPow(d('10'), d('0'))), '1', 'anything to the zero')
  eq(str(decPow(d('0.1'), d('3'))), '0.001', 'a fractional base')
  eq(str(decPow(d('2'), d('-2'))), '0.25', 'a negative exponent inverts')
  eq(decPow(d('2'), d('0.5')), null, 'a fractional exponent has no exact answer here')
  eq(decPow(d('10'), d('100000')), null, 'an absurd exponent is refused, not computed')
}

// ---- significant-digit rounding (display only) -----------------------------
{
  eq(str(decSigRound(d('0.3333333333333333333333'), 13)), '0.3333333333333', 'a repeating fraction is cut to width')
  eq(str(decSigRound(d('1.5'), 13)), '1.5', 'a short value is untouched')
  eq(str(decSigRound(d('0'), 13)), '0', 'zero has no digits to drop')
  eq(str(decSigRound(d('-0.6666666666666666'), 13)), '-0.6666666666667', 'the last kept digit rounds, and the sign survives')
  // The scale goes negative here: 17 digits trimmed to 13 leaves the value a
  // 17-digit integer with four zeros on the end, not a 13-digit one.
  eq(str(decSigRound(d('12345678901234567'), 13)), '12345678901230000', 'trimming a long integer keeps its magnitude')
  eq(str(decSigRound(d('12345678901239567'), 13)), '12345678901240000', 'and rounds the last kept digit up')
  eq(str(decSigRound(d('99999999999999'), 13)), '100000000000000', 'a carry off the end grows the number')
  eq(str(decSigRound(d('0.00000000000000012345'), 3)), '0.000000000000000123', 'leading zeros are not significant digits')
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS')
if (failures) process.exit(1)
