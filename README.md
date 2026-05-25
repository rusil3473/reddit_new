## Modecule
Modecule is a Devvit Web moderation dashboard for Reddit moderators. It provides:
- Queue risk scoring and triage
- Escalated queue for posts needing senior review
- Adaptive learning from mod decisions
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
- Adaptive learning: Jaccard similarity-based feedback loop

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
  - Fetches learning signals and passes to scoring
- `src/server/mod/llm.ts`
  - Learning signal types and functions
  - `scoreWithLearning` wrapper (adaptive scoring)
  - `extractFingerprint` and `applyLearningAdjustment` utilities
- `src/server/mod/llm-router.ts`
  - Routes scoring to configured LLM provider (Gemini/HuggingFace)
- `src/server/mod/providers/gemini.ts`
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
- Header:
  - "MODECULE" branding on left
  - Community name `r/modecule_dev` on right
- Stat cards (7 total):
  - Processed, Removed today, Approved today, In queue, Escalated, Processed Reports, Reported Queue
  - "In queue" uses live client-side `queuePosts.length`
  - "Escalated" uses live client-side `escalatedPosts.length`
  - "Processed Reports" uses live client-side `processedPosts.length`
  - "Reported Queue" uses live client-side `reportedPosts.length`
- Tabs:
  - Priority Queue (with Refresh button)
  - Escalated Queue
  - Reported Posts
  - Processed Reports
  - Audit Log
  - Rules
- Priority Queue features:
  - Sort by risk/lowest risk/newest
  - Select all / bulk actions
  - Auto Approve / Auto Remove threshold buttons
  - Per-post Approve / Remove / Escalate buttons
  - Refresh button to fetch latest posts
- Escalated Queue features:
  - Shows posts that were escalated by moderators
  - Per-post Approve / Remove buttons
- Review bar:
  - Fixed at bottom of viewport when posts are selected
  - Shows: Approve all, Remove all, Escalate all
- Action flow:
  - Approve/Remove → post goes to audit log only
  - Escalate → post goes to audit log + escalated queue
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
  - Returns: `{ type: "QUEUE_POSTS_RESPONSE", posts: QueuePost[] }`
  - Filters out dashboard posts (title containing "Smart Intelligent Queue Dashboard")
  - Applies live learning adjustments to scores
  - Sorted by adjusted score descending
- `GET /stats`
  - Returns: `{ type: "STATS_RESPONSE", processed, removed, approved, inQueue, reported }`
  - `inQueue` is computed live from queue items (excluding dashboard posts)

### Escalated Queue
- `GET /escalated`
  - Returns: `{ type: "ESCALATED_POSTS_RESPONSE", posts: QueuePost[] }`
  - Posts that moderators escalated for further review
- `POST /escalated-action`
  - Body: `{ action: "approve" | "remove", postId: string }`
  - Removes post from escalated queue and applies the action

### Moderation Actions
- `POST /mod-action`
  - Body: `{ action: "approve" | "remove" | "escalate", postId: string }`
  - On escalate: adds to escalated queue + writes audit entry
  - On approve/remove: applies action + stores learning signal + stores author action history
- `POST /bulk-action`
  - Body: `{ action: "approve" | "remove" | "escalate", postIds: string[] }`

### Existing Dashboard APIs
- `GET /dashboard?page=&pageSize=`
- `GET /reported-posts?page=&pageSize=&sort=count|recent&status=active|processed`
- `GET /audit?page=&pageSize=`
- `GET /rules`
- `POST /rules`
  - body: `{ autoApproveThreshold: number, autoRemoveThreshold: number, communityRules: string[] }`
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
3. Fetch learning signals:
   - Reads all entries from `learning:signals` sorted set.
4. Adaptive LLM score:
   - Calls `scoreWithLearning(payload, rules, pastSignals)` from `llm.ts`.
   - This internally calls `scoreLLM` (via llm-router) then applies learning adjustments.
5. Safety override:
   - Critical scam detector in pipeline can force high-risk score + remove action.
6. Persist:
   - Writes score record
   - Optionally enqueues post in risk queue
   - No audit entry written at scoring time (audit only on mod actions)

## Adaptive Learning System
`src/server/mod/llm.ts`

### Concept
When a moderator actions a post, the decision is stored as a learning signal. Future posts with similar content get their scores adjusted based on past decisions. This makes the scorer progressively smarter per-subreddit.

### Learning Signal Storage
- Triggered on every approve/remove mod action
- Extracts keyword fingerprint from post title + body (top 12 tokens, stopwords removed, min 4 chars)
- Stored in Redis sorted set `learning:signals` with timestamp as score
- Capped at 500 most recent signals

### Score Adjustment (on queue read + new post scoring)
- Computes Jaccard similarity between new post fingerprint and each stored signal
- Signals with similarity >= 0.25 contribute:
  - Remove signals push score upward
  - Approve signals push score downward
  - Weight: `direction * similarity * 0.15` per signal
- Normalized adjustment applied to base LLM score
- If adjustment > 0.05, adds reason chip ("Similar to past moderated/approved content")

### Key Functions
- `extractFingerprint(title, body)` → `string[]`
- `scoreWithLearning(request, rules, pastSignals)` → `LLMScore`
- `applyLearningAdjustment(baseScore, title, body, pastSignals)` → `number`

### Per-Author Action History (future ban evasion)
- On every mod action, stores action record in `author:actions:{authorName}`
- JSON list capped at 50 entries per author
- Fields: postId, action, score, fingerprint, timestamp
- Data collection only — no logic built on top yet

## Gemini Scoring Module
`src/server/mod/providers/gemini.ts`

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
- `escalated:{subredditId}`: JSON list of escalated post IDs
- `learning:signals`: ZSET of learning signal JSON entries (score = timestamp)
- `author:actions:{authorName}`: JSON list of per-author action history

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
4. Queue endpoint filters out posts with dashboard title.

## Escalated Queue
- Posts escalated by moderators are stored in `escalated:{subredditId}` Redis key
- `GET /api/escalated` returns all escalated posts with score data
- `POST /api/escalated-action` allows approve/remove on escalated posts (removes from escalated list)
- Frontend "Escalated Queue" tab shows these posts with Approve/Remove buttons

## Bulk + Auto Threshold Actions
Frontend supports:
- Manual bulk actions over selected posts
- Auto threshold actions:
  - Auto Approve: `score <= autoApproveThreshold`
  - Auto Remove: `score >= autoRemoveThreshold`

Both call backend `POST /api/bulk-action`.

## Important Functions (Backend)
- `scoreWithGemini(...)` in `providers/gemini.ts`
  - LLM scoring + robust parse
- `scoreWithLearning(...)` in `llm.ts`
  - Wraps scoreLLM with adaptive learning adjustments
- `applyLearningAdjustment(...)` in `llm.ts`
  - Applies learning signal adjustments to a given score (used in queue read)
- `extractFingerprint(...)` in `llm.ts`
  - Extracts keyword tokens for similarity matching
- `scoreContent(...)` in `pipeline.ts`
  - Scoring orchestration + dedupe + SIQ + learning + safety override
- `applyAction(...)` in `pipeline.ts`
  - Approve/remove action path + queue/report/audit updates
- `writeScoreRecord(...)` in `store.ts`
  - Persist score and enqueue (optional)
- `readQueueItems(...)` in `store.ts`
  - Read ranked queue from ZSET + score hashes
- `addEscalatedPost(...)` / `removeEscalatedPost(...)` / `readEscalatedPosts(...)` in `store.ts`
  - Escalated queue CRUD

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
- Learning signals are stored globally (not per-subreddit) — consider namespacing if multi-sub support is needed.
- Per-author action history is data collection only; no ban evasion logic built yet.

## Recommended Next Improvements
1. Move Gemini credentials to secure runtime secrets/env.
2. Add automated eval suite for scoring quality (scam vs benign set).
3. Add unit tests for `pipeline.ts` critical branches:
   - dedupe path
   - SIQ path
   - scam override path
   - learning adjustment path
4. Convert audit storage from JSON list to sorted structure for larger scale.
5. Namespace `learning:signals` per subreddit for multi-community support.
6. Build ban evasion detection using stored `author:actions` data.
7. Add decay factor to learning signals (older signals have less weight).
