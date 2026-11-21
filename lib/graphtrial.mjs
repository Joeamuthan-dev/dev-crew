// Summarising a knowledge-graph trial: the same read-only questions run with and without the
// graph, compared on tokens, cost, time and how much the agent had to search.

export const DEFAULT_QUESTIONS = [
  'Give a map of this codebase: its main areas, the key classes in each, and how a typical request flows from the entry point to the data store. Cite files.',
  'Find every place that talks to the database without going through the main data-access layer (for example raw connections or hand-written SQL), and say why each might be there. Cite files and line numbers.',
  'Pick the most central class or module in this codebase. List what depends on it and what would break if its public interface changed. Cite files.',
];

const median = xs => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sum = xs => xs.reduce((a, b) => a + (b || 0), 0);
export const promptTokens = t => (t ? (t.input || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0) : 0);

/** One row per variant: totals and medians over the questions it answered. */
export function summarizeTrial(runs) {
  const variants = [...new Set(runs.map(r => r.variant))];
  return variants.map(v => {
    const rs = runs.filter(r => r.variant === v && r.ok);
    return {
      variant: v,
      runs: rs.length,
      failed: runs.filter(r => r.variant === v && !r.ok).length,
      costUsd: sum(rs.map(r => r.costUsd)),
      medianCostUsd: median(rs.map(r => r.costUsd)),
      medianTurns: median(rs.map(r => r.turns)),
      medianPromptTokens: median(rs.map(r => promptTokens(r.tokens))),
      medianOutputTokens: median(rs.map(r => (r.tokens || {}).output || 0)),
      medianWallMs: median(rs.map(r => r.wallMs)),
      medianSearches: median(rs.map(r => (r.tools.Grep || 0) + (r.tools.Glob || 0) + (r.tools.LS || 0))),
      medianReads: median(rs.map(r => r.tools.Read || 0)),
      medianGraphCalls: median(rs.map(r => Object.entries(r.tools).filter(([k]) => k.startsWith('mcp__graphify__')).reduce((a, [, n]) => a + n, 0))),
    };
  });
}

/** Change of each variant against the baseline ("off"), as a fraction (-0.3 = 30% less). */
export function compareToBaseline(rows, base = 'off') {
  const b = rows.find(r => r.variant === base);
  if (!b) return [];
  const rel = (x, y) => (y ? (x - y) / y : 0);
  return rows.filter(r => r.variant !== base).map(r => ({
    variant: r.variant,
    cost: rel(r.medianCostUsd, b.medianCostUsd),
    promptTokens: rel(r.medianPromptTokens, b.medianPromptTokens),
    turns: rel(r.medianTurns, b.medianTurns),
    time: rel(r.medianWallMs, b.medianWallMs),
    searches: rel(r.medianSearches, b.medianSearches),
  }));
}

/** The Markdown report written next to the raw results. */
export function trialMarkdown({ project, repo, model, questions, runs, startedAt }) {
  const rows = summarizeTrial(runs);
  const deltas = compareToBaseline(rows);
  const pct = x => `${x > 0 ? '+' : ''}${Math.round(x * 100)}%`;
  const usd = x => `$${x.toFixed(3)}`;
  const lines = [
    `# Knowledge graph trial: ${project} / ${repo}`,
    '',
    `${new Date(startedAt).toISOString().slice(0, 16).replace('T', ' ')} · model ${model} · ${questions.length} question(s) × ${rows.length} variant(s), read-only.`,
    '',
    '| Variant | Runs | Total cost | Median cost | Median prompt tokens | Median output tokens | Median turns | Median time | Searches (Grep/Glob) | Reads | Graph calls |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.variant} | ${r.runs}${r.failed ? ` (+${r.failed} failed)` : ''} | ${usd(r.costUsd)} | ${usd(r.medianCostUsd)} | ${Math.round(r.medianPromptTokens).toLocaleString()} | ${Math.round(r.medianOutputTokens).toLocaleString()} | ${r.medianTurns} | ${Math.round(r.medianWallMs / 1000)}s | ${r.medianSearches} | ${r.medianReads} | ${r.medianGraphCalls} |`),
    '',
  ];
  if (deltas.length) {
    lines.push('Against no graph (median):', '');
    for (const d of deltas) lines.push(`- **${d.variant}:** cost ${pct(d.cost)}, prompt tokens ${pct(d.promptTokens)}, turns ${pct(d.turns)}, time ${pct(d.time)}, searches ${pct(d.searches)}`);
    lines.push('');
  }
  lines.push('## Per question', '');
  questions.forEach((q, i) => {
    lines.push(`### ${i + 1}. ${q}`, '');
    for (const r of runs.filter(x => x.question === i)) {
      lines.push(`- **${r.variant}:** ${r.ok ? `${usd(r.costUsd)}, ${r.turns} turns, ${Math.round(r.wallMs / 1000)}s, ${promptTokens(r.tokens).toLocaleString()} prompt tokens` : `failed: ${r.error}`}`);
    }
    lines.push('');
  });
  lines.push('Answers are in the JSON file next to this report, for judging quality side by side.');
  return lines.join('\n');
}
