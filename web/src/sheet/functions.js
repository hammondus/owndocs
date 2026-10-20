// What the formula reference panel shows: one row per thing a formula may
// call, with a signature, a sentence, and an example short enough to try.
//
// **This list cannot drift from the engine.** `CALLABLE` in engine.js is the
// registry plus its special forms, and `functions_test.mjs` asserts the two
// sets are equal in both directions — so adding a function without documenting
// it fails the build, and documenting one that does not exist fails it too.
// That is the whole reason this file is data rather than prose in a README.
//
// No DOM and no imports beyond the engine's own list, so the test runs under
// node.
import { CALLABLE } from './engine.js'

// Grouped the way somebody looking for a function thinks, not the way the
// registry happens to be ordered.
export const FUNCTION_DOCS = [
  {
    group: 'Numbers',
    items: [
      { name: 'SUM', args: '(value, …)', help: 'Adds numbers, or everything in a range.', eg: '=SUM(A1:A10)' },
      { name: 'AVERAGE', args: '(value, …)', help: 'The mean of the numbers given.', eg: '=AVERAGE(B1:B12)' },
      { name: 'MIN', args: '(value, …)', help: 'The smallest number.', eg: '=MIN(A1:A10)' },
      { name: 'MAX', args: '(value, …)', help: 'The largest number.', eg: '=MAX(A1:A10)' },
      { name: 'ROUND', args: '(number, places)', help: 'Rounds to a number of decimal places.', eg: '=ROUND(A1, 2)' },
      { name: 'ABS', args: '(number)', help: 'Drops the sign.', eg: '=ABS(-4)' },
      { name: 'SQRT', args: '(number)', help: 'Square root.', eg: '=SQRT(16)' },
      { name: 'MOD', args: '(number, divisor)', help: 'The remainder after division.', eg: '=MOD(7, 3)' },
      { name: 'SUMIF', args: '(range, criterion, sum_range)', help: 'Adds the cells that meet a criterion, such as ">100", "<>0", or "pe*". With sum_range, which must be the same size, adds the cells beside the ones that match.', eg: '=SUMIF(A2:A20, "pears", C2:C20)' },
    ],
  },
  {
    group: 'Counting',
    items: [
      { name: 'COUNT', args: '(value, …)', help: 'How many of them are numbers.', eg: '=COUNT(A1:A10)' },
      { name: 'COUNTA', args: '(value, …)', help: 'How many are not empty, whatever they hold.', eg: '=COUNTA(A1:A10)' },
      { name: 'COUNTIF', args: '(range, criterion)', help: 'How many cells meet a criterion, such as ">100", "pe*", or "" for empty cells.', eg: '=COUNTIF(B2:B20, ">100")' },
    ],
  },
  {
    group: 'Logic',
    items: [
      { name: 'IF', args: '(test, then, else)', help: 'Picks one of two values. Only the branch taken is worked out, so an error in the other cannot spoil it.', eg: '=IF(A1>10, "over", "under")' },
      { name: 'AND', args: '(test, …)', help: 'True when every one of them is.', eg: '=AND(A1>0, B1>0)' },
      { name: 'OR', args: '(test, …)', help: 'True when any one of them is.', eg: '=OR(A1>0, B1>0)' },
      { name: 'NOT', args: '(test)', help: 'Turns true into false and back.', eg: '=NOT(A1>0)' },
      { name: 'IFERROR', args: '(value, if_error)', help: 'The value, or if_error when the value is an error. Without if_error, the cell is blank. A circular reference still shows.', eg: '=IFERROR(A1/B1, 0)' },
    ],
  },
  {
    group: 'Lookup',
    items: [
      { name: 'VLOOKUP', args: '(key, range, column, sorted)', help: 'Finds key in the first column and returns the value from another column, counting from 1. Give FALSE for an exact match: sorted is TRUE unless you say otherwise, and then the first column must be in order.', eg: '=VLOOKUP("pears", A2:C20, 3, FALSE)' },
      { name: 'XLOOKUP', args: '(key, look_in, return_from, if_missing, match, search)', help: 'Finds key in one row or column and returns the value in the same place in another. Match 0 is exact, -1 or 1 also takes the next smaller or larger, and 2 allows * and ?. Search -1 starts from the end.', eg: '=XLOOKUP(A2, D2:D50, F2:F50, "none")' },
      { name: 'MATCH', args: '(key, range, type)', help: 'The position of key in one row or column, counting from 1. Type 0 is an exact match. Type 1, the default, needs the list in ascending order.', eg: '=MATCH("pears", A2:A20, 0)' },
      { name: 'INDEX', args: '(range, row, column)', help: 'The cell at a row and column of a range, counting from 1. In a single column, the row is enough.', eg: '=INDEX(A2:C20, 4, 2)' },
    ],
  },
  {
    group: 'Text',
    items: [
      { name: 'CONCATENATE', args: '(text, …)', help: 'Joins text end to end. `&` does the same thing.', eg: '=CONCATENATE(A1, " ", B1)' },
      { name: 'LEN', args: '(text)', help: 'How many characters.', eg: '=LEN(A1)' },
      { name: 'LEFT', args: '(text, count)', help: 'The first few characters.', eg: '=LEFT(A1, 3)' },
      { name: 'RIGHT', args: '(text, count)', help: 'The last few characters.', eg: '=RIGHT(A1, 3)' },
      { name: 'MID', args: '(text, start, count)', help: 'Characters from the middle, counting from 1.', eg: '=MID(A1, 2, 3)' },
      { name: 'UPPER', args: '(text)', help: 'Everything in capitals.', eg: '=UPPER(A1)' },
      { name: 'LOWER', args: '(text)', help: 'Everything in lower case.', eg: '=LOWER(A1)' },
      { name: 'TRIM', args: '(text)', help: 'Removes spaces from both ends.', eg: '=TRIM(A1)' },
    ],
  },
  {
    group: 'Dates and times',
    items: [
      { name: 'TODAY', args: '()', help: "Today's date.", eg: '=TODAY()' },
      { name: 'NOW', args: '()', help: 'The date and time right now.', eg: '=NOW()' },
      { name: 'DATE', args: '(year, month, day)', help: 'Builds a date from its parts.', eg: '=DATE(2026, 8, 13)' },
      { name: 'TIME', args: '(hour, minute, second)', help: 'Builds a time from its parts.', eg: '=TIME(9, 30, 0)' },
      { name: 'YEAR', args: '(date)', help: 'The year out of a date.', eg: '=YEAR(A1)' },
      { name: 'MONTH', args: '(date)', help: 'The month, 1 to 12.', eg: '=MONTH(A1)' },
      { name: 'DAY', args: '(date)', help: 'The day of the month.', eg: '=DAY(A1)' },
      { name: 'HOUR', args: '(time)', help: 'The hour, 0 to 23.', eg: '=HOUR(A1)' },
      { name: 'MINUTE', args: '(time)', help: 'The minutes.', eg: '=MINUTE(A1)' },
      { name: 'SECOND', args: '(time)', help: 'The seconds.', eg: '=SECOND(A1)' },
      { name: 'WEEKDAY', args: '(date)', help: 'Day of the week, 1 for Sunday.', eg: '=WEEKDAY(A1)' },
      { name: 'DAYS', args: '(end, start)', help: 'How many days between two dates.', eg: '=DAYS(B1, A1)' },
      { name: 'EDATE', args: '(date, months)', help: 'The same day, a number of months away.', eg: '=EDATE(A1, 3)' },
    ],
  },
]

// Everything the panel can show, flattened — and the set the test compares
// against the engine.
export const documented = () => FUNCTION_DOCS.flatMap((g) => g.items)

export const documentedNames = () => documented().map((f) => f.name).sort()

// Not functions, but the rest of what a formula may contain — worth saying on
// the same screen, because "what can I write here" is one question and
// answering half of it sends somebody to guess at the other half.
export const SYNTAX_NOTES = [
  { what: 'Arithmetic', eg: '=A1 * 1.1 + B2 / 2', help: 'Also `-` and `^` for powers, and `%` after a number.' },
  { what: 'Comparison', eg: '=A1 >= B1', help: 'Also `=`, `<>`, `<`, `>`, `<=` — they give true or false.' },
  { what: 'Joining text', eg: '=A1 & " " & B1', help: 'The same as CONCATENATE.' },
  { what: 'A range', eg: '=SUM(A1:B9)', help: 'A rectangle between two corners.' },
  { what: 'Locking a reference', eg: '=$A$1', help: 'F4 cycles a reference through the `$` forms while you type.' },
  { what: 'Another sheet', eg: "=Sheet2!A1", help: 'Quote the name if it has spaces in it.' },
  { what: 'Pointing', eg: '=SUM(', help: 'Then click or drag the cells, instead of typing the reference.' },
]

// A quick check that the names above are the ones the engine has. Exported so
// the panel could show a warning too, though the test is what keeps it honest.
export function docsMatchEngine() {
  const docs = documentedNames()
  const engine = [...CALLABLE].sort()
  return {
    missing: engine.filter((n) => !docs.includes(n)),
    extra: docs.filter((n) => !engine.includes(n)),
  }
}
