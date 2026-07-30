/**
 * DRIFT GUARD — the mechanism that catches "a second, slightly different way of
 * computing this same number".
 *
 * It walks every file under src/ and fails the build if revenue logic has leaked
 * outside src/revenue/. This is the test that fires when somebody writes a
 * convenient one-off `SELECT SUM(amount_minor)` in a controller because the
 * service did not quite have the shape they wanted.
 *
 * To see it work: add such a query anywhere outside src/revenue/ and run the
 * suite. The failure names the file and points at the canonical module.
 */

import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/** The one directory allowed to know what revenue means. */
const CANONICAL_DIR = join('src', 'revenue');
/** Adapters legitimately name provider status strings — that is their job. */
const SOURCES_DIR = join('src', 'sources');

interface Rule {
  name: string;
  /** Directories (repo-relative prefixes) exempt from this rule. */
  allowedIn: string[];
  pattern: RegExp;
  remedy: string;
}

const RULES: Rule[] = [
  {
    // The raw allow-list data is the decision surface. Reading it directly is how
    // a caller ends up re-deriving "what counts" instead of asking. isCollected()
    // is the sanctioned accessor and delegates to the one classification map.
    name: 'reads the collected-status allow-list directly',
    allowedIn: [CANONICAL_DIR],
    pattern: /\bCOLLECTED_STATUSES\b|\bSTATUS_CLASSIFICATION\b|\bREFUNDS_NETTED\b/,
    remedy:
      'Call RevenueService, or isCollected() if you only need the predicate. ' +
      'If you need a variant of the metric, add a parameter to RevenueService.',
  },
  {
    // Adapters are exempt: declaring "this provider's `paid` means COLLECTED" is
    // precisely their job. Anywhere else, naming COLLECTED means deciding revenue.
    name: 'classifies a status as collected outside an adapter',
    allowedIn: [CANONICAL_DIR, SOURCES_DIR],
    pattern: /CanonicalStatus\s*\.\s*COLLECTED\b/,
    remedy:
      'Status classification belongs in a source adapter vocabulary in src/sources/, ' +
      'and the definition of collected in src/revenue/canonical.ts.',
  },
  {
    name: 'hardcodes a provider status that means "collected"',
    allowedIn: [CANONICAL_DIR, SOURCES_DIR],
    pattern: /['"`](succeeded|paid|completed|captured|settled)['"`]/i,
    remedy:
      'Provider status strings belong in a source adapter vocabulary in src/sources/. ' +
      'Nothing else should name them.',
  },
  {
    name: 'aggregates a money column in SQL',
    allowedIn: [CANONICAL_DIR],
    pattern: /\b(SUM|sum)\s*\(\s*[a-z_."]*amount(_minor|_refunded_minor)?\b/,
    remedy:
      'src/revenue/RevenueRepository.ts is the only place that sums money. ' +
      'Add a method there and call it.',
  },
  {
    name: 'aggregates a money column in JavaScript',
    allowedIn: [CANONICAL_DIR],
    // Bounded rather than [^)]*, so it still matches across the parameter list of
    // an arrow function: `rows.reduce((a, r) => a + r.amountMinor, 0n)`.
    pattern: /\.reduce\s*\([^;]{0,200}?\bamount(Minor|RefundedMinor)\b/,
    remedy:
      'Use RevenueService.foldBreakdown() or a RevenueRepository method rather than ' +
      'summing amounts inline.',
  },
  {
    name: 'buckets timestamps into days outside the canonical module',
    allowedIn: [CANONICAL_DIR],
    pattern: /\bDATE_TRUNC\s*\(|\bdate_trunc\s*\(/,
    remedy:
      'Day bucketing must stay in RevenueRepository so both views use the same ' +
      'UTC truncation.',
  },
  {
    name: 'defines its own date-range bounds',
    allowedIn: [CANONICAL_DIR],
    pattern: /occurred_at\s*(>=|>|<=|<)/,
    remedy:
      'Range semantics ([from, to), UTC) live in src/revenue/DateRange.ts and are ' +
      'applied in RevenueRepository. Do not filter occurred_at elsewhere.',
  },
];

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.name.endsWith('.ts')) {
      yield full;
    }
  }
}

/**
 * Strips comments and blank lines so a rule cannot be tripped by prose. The
 * canonical module explains itself at length; those explanations must not read
 * as violations.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('drift guard: exactly one revenue implementation', () => {
  it('finds no revenue logic outside src/revenue/', async () => {
    const violations: string[] = [];

    for await (const file of walk(SRC)) {
      const repoRelative = join('src', relative(SRC, file));
      const code = stripComments(await readFile(file, 'utf8'));

      for (const rule of RULES) {
        const exempt = rule.allowedIn.some(
          (prefix) => repoRelative === prefix || repoRelative.startsWith(prefix + sep),
        );
        if (exempt) continue;

        const lines = code.split('\n');
        lines.forEach((line, i) => {
          if (rule.pattern.test(line)) {
            violations.push(
              `\n  ${repoRelative}:${i + 1}\n` +
                `    ${rule.name}\n` +
                `    > ${line.trim().slice(0, 110)}\n` +
                `    fix: ${rule.remedy}`,
            );
          }
        });
      }
    }

    expect(
      violations,
      violations.length === 0
        ? ''
        : `\n\nA second revenue implementation appears to have been introduced.\n` +
            `The canonical definition lives in src/revenue/canonical.ts and must stay there.\n` +
            `${violations.join('\n')}\n`,
    ).toEqual([]);
  });

  /**
   * A guard whose patterns have quietly stopped matching passes vacuously and is
   * worse than no guard, because it looks like protection. Every rule must still
   * catch a realistic violation.
   */
  it.each([
    [
      'reads the collected-status allow-list directly',
      'if (COLLECTED_STATUSES.includes(row.canonical_status)) total += row.amount;',
    ],
    [
      'classifies a status as collected outside an adapter',
      'const ok = row.status === CanonicalStatus.COLLECTED;',
    ],
    [
      'hardcodes a provider status that means "collected"',
      `const collected = ['succeeded', 'paid'];`,
    ],
    [
      'aggregates a money column in SQL',
      'const r = await db.query("SELECT SUM(amount_minor) FROM transactions");',
    ],
    [
      'aggregates a money column in JavaScript',
      'rows.reduce((a, r) => a + r.amountMinor, 0n)',
    ],
    [
      'buckets timestamps into days outside the canonical module',
      `db.query("SELECT DATE_TRUNC('day', occurred_at) FROM transactions")`,
    ],
    [
      'defines its own date-range bounds',
      'const sql = `SELECT * FROM transactions WHERE occurred_at >= $1`;',
    ],
  ])('rule "%s" still catches a violation', (ruleName, badSnippet) => {
    const rule = RULES.find((r) => r.name === ruleName);
    expect(rule, `no rule named "${ruleName}" — did a rule get renamed?`).toBeDefined();
    expect(rule!.pattern.test(badSnippet)).toBe(true);
  });

  it('exempts only the directories it means to', () => {
    // A rule with an empty allowedIn would fire inside canonical.ts itself and be
    // deleted in frustration; a rule allowing all of src/ would never fire.
    for (const rule of RULES) {
      expect(rule.allowedIn.length, rule.name).toBeGreaterThan(0);
      expect(rule.allowedIn, rule.name).not.toContain('src');
      expect(rule.allowedIn, rule.name).toContain(CANONICAL_DIR);
    }
  });
});
