/**
 * classify.ts — the refusal classifier over one parsed session log.
 *
 * The released chain validates a log row by row and throws at the FIRST bad
 * row, so this classifier walks the rows in log order and reports the class of
 * that first refusal, together with every finding it collected. Each rule's
 * `detect` is called once per row (a single-row slice) for exactly that reason —
 * see the row-local contract on `LogRule`.
 *
 * Scope: this is the STRUCTURAL classifier. It knows only the classes the rule
 * registry models, so `'ok'` means "no structural refusal found", never "the
 * released chain accepts this log" — the catalog read-back is the truth. The
 * read/restore layers, not a row rule, produce `'other-refusal'` (a row shape
 * failure no rule models) and `'decompress-failed'`.
 */
import type { Finding, LogRule, ParsedRow, RefusalClass } from './rules.ts'

export interface Classification {
  /** Class of the first refusal in log order; `'ok'` when no rule reports one. */
  class: RefusalClass
  /** Every finding, in log order (row order, then registry order). */
  findings: Finding[]
}

/**
 * Classify one parsed log: `{ class, findings }` for its first refusal class.
 *
 * @param rows parsed log rows in log order (header first).
 * @param rules rules to apply, in check order.
 */
export function classifyRows(rows: readonly ParsedRow[], rules: readonly LogRule[]): Classification {
  const findings: Finding[] = []
  let refusalClass: RefusalClass = 'ok'
  let firstRefusal = true
  for (const row of rows) {
    for (const rule of rules) {
      const detected = rule.detect([row])
      if (detected.length === 0) continue
      if (firstRefusal) {
        refusalClass = rule.class
        firstRefusal = false
      }
      findings.push(...detected)
    }
  }
  return { class: refusalClass, findings }
}
