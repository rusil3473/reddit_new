## Modecule
Modecule is a Devvit Web moderation dashboard for Reddit moderators. It provides:
- Queue risk scoring and triage
- Bulk moderation actions
- Audit visibility
- Rules/threshold tuning
- Moderator-only API access control

This README is written as an implementation reference for humans and coding tools.

## Stack
- Frontend: React 19 + Tailwind CSS 4 (Vite build)
- Backend: Hono server in Devvit runtime (`@devvit/web/server`)
- Persistence: Devvit Redis
- LLM scoring: Gemini API (with strict JSON output + resilient parsing)

## Runtime Architecture
- `src/server/index.ts`
- Hono app root
- Public API mounted at `/api/*`
- Internal routes mounted at `/internal/*`
- `src/server/routes/api.ts`
- Dashboard/business API used by frontend
- Enforces moderator-only access
- `src/server/routes/triggers.ts`
- Handles Devvit triggers (`onPostCreate`, `onPostReport`, etc.)
- `src/server/routes/menu.ts`
- Moderator menu action to create dashboard post
- `src/server/mod/pipeline.ts`
- Scoring/action orchestration
- `src/server/mod/llm.ts`
- Gemini prompt + response parsing
- `src/server/mod/store.ts`
- Redis data access layer

## Devvit Config
- `devvit.json`
- Post entrypoints:
- `splash.html` (inline/default)
- `game.html` (main dashboard)
- Internal menu item:
- `Open SIQ Dashboard` (moderators only)
- Triggers:
- `onAppInstall`, `onPostCreate`, `onCommentCreate`, `onPostReport`
- Dev subreddit:
- `modecule_dev`

## Frontend Overview
- Main UI:
- `src/client/game.tsx`
- Main features:
- Priority Queue view (live data from `/api/queue`)
- Reported Posts view (live data from `/api/reported-posts`)
- Audit Log and Rules tabs
- Bulk selection + bulk actions
- Auto threshold actions (`Auto Approve`, `Auto Remove`)
- Top-right toasts
- Score bar semantics:
- `score` is reject chance from `0.0` to `1.0`
- Left = more approveable, right = more rejectable
- Access control UX:
- Frontend first calls `/api/access`
- Non-mod users see access denied state

## Moderator Access Control
Implemented in `src/server/routes/api.ts`:
- `GET /api/access` returns `{ success, isModerator }`
- Middleware on `/api/*` (except `/api/access`) checks current user mod permissions for target subreddit
- Non-moderators receive `403`:
- `{ success: false, error: "moderator_access_required" }`

## API Endpoints
All routes below are under `/api`.

### Access
- `GET /access`
- Response: `{ success: true, isModerator: boolean }`

### Queue + Stats
- `GET /queue`
- Returns:
- `{ type: "QUEUE_POSTS_RESPONSE", posts: QueuePost[] }`
- Sorted by score descending
- `GET /stats`
- Returns:
- `{ type: "STATS_RESPONSE", processed, removed, approved, inQueue, reported }`

### Moderation Actions
- `POST /mod-action`
- Body:
- `{ action: "approve" | "remove" | "escalate", postId: string }`
- `POST /bulk-action`
- Body:
- `{ action: "approve" | "remove" | "escalate", postIds: string[] }`

### Existing Dashboard APIs
- `GET /dashboard?page=&pageSize=`
- `GET /reported-posts?page=&pageSize=&sort=count|recent&status=active|processed`
- `GET /audit?page=&pageSize=`
- `GET /rules`
- `POST /rules`
- body:
- `{ autoApproveThreshold: number, autoRemoveThreshold: number, communityRules: string[] }`
- `POST /score-content`
- `POST /action/approve`
- `POST /action/remove`
- `POST /action/claim`
- `POST /action/escalate`
- `GET /bulk/preview`
- `POST /bulk/apply`

## Triggers
Implemented in `src/server/routes/triggers.ts`.

### `on-app-install`
- Creates a dashboard custom post
- Registers created post ID as SIQ post ID

### `on-post-create`
- Builds score payload from trigger event
- Calls `scoreContent(subredditId, payload)`

### `on-post-report`
- Increments report metadata
- Rescores post when report count reaches threshold (`>=3`)

### `on-comment-create`
- Currently acknowledged only

## Scoring Pipeline
Core entrypoint: `scoreContent(subredditId, payload)` in `src/server/mod/pipeline.ts`.

Flow:
1. Deduplicate:
- If score record already exists and incoming report count is not higher, return existing score.
2. SIQ check:
- If post ID is in SIQ set, force `suggested_action = approve`, do not enqueue, auto-approve post.
3. LLM score:
- Calls `scoreWithGemini(payload, rules)` from `llm.ts`.
4. Safety override:
- Critical scam detector in pipeline can force high-risk score + remove action.
5. Persist:
- Writes score record
- Optionally enqueues post in risk queue
- Writes audit entry

## Gemini Scoring Module
`src/server/mod/llm.ts`

Responsibilities:
- Build moderation prompt with scoring rubric and community rules
- Call Gemini `generateContent`
- Parse JSON output robustly:
- Removes code fences
- Extracts first JSON object from mixed output
- Normalizes output into:
- `{ score, label, reasons, suggested_action }`

Notes:
- The code currently contains a hardcoded API key for development convenience.
- Move to environment/secret management before production.

## Redis Data Model
`src/server/mod/store.ts`

Key patterns:
- `score:{subredditId}:{postId}`: score record hash
- `queue:{subredditId}`: ZSET of queued post IDs by score
- `report_meta:{subredditId}:{postId}`: report metadata hash
- `reports:{subredditId}:{postId}`: integer report count
- `reported_posts:{subredditId}`: JSON list of reported post IDs
- `audit:{subredditId}`: JSON list of audit entries
- `stats:{subredditId}:{metric}`: summary metrics
- `rules:{subredditId}`: moderation rules JSON
- `siq_posts:{subredditId}`: JSON list of dashboard post IDs to auto-approve/skip queue

Additional global-style stats keys used by `/api/stats`:
- `stats:processed`
- `stats:removed`
- `stats:approved`
- `stats:reported`
- `queue:length`

## SIQ Dashboard Post Handling
SIQ dashboard posts should not appear in moderation queue.

How it works:
1. Dashboard post IDs are registered by:
- `src/server/routes/menu.ts`
- `src/server/routes/triggers.ts` (`on-app-install`)
2. During scoring, `pipeline.ts` checks `isSiqPostId(...)`.
3. If true:
- post is auto-approved
- score record written without queue insertion
- reason is `siq_dashboard_post_auto_approved`

## Bulk + Auto Threshold Actions
Frontend supports:
- Manual bulk actions over selected posts
- Auto threshold actions:
- Auto Approve: `score <= autoApproveThreshold`
- Auto Remove: `score >= autoRemoveThreshold`

Both call backend `POST /api/bulk-action`.

## Important Functions (Backend)
- `scoreWithGemini(...)` in `llm.ts`
- LLM scoring + robust parse
- `scoreContent(...)` in `pipeline.ts`
- Scoring orchestration + dedupe + SIQ + safety override
- `applyAction(...)` in `pipeline.ts`
- Approve/remove action path + queue/report/audit updates
- `writeScoreRecord(...)` in `store.ts`
- Persist score and enqueue (optional)
- `readQueueItems(...)` in `store.ts`
- Read ranked queue from ZSET + score hashes

## Local Development
Requirements:
- Node.js 22+

Commands:
- `npm run dev`: Devvit playtest loop
- `npm run build`: Build client + server
- `npm run type-check`: TypeScript build check
- `npm run lint`: ESLint checks
- `npm run deploy`: Upload new app version
- `npm run launch`: Publish for review

## Known Limitations / Notes
- Some lint warnings remain around React Fast Refresh component export style.
- Hardcoded Gemini API key should be replaced with secure secret handling.
- Trigger payload fields like account age are currently approximated in `triggers.ts`.
- `/api/stats` combines subreddit summary with global-style counters; consider unifying key strategy if needed.

## Recommended Next Improvements
1. Move Gemini credentials to secure runtime secrets/env.
2. Add automated eval suite for scoring quality (scam vs benign set).
3. Add unit tests for `pipeline.ts` critical branches:
- dedupe path
- SIQ path
- scam override path
4. Convert audit storage from JSON list to sorted structure for larger scale.
