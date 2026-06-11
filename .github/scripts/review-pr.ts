import { readFileSync } from 'fs';
import { reviewAgent, reviewSchema, type ReviewOutput } from '../../src/mastra/agents/review-agent.ts';

// Returns a Map<filePath, Set<lineNumber>> of lines present in the diff patch.
// Only lines reachable via +/context lines within @@ hunks are valid for GitHub review comments.
function parseDiffValidLines(diff: string): Map<string, Set<number>> {
  const validLines = new Map<string, Set<number>>();
  let currentFile: string | null = null;
  let newLineNumber = 0;

  for (const line of diff.split('\n')) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      if (!validLines.has(currentFile)) validLines.set(currentFile, new Set());
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLineNumber = parseInt(hunkMatch[1], 10) - 1;
      continue;
    }

    if (!currentFile) continue;

    if (line.startsWith('+')) {
      newLineNumber++;
      validLines.get(currentFile)!.add(newLineNumber);
    } else if (line.startsWith(' ')) {
      newLineNumber++;
      validLines.get(currentFile)!.add(newLineNumber);
    }
    // lines starting with '-' don't exist in the new file — skip
  }

  return validLines;
}

const MAX_DIFF_BYTES = 100_000;
const REVIEW_MARKER = '<!-- ai-review -->';
const GITHUB_API = 'https://api.github.com';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
const GROQ_API_KEY = process.env.GROQ_API_KEY!;
const PR_NUMBER = process.env.PR_NUMBER!;
const REPO = process.env.REPO!;
const HEAD_SHA = process.env.HEAD_SHA!;

if (!GITHUB_TOKEN || !GROQ_API_KEY || !PR_NUMBER || !REPO || !HEAD_SHA) {
  console.error('Missing required environment variables: GITHUB_TOKEN, GROQ_API_KEY, PR_NUMBER, REPO, HEAD_SHA');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
};

async function ghFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
}

async function findExistingSummaryComment(): Promise<number | null> {
  const res = await ghFetch(`/repos/${REPO}/issues/${PR_NUMBER}/comments?per_page=100`);
  if (!res.ok) return null;
  const comments = (await res.json()) as Array<{ id: number; body: string }>;
  const found = comments.find((c) => c.body.includes(REVIEW_MARKER));
  return found?.id ?? null;
}

async function upsertSummaryComment(body: string): Promise<void> {
  const existingId = await findExistingSummaryComment();
  if (existingId) {
    await ghFetch(`/repos/${REPO}/issues/comments/${existingId}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    });
    console.log(`Updated existing summary comment #${existingId}`);
  } else {
    await ghFetch(`/repos/${REPO}/issues/${PR_NUMBER}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    console.log('Created new summary comment');
  }
}

async function postReviewComments(review: ReviewOutput, diff: string): Promise<void> {
  if (review.comments.length === 0) {
    console.log('No inline comments to post');
    return;
  }

  const validLines = parseDiffValidLines(diff);

  const severityLabel: Record<string, string> = {
    issue: '🔴 **Issue**',
    suggestion: '🟡 **Suggestion**',
    nitpick: '⚪ **Nitpick**',
  };

  const comments = review.comments
    .filter((c) => {
      const fileLines = validLines.get(c.file);
      if (!fileLines?.has(c.line)) {
        console.warn(`Skipping comment on ${c.file}:${c.line} — line not in diff patch`);
        return false;
      }
      return true;
    })
    .map((c) => ({
      path: c.file,
      line: c.line,
      side: 'RIGHT' as const,
      body: `${severityLabel[c.severity] ?? c.severity}\n\n${c.comment}`,
    }));

  if (comments.length === 0) {
    console.log('No inline comments within diff lines to post');
    return;
  }

  const res = await ghFetch(`/repos/${REPO}/pulls/${PR_NUMBER}/reviews`, {
    method: 'POST',
    body: JSON.stringify({ commit_id: HEAD_SHA, event: 'COMMENT', comments }),
  });

  if (!res.ok) {
    console.warn(`Batch review failed (${res.status}): ${await res.text()}`);
    return;
  }

  console.log(`Posted review with ${comments.length} inline comment(s)`);
}

async function main(): Promise<void> {
  // Read diff
  let diff = '';
  try {
    diff = readFileSync('/tmp/pr.diff', 'utf8');
  } catch {
    console.error('Could not read /tmp/pr.diff');
    process.exit(1);
  }

  let truncated = false;
  if (Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES) {
    diff = diff.slice(0, MAX_DIFF_BYTES) + '\n\n[... diff truncated at 100 KB — only the first portion was reviewed ...]';
    truncated = true;
    console.warn('Diff exceeded 100 KB, truncated before sending to agent');
  }

  if (!diff.trim()) {
    console.log('Empty diff — nothing to review');
    process.exit(0);
  }

  // Call agent
  // llama-3.3-70b-versatile supports json_object but NOT json_schema,
  // so we skip structuredOutput (which sends json_schema) and parse manually.
  let review: ReviewOutput;
  try {
    const result = await reviewAgent.generate(
      `Please review the following git diff and return a structured JSON code review:\n\n${diff}`,
      {
        providerOptions: {
          groq: { response_format: { type: 'json_object' } },
        },
      }
    );

    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON object in response: ${result.text.slice(0, 200)}`);
    review = reviewSchema.parse(JSON.parse(jsonMatch[0]));
  } catch (err) {
    console.error('Agent call failed or returned invalid JSON:', err);
    process.exit(0); // don't fail the workflow on inference errors
  }

  console.log(`Review: ${review!.comments.length} comment(s)`);

  // Build summary comment body
  const truncatedNote = truncated
    ? '\n\n> ⚠️ **Diff was truncated** — this review covers only the first 100 KB of the diff.'
    : '';
  const commentsNote =
    review!.comments.length > 0
      ? `\n\n**${review!.comments.length} inline comment(s)** posted directly on the changed lines.`
      : '\n\n✅ No issues found — looks good!';

  const summaryBody = `${REVIEW_MARKER}\n### 🤖 AI Code Review\n\n${review!.summary}${commentsNote}${truncatedNote}`;

  await upsertSummaryComment(summaryBody);
  await postReviewComments(review!, diff);
}

await main();
