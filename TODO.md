## Modecule TODO Roadmap

## P0 - Must Do (Reliability + Security)
- Move LLM credentials out of source code.
- Remove hardcoded Gemini API key from `src/server/mod/llm.ts`.
- Load keys from environment/secrets only.
- Add secret rotation notes in README.

- Add strict moderator auth test coverage.
- Validate every `/api/*` route returns `403` for non-moderators.
- Add integration tests for `/api/access` and middleware.

- Strengthen scoring safety checks.
- Keep Gemini as primary semantic scorer.
- Keep deterministic critical-scam override in `pipeline.ts`.
- Add regression test cases for high-risk scam phrases and paraphrases.

- Add backend request idempotency guard.
- Ensure repeated trigger events for same `postId` do not duplicate actions.
- Keep dedupe-by-postId/reportCount behavior stable.

## P1 - Local/Open LLM Migration Path
- Make LLM provider pluggable.
- Add `LLM_PROVIDER` switch: `gemini | huggingface | local`.
- Keep one scoring response schema across all providers.

- Add Hugging Face provider support.
- Implement provider client in `llm.ts` (router API style).
- Keep strict JSON parsing and fallback behavior.


- Build A/B evaluation harness.
- Create labeled dataset from real moderation examples.
- Compare Gemini vs HF/local on:
- scam recall
- false positive rate
- latency p50/p95
- JSON validity rate

- Define migration decision rule.
- Example: move to open model only if scam recall drop is <= 3% and p95 latency remains acceptable.

## P1 - Product Quality
- Persist Rules tab changes end-to-end.
- Save `autoApproveThreshold`, `autoRemoveThreshold`, and `communityRules`.
- Reload rules on app open.

- Improve auto actions UX.
- Add confirmation modal before Auto Remove.
- Show matched post count before executing auto action.

- Improve audit log quality.
- Include action source (`manual`, `bulk`, `auto-threshold`).
- Include threshold values used at action time.

## P2 - Performance + Scale
- Replace JSON-list audit storage with sorted set for large scale.
- Add pagination cursor strategy for queue and audit APIs.

- Add queue caching and stale-while-revalidate strategy.
- Reduce repeated score record reads in `/api/queue`.

- Add basic rate limiting / abuse guard for action endpoints.

## P2 - UI Improvements
- Add non-mod denied screen action.
- Include "Contact moderators" or modmail link.

- Improve empty/loading states.
- Add skeleton consistency across queue and reported tabs.

## P3 - Nice to Have
- Add scoring explanation drawer for each post.
- Show top contributing factors from model + deterministic overrides.

- Add model health dashboard.
- Error rate, timeout rate, parse-failure rate, avg latency.

- Add multi-subreddit support controls for future expansion.

## Opinionated Recommendations
- Keep hybrid scoring permanently.
- Use LLM for semantic detection + deterministic safety layer for known critical abuse classes.

- Do not go fully local too early.
- Start with hosted open-model API first, then self-host only when volume justifies ops overhead.

- Track quality continuously.
- A small fixed benchmark set should run before each release.

- Prefer false positives over false negatives for critical scam classes.
- Safer moderation defaults reduce community harm.


-git commit 
-Change score in audit + five history to gemini for better scoring 
-ban evasion dashboard modification UI+boht sara logic change 
