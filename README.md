# Modecule

Modecule is a Devvit Web moderation dashboard for Reddit moderators. It helps teams triage risk quickly, apply bulk actions, and continuously improve moderation scoring from real moderator decisions.

## Highlights
- Queue risk scoring and triage
- Escalated queue for senior review
- Adaptive learning from moderator actions
- Bulk moderation actions and threshold-based automation
- Audit visibility
- Rules and threshold tuning
- Moderator-only API access control

## Tech Stack
- Frontend: React 19, Tailwind CSS 4, Vite
- Backend: Devvit Web serverless runtime (`@devvit/web/server`), Hono
- Persistence: Devvit Redis
- Scoring: Gemini API via provider router with resilient JSON parsing
- Learning loop: Jaccard similarity-based score adjustment

## Project Layout
- `src/server`
  - `index.ts`: Hono app root (`/api/*`, `/internal/*`)
  - `routes/api.ts`: Frontend API + moderator authorization middleware
  - `routes/triggers.ts`: Trigger handlers (`onPostCreate`, `onPostReport`, etc.)
  - `routes/menu.ts`: Mod menu action to create/open dashboard post
  - `mod/pipeline.ts`: scoring/action orchestration
  - `mod/llm.ts`: learning signal logic + adaptive score utilities
  - `mod/llm-router.ts`: model/provider routing
  - `mod/providers/gemini.ts`: Gemini prompt + parser
  - `mod/store.ts`: Redis data access layer
- `src/client`
  - `splash.html`: lightweight inline/feed entrypoint
  - `game.html`: main dashboard entrypoint
  - `game.tsx`: main dashboard UI
- `src/shared`
  - shared types/utilities

## Devvit Configuration
`devvit.json` includes:
- Post entrypoints: `splash.html`, `game.html`
- Internal menu item: `Open SIQ Dashboard` (moderators only)
- Triggers: `onAppInstall`, `onPostCreate`, `onCommentCreate`, `onPostReport`
- Dev subreddit: `modecule_dev`

## Frontend Overview
- Header with MODECULE branding and target community
- Stat cards for queue/actions/report activity
- Tabs:
  - Priority Queue
  - Escalated Queue
  - Reported Posts
  - Processed Reports
  - Audit Log
  - Rules
- Priority Queue capabilities:
  - sort by risk/newest
  - select-all + bulk actions
  - auto-approve/remove by threshold
  - per-post approve/remove/escalate
- Escalated Queue supports follow-up approve/remove actions
- Review bar appears when selections exist

## Access Control
- `GET /api/access` returns moderator status
- Middleware on `/api/*` (except `/api/access`) enforces moderator access
- Non-moderators receive `403` with `moderator_access_required`

## API Summary
All endpoints below are under `/api`.

### Access
- `GET /access`

### Queue and Stats
- `GET /queue`
- `GET /stats`

### Escalation
- `GET /escalated`
- `POST /escalated-action` with `{ action: "approve" | "remove", postId }`

### Moderation Actions
- `POST /mod-action` with `{ action: "approve" | "remove" | "escalate", postId }`
- `POST /bulk-action` with `{ action, postIds }`

### Existing Dashboard Routes
- `GET /dashboard?page=&pageSize=`
- `GET /reported-posts?page=&pageSize=&sort=count|recent&status=active|processed`
- `GET /audit?page=&pageSize=`
- `GET /rules`
- `POST /rules`
- `POST /score-content`
- `POST /action/approve`
- `POST /action/remove`
- `POST /action/claim`
- `POST /action/escalate`
- `GET /bulk/preview`
- `POST /bulk/apply`

## Trigger Flow
- `on-app-install`: creates dashboard post and registers SIQ post ID
- `on-post-create`: builds scoring payload and scores content
- `on-post-report`: increments report metadata and re-scores at threshold
- `on-comment-create`: currently acknowledged only

## Scoring Pipeline
Main entrypoint: `scoreContent(subredditId, payload)` in `src/server/mod/pipeline.ts`.

1. Deduplicate by existing score/report count
2. Skip + auto-approve SIQ dashboard posts
3. Load learning signals
4. Score with model and apply adaptive learning adjustment
5. Apply deterministic safety overrides (critical scam patterns)
6. Persist score and optionally enqueue

## Adaptive Learning
Implemented in `src/server/mod/llm.ts`.

- Stores moderator decisions as learning signals
- Extracts keyword fingerprint (title + body)
- Applies Jaccard similarity against past signals
- Similar "remove" outcomes raise score; similar "approve" outcomes lower score
- Adds explanatory reason chips for meaningful adjustments

Also stores per-author action history at `author:actions:{authorName}` for future anti-abuse logic.

## Redis Data Model
Primary key families:
- `score:{subredditId}:{postId}`
- `queue:{subredditId}`
- `report_meta:{subredditId}:{postId}`
- `reports:{subredditId}:{postId}`
- `reported_posts:{subredditId}`
- `audit:{subredditId}`
- `stats:{subredditId}:{metric}`
- `rules:{subredditId}`
- `siq_posts:{subredditId}`
- `escalated:{subredditId}`
- `learning:signals`
- `author:actions:{authorName}`

## Local Development
Requirements:
- Node.js 22+

Commands:
- `npm run dev`
- `npm run build`
- `npm run type-check`
- `npm run lint`
- `npm run deploy`
- `npm run launch`

## Security Notes
- Do not keep provider API keys in source.
- Use Devvit/runtime secret management for Gemini credentials.
- Rotate secrets and document operational ownership.

## Known Limitations
- Some lint warnings still exist around React Fast Refresh export style.
- Trigger payload fields like account age are currently approximated.
- Learning signals are currently global and not namespaced per subreddit.
- Per-author history is stored but not yet used for enforcement decisions.

## Recommended Next Steps
1. Move Gemini credentials fully to secrets/env.
2. Add integration tests for moderator access enforcement.
3. Add regression tests for scoring and deterministic scam overrides.
4. Scale audit storage from JSON list to sorted structure.
5. Namespace learning signals per subreddit.
6. Build anti-abuse features using author action history.

## Reference
- Devvit docs: https://developers.reddit.com/docs/llms.txt
