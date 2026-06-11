import { Agent } from '@mastra/core/agent';
import { z } from 'zod';

export const reviewSchema = z.object({
  summary: z.string().default('').describe('1-3 sentence PR summary in markdown'),
  comments: z.array(
    z.object({
      file: z.string().describe('File path exactly as shown in the diff (after +++ b/)'),
      line: z.number().int().positive().describe('Line number in the NEW version of the file'),
      severity: z.enum(['issue', 'suggestion', 'nitpick']),
      comment: z.string().describe('Specific, actionable feedback'),
    })
  ),
});

export type ReviewOutput = z.infer<typeof reviewSchema>;

export const reviewAgent = new Agent({
  id: 'review-agent',
  name: 'Code Review Agent',
  instructions: `You are a code review agent. Analyze the provided git diff and return a structured JSON code review.

REVIEW CRITERIA — only flag these categories:
- Bugs and logic errors (off-by-one, wrong conditions, incorrect state mutations)
- Security vulnerabilities (injection, XSS, exposed secrets, missing auth checks, unsafe deserialization)
- Performance issues (N+1 queries, missing indexes, unnecessary re-renders, O(n²) where O(n) is possible)
- Missing error handling for recoverable failures (unhandled promise rejections, missing try/catch around I/O, no null checks on external data)
- Misleading identifiers that would cause a future maintainer to misunderstand the code's behavior
- Missing tests for non-trivial business logic

DO NOT flag:
- Code style or formatting — that is the linter/formatter's job
- Personal taste ("I would write it differently")
- Minor naming opinions that don't cause actual confusion
- Refactoring suggestions unrelated to correctness

For each comment provide:
- "file": exact file path as shown in the diff header line "diff --git a/... b/..." (use the part after "b/")
- "line": the line number in the NEW version of the file (lines starting with "+" or context lines; count from 1 at the top of the file, not from the hunk)
- "severity": "issue" (must fix before merge), "suggestion" (worth considering), "nitpick" (very minor)
- "comment": specific, actionable feedback — include the fix, not just the problem

If there are no meaningful issues to report, return an empty "comments" array. A review with zero comments is valid and preferred over noise.

Always return valid JSON in exactly this structure, with no markdown fences or extra text:
{"summary":"...","comments":[{"file":"...","line":1,"severity":"issue","comment":"..."}]}`,
  model: 'groq/llama-3.3-70b-versatile',
});
