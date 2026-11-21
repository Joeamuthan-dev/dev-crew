// The Code Reviewer's output: a "## Review" JSON block parsed into a verdict and findings, turned
// into Markdown for the pull request, and posted with the GitHub CLI only when the owner asks.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REVIEW_SEVERITIES = ['critical', 'major', 'minor', 'nit'];
export const REVIEW_VERDICTS = ['approve', 'comment', 'request_changes'];
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/** The review in a reviewer's report, or null when it has none. */
export function parseReview(text) {
  if (!text) return null;
  const sec = /##\s*Review\s*\n([\s\S]*)$/i.exec(text);
  const scope = sec ? sec[1] : text;
  const blocks = [...scope.matchAll(/```json\s*([\s\S]*?)```/gi)];
  for (const b of blocks.reverse()) {
    let o;
    try { o = JSON.parse(b[1]); } catch { continue; }
    if (!o || typeof o !== 'object' || Array.isArray(o) || !('verdict' in o || 'findings' in o)) continue;
    const findings = (Array.isArray(o.findings) ? o.findings : [])
      .filter(f => f && (f.title || f.detail))
      .slice(0, 50)
      .map(f => ({
        file: str(f.file, 300),
        line: Number.isInteger(Number(f.line)) && Number(f.line) > 0 ? Number(f.line) : 0,
        severity: REVIEW_SEVERITIES.includes(String(f.severity).toLowerCase()) ? String(f.severity).toLowerCase() : 'minor',
        title: str(f.title, 200) || str(f.detail, 80),
        detail: str(f.detail, 2000),
        suggestion: str(f.suggestion, 2000),
      }))
      .sort((a, b) => REVIEW_SEVERITIES.indexOf(a.severity) - REVIEW_SEVERITIES.indexOf(b.severity));
    let verdict = REVIEW_VERDICTS.includes(o.verdict) ? o.verdict : 'comment';
    // A review that lists serious problems never approves, whatever it says.
    if (verdict === 'approve' && findings.some(f => f.severity === 'critical' || f.severity === 'major')) verdict = 'request_changes';
    return { verdict, summary: str(o.summary, 2000), findings };
  }
  return null;
}

export function reviewCounts(review) {
  const c = Object.fromEntries(REVIEW_SEVERITIES.map(s => [s, 0]));
  for (const f of (review && review.findings) || []) c[f.severity]++;
  return c;
}

const VERDICT_TEXT = { approve: 'Looks good to merge', comment: 'Comments', request_changes: 'Changes requested' };

/** The review as Markdown, for a pull request comment. */
export function reviewMarkdown(review, { branch = '', base = '', by = 'Code Reviewer (Dev Crew)' } = {}) {
  const lines = [`### ${VERDICT_TEXT[review.verdict] || 'Review'}${branch ? ` · \`${branch}\`${base ? ` → \`${base}\`` : ''}` : ''}`, ''];
  if (review.summary) lines.push(review.summary, '');
  if (!review.findings.length) lines.push('No problems found.');
  for (const f of review.findings) {
    const where = f.file ? ` · \`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
    lines.push(`- **${f.severity}**${where}: ${f.title}`);
    if (f.detail) lines.push(`  ${f.detail.replace(/\n+/g, ' ')}`);
    if (f.suggestion) lines.push(`  *Suggestion:* ${f.suggestion.replace(/\n+/g, ' ')}`);
  }
  lines.push('', `_${by}_`);
  return lines.join('\n');
}

/** The GitHub CLI: on PATH, or the per-user install the setup script uses. */
export function ghCommand(env = process.env) {
  const local = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'gh', 'bin', 'gh.exe') : '';
  if (process.platform === 'win32' && local && fs.existsSync(local)) return local;
  return 'gh';
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 60000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').trim().slice(0, 400) || 'gh failed'));
      else resolve(String(stdout).trim());
    });
  });
}

/**
 * Post the review on the pull request with `gh pr review`. `event` is comment, approve or
 * request_changes (GitHub refuses the last two on your own pull request).
 */
export async function postReview({ repoPath, prNumber, event = 'comment', body }) {
  if (!/^\d{1,7}$/.test(String(prNumber))) throw new Error('Give the pull request number first.');
  const flag = { comment: '--comment', approve: '--approve', request_changes: '--request-changes' }[event];
  if (!flag) throw new Error('Unknown review type.');
  const file = path.join(os.tmpdir(), `dev-crew-review-${process.pid}-${Date.now()}.md`);
  fs.writeFileSync(file, body);
  try {
    await run(ghCommand(), ['pr', 'review', String(prNumber), flag, '--body-file', file], repoPath);
    let url = '';
    try { url = await run(ghCommand(), ['pr', 'view', String(prNumber), '--json', 'url', '--jq', '.url'], repoPath); } catch { /* fine */ }
    return { url };
  } finally {
    fs.rmSync(file, { force: true });
  }
}
