# TODO_MEM.md — Ban Evasion Detection via Behavioral Memory

## Why Memory is Required

Ban evasion detection fundamentally requires **remembering banned users' behavioral patterns** and comparing new accounts against them. Without memory, every new account is a blank slate — you can't detect that `user_new_2024` writes exactly like `banned_user_xyz`.

Reddit's own ban evasion detection uses IP, device fingerprints, cookies, and browser signals — **none of which are available to Devvit apps**. As a Devvit app, you only have access to:

- Username
- Account age (createdAt)
- Karma (link + comment)
- Post/comment text content
- Subreddit activity (within your installed sub)
- Moderation actions (ban list)

This means **behavioral fingerprinting via writing style and activity patterns** is the only viable approach for a Devvit app.

## Why Redis Memory (Not External DB)

| Approach | Verdict |
|----------|---------|
| External DB (Supabase, Firebase) | Requires domain approval, adds latency, extra cost |
| Devvit Redis | Built-in, free, fast, no domain approval needed, persists across sessions |
| In-memory (JS variables) | Lost on every cold start — useless |
| LLM context window | Too expensive, no persistence, token limits |

**Devvit Redis is the only practical choice.** It's already available in your stack, requires no external calls, and persists indefinitely.

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                  TRIGGER LAYER                        │
│  onPostCreate / onCommentCreate                      │
│  Extract: username, text, timestamp, karma, age      │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│              FINGERPRINT BUILDER                      │
│  Build behavioral vector from text:                  │
│  - avg sentence length                               │
│  - punctuation patterns (!!!, ..., caps ratio)       │
│  - vocabulary markers (unique phrases, slang)        │ 
│  - posting time patterns (hour-of-day buckets)       │
│  - subreddit topic affinity                          │
│  - formatting habits (markdown usage, line breaks)   │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│              MEMORY STORE (Redis)                   │
│                                                     │
│  banned_profiles:{subredditId}:{username}           │
│    → JSON: behavioral fingerprint of banned user    │
│                                                     │
│  user_activity:{subredditId}:{username}             │
│    → JSON: rolling window of recent activity signals│
│                                                     │
│  evasion_alerts:{subredditId}                       │
│    → ZSET: flagged usernames scored by similarity   │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│              COMPARISON ENGINE                       │
│  On each new post/comment from fresh accounts:       │
│  1. Build fingerprint for current user               │
│  2. Compare against all banned_profiles              │
│  3. Compute similarity score (cosine or weighted)    │
│  4. If score > threshold → flag as potential evasion │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│              ACTION LAYER                             │
│  - Low confidence: add to mod review queue           │
│  - Medium confidence: auto-flag + notify mods        │
│  - High confidence: auto-remove + queue for ban      │
└─────────────────────────────────────────────────────┘
```

## Behavioral Signals (What We Can Fingerprint)

These are computable from post/comment text without any external API:

| Signal | How | Weight |
|--------|-----|--------|
| Sentence length distribution | avg words/sentence, std dev | 15% |
| Punctuation style | frequency of `...`, `!!!`, `;`, `—` | 10% |
| Capitalization ratio | % uppercase chars, ALL CAPS words | 10% |
| Vocabulary fingerprint | top N trigrams, unique word set hash | 25% |
| Formatting habits | markdown usage, paragraph length, list style | 10% |
| Posting time pattern | hour-of-day histogram (24 buckets) | 10% |
| Topic affinity | keyword categories from post content | 10% |
| Account meta signals | new account + high activity = suspicious | 10% |

## Why This Approach (Not Alternatives)

### Why not just use LLM comparison?
- **Cost**: Comparing every new user against every banned user via Gemini = expensive at scale
- **Latency**: LLM calls take 1-3s, too slow for real-time trigger processing
- **Token limits**: Banned user history could be large

### Why not IP/device fingerprinting?
- **Not available**: Devvit apps have zero access to IP, cookies, browser fingerprint, device ID
- **Reddit handles this internally**: Their own system already does this layer

### Why behavioral fingerprinting works?
- Writing style is surprisingly unique and hard to change
- People reuse phrases, punctuation habits, and timing patterns unconsciously
- Academic research shows stylometry can identify authors with 80%+ accuracy from ~500 words
- Combined with account-age + karma signals, false positive rate drops significantly

### Why Redis specifically?
- Zero additional infrastructure
- Sub-millisecond reads for comparison
- ZSET gives ranked similarity results for free
- JSON storage handles flexible fingerprint schemas
- Already in your stack (`src/server/mod/store.ts`)

## Redis Key Design

```
# Fingerprint of a banned user (stored on ban action)
banned_fp:{subredditId}:{username} → JSON {
  avgSentenceLen: number,
  punctuationProfile: number[],  // frequency of 5 punctuation categories
  capsRatio: number,
  topTrigrams: string[],         // top 20 trigrams
  hourHistogram: number[],       // 24 buckets
  sampleCount: number,           // how many posts built this profile
  bannedAt: number
}

# Rolling activity for active users (updated on each post/comment)
user_fp:{subredditId}:{username} → JSON {
  avgSentenceLen: number,
  punctuationProfile: number[],
  capsRatio: number,
  topTrigrams: string[],
  hourHistogram: number[],
  sampleCount: number,
  lastUpdated: number
}

# Evasion alert queue
evasion_alerts:{subredditId} → ZSET (score = similarity, member = "newUser:matchedBannedUser")
```

## Implementation Tasks

### Phase 1: Fingerprint Infrastructure
- [ ] Create `src/server/mod/fingerprint.ts`
  - `buildFingerprint(texts: string[], timestamps: number[])` → FingerprintVector
  - `compareFingerpints(a, b)` → similarity score (0-1)
- [ ] Add Redis read/write helpers in `store.ts`
  - `writeBannedFingerprint(subredditId, username, fp)`
  - `readAllBannedFingerprints(subredditId)`
  - `writeUserFingerprint(subredditId, username, fp)`
  - `readUserFingerprint(subredditId, username)`
  - `writeEvasionAlert(subredditId, newUser, bannedUser, score)`

### Phase 2: Data Collection
- [ ] On every `onPostCreate` / `onCommentCreate` trigger:
  - Update rolling fingerprint for the posting user
  - Only process accounts < 30 days old for comparison (performance)
- [ ] On every ban action (via mod-action endpoint):
  - Snapshot the banned user's fingerprint from their activity history
  - Store in `banned_fp:{subredditId}:{username}`

### Phase 3: Comparison Engine
- [ ] After updating a new user's fingerprint (if sampleCount >= 3):
  - Compare against all banned fingerprints for that subreddit
  - If similarity > 0.75 → write evasion alert
- [ ] Add `/api/evasion-alerts` endpoint for dashboard

### Phase 4: Dashboard Integration
- [ ] Add "Ban Evasion Suspects" tab in frontend
  - Show flagged users with similarity score and matched banned user
  - Allow mod to confirm (ban) or dismiss (whitelist)

### Phase 5: LLM Enhancement (Optional)
- [ ] For high-similarity matches (>0.85), use Gemini to do a final semantic comparison
  - Send 3 samples from banned user + 3 from suspect
  - Ask: "Are these likely the same author? Return confidence 0-1"
  - This is the expensive path — only triggered for strong candidates

## Thresholds

| Similarity Score | Action |
|-----------------|--------|
| < 0.60 | Ignore |
| 0.60 - 0.74 | Log only (for tuning) |
| 0.75 - 0.84 | Add to evasion review queue |
| 0.85 - 0.94 | Auto-flag + notify mods |
| >= 0.95 | Auto-remove posts + queue for ban |

## Constraints & Limitations

- **Minimum data needed**: At least 3 posts/comments to build a meaningful fingerprint
- **Cold start**: New banned users with <3 posts won't have a useful fingerprint
- **Determined evaders**: Someone who consciously changes writing style can evade this
- **Scale**: Comparing against 100+ banned profiles per trigger needs optimization (batch, pre-filter by account age overlap)
- **Privacy**: Only stores derived signals, not raw post content — fingerprints are not reversible to original text
