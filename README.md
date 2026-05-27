# Inspiration Scrolling

A nightly, prepared feed of project ideas, codebase suggestions, and learning material — built to replace late-night doomscrolling with something that nudges your brain toward making things instead of consuming them.

## What it does

Once a day (and on demand), a single pipeline takes three inputs:

1. **Recent GitHub activity** — events from your configured GitHub user, via the public events API
2. **Pending requests** — anything you've explicitly asked for through the UI
3. **Your preference profile** — topic weights and card-type appetite, built up from your reactions

…and produces three kinds of typed cards into one consumption queue:

- **discovery** — model-synthesized cards drawing on real online seed sources (currently Hacker News). Followable. Age out fast.
- **codebase** — model reasoning over one of your own repos (security updates, dead deps, refactor ideas). Generated only when you ask for them by name.
- **learning** — bite-sized cards on goals you've stated. Tidbits, questions, flashcards, quizzes. Carry spaced-repetition state and resurface on a schedule.

You read the queue at bedtime. Reactions shape what tomorrow's run produces. Save the good ones to a to-do list, hand them off to Claude Code, ship them.

## Tech stack

- **Runtime:** Google Cloud Run via the Functions Framework (no Dockerfile)
- **Storage:** MySQL on Cloud SQL (Unix-socket connection)
- **LLM:** Claude (default `claude-opus-4-7`) via the Anthropic SDK
- **Frontend:** vanilla JS/HTML/CSS from `/public` (no React, no build step)
- **Activity:** GitHub Events API + repo metadata/READMEs/manifests
- **Seeds:** Hacker News Algolia search

## Quickstart (local)

You need:

- Node 20+ and npm
- A local MySQL 8 (or remote)
- An Anthropic API key
- (Optional) a GitHub personal access token, to lift the unauthenticated rate limit

```sh
npm install
cp .env.example .env   # then fill in MYSQL_* and ANTHROPIC_API_KEY

# Bootstrap the schema:
mysql -u <user> -p <database> < src/schema.sql

# Run the server:
npm start
# Visit http://localhost:8080
```

The first time the run pipeline executes, it seeds default prompts into the `prompts` table. The settings page (`/settings`) lets you edit them with a per-prompt reset-to-default.

## Deploying to Cloud Run

This project is built for the "no Dockerfile, use buildpacks" path:

1. Create a Cloud SQL MySQL 8 instance.
2. Run `src/schema.sql` against the database.
3. Create a Cloud Run service. The Node.js buildpack picks up `package.json` and runs `npm start`.
4. Connect the Cloud SQL instance via the Cloud Run console (Connections → Cloud SQL).
5. Set environment variables on the service — see `.env.example`. `CLOUD_SQL_CONNECTION_NAME` is the instance connection name (`project:region:instance`); when it's set, the pool uses the Unix socket at `/cloudsql/<name>` and ignores `MYSQL_HOST`/`MYSQL_PORT`.
6. Optionally wire Cloud Scheduler to `POST $SERVICE_URL/api/scheduler/run` on whatever cadence you want (default settings assume roughly one run per night).

## Engineering rules

These are non-obvious decisions visible across the codebase:

- **No silent defaults.** Missing env vars, malformed payloads, blank prompt instructions, missing schema rows — they throw loudly. Nothing is papered over with `|| []` or "if it's broken, use this." If you see something handled gracefully, it's because the schema says it's allowed, not because we shrugged.
- **One database hit for the feed.** The feed read is a single indexed query (`status, score, created_at`) joined to `goals` so paused goals naturally drop out without per-card writes.
- **Single payload choke point.** Everything that goes into `cards.payload` runs through `serializeAndValidate(type, payload)` in `src/payload.js`. Everything coming out runs through `parsePayload(type, str)`. Nothing in the codebase hand-builds the JSON string or skips the parse.
- **Modular over forked.** Code paths are parameterized rather than duplicated — `runOnce({ trigger })` is the same orchestrator for scheduled, manual, immediate, and refill cases.
- **`payload` is LONGTEXT, not MySQL JSON.** No query ever looks inside the payload; everything queryable is a real column or a separate table. LONGTEXT avoids the JSON column's coercion quirks.
- **The run-lock is non-optional.** Scheduled and manual runs collide on a single-row `SELECT ... FOR UPDATE` advisory lock; concurrent attempts refuse rather than double-generate.

## Architecture

```
            +-----------------+
            |  GitHub Events  |
            |     (public)    |
            +--------+--------+
                     |
                     v
   +-----------------+----------------+
   |          The run pipeline        |
   |                                  |
   |  1. expire stale discoveries     |
   |  2. read activity + preferences  |
   |  3. drain pending requests       |
   |  4. theme + retrieve + synthesize|
   |  5. refresh learning cards       |
   |  6. persist activity cursor      |
   +-----------------+----------------+
                     |
                     v
            +--------+--------+
            |   cards table   |   <-- one feed query reads from here
            +--------+--------+
                     |
                     v
            +--------+--------+
            |   UI (vanilla)  |
            |  feed / todos   |
            |  library / etc. |
            +-----------------+
```

The run pipeline triggers from four places. All four call the same `runOnce({ trigger })` and all four hit the run-lock:

- Cloud Scheduler → `POST /api/scheduler/run`
- "Run now" button on settings → `POST /api/run-now`
- `immediate: true` on a submitted request → fires the run synchronously
- Live feed dropping below `queue_refill_threshold` → fires a refill in the background

## Card types

### discovery
- LLM-synthesized from retrieved online content
- Carries real `source_urls` (every URL came from a seed, never invented)
- `card_sources` join rows for the followable provenance trail
- Score blends theme weight + HN points (log-scaled) + seed recency
- Ages out after `staleness_days` (default 7)
- Followable: thumbs/heart shape topic weights; follow on a source shapes which sources retrieval visits first
- Optional `video` payload: YouTube gets in-house iframe, Twitter/X/Instagram/Reddit get link-outs (embedding is unreliable/blocked there)

### codebase
- Model reasoning over your repo (metadata, README, manifest)
- Scoped to the repo you requested — never speculatively generated
- Findings tagged `security` / `dead_dep` / `efficiency` / `refactor`
- File/line references must come from the real repo data; the prompt explicitly forbids inventing paths
- NOT followable (no real "source" beyond the repo itself)

### learning
- Belongs to a `goal` (lifecycle: `active` / `paused` / `mastered` / `cancelled`)
- Subtypes: `tidbit`, `question`, `flashcard`, `quiz`
- Carry SM-2-ish spaced-repetition state (`interval_days`, `ease`, `due_at`, `reviews`)
- Resurface rather than expire
- Pausing the parent goal cascades to all its cards via the feed-read JOIN — no per-card writes
- Auto-mastery: configurable streak length OR rolling correct-percentage over a window

Every card also carries a hidden `discussion_context` string, written by the model at generation time. It's not rendered in the feed; it becomes part of the system prompt if you open a discussion thread on the card.

## Feedback channels

Each channel acts on a different stage of the pipeline:

| Channel                       | Affects                       | Where it lands                                |
|-------------------------------|-------------------------------|-----------------------------------------------|
| Thumbs (up/down)              | Topic weights                 | `topic_preferences`                           |
| Heart                         | Topic weights (bigger)        | `topic_preferences`                           |
| Follow on a source            | Source weights                | `sources.followed` + `weight`                 |
| Learning outcome              | Spaced repetition + mastery   | `learning_reviews` + `goals`                  |
| Save (to-do)                  | To-do queue + small topic bump| `cards.status='saved'` + `topic_preferences`  |
| Engagement (≥ N msgs/thread)  | Topic + type appetite         | `topic_preferences` + `type_appetite`         |

## Editable prompts

Each pipeline step has a named prompt (`themes`, `synthesize_discovery`, `synthesize_codebase`, `synthesize_learning`, `discuss_card`). Prompts split into two parts:

- **`instruction_text`** — editable prose (role, tone, constraints). Lives in the `prompts` table.
- **Data block** — programmatically constructed in code (activity, themes, source content, card context). Appended after the instruction; never interpolated into it. No `{user_name}`-style templating.

Each prompt also stores a `default_text` so the settings UI can show a diff and let you reset.

A blank `instruction_text` is treated as an error — the pipeline refuses to run rather than silently use no instruction.

On upgrade, `ensureDefaultPrompts()` rebases any row where the user hasn't customized (`instruction_text == old default_text`) so structural changes reach existing deploys; customized rows stay untouched and the user can merge manually.

## To-do list

Cards you find interesting get a `saved` status, which drops them out of the feed via the existing `WHERE status='queued'` filter — no new query path. The `/todos` page lists them grouped by `saved` and `done`. Each has a "copy for Claude" button that puts a Markdown handoff (title, summary, body, sources, repo references, prepared discussion context) on the clipboard, ready to paste into Claude Code.

## Per-card discussion

Every card has a discuss button. Opening it lazily loads any prior thread; sending a message calls Claude with the card payload + `discussion_context` cached in the system prompt and the thread history as user/assistant messages. Replies render as Markdown. A toggle inside the drawer reveals the prepared context for trust/debugging.

If you send `engagement_boost_threshold` or more messages on a single card (default 3), a one-time topic-weight boost fires for that card's topics (`engagement_boost_amount`, default 0.4) plus a smaller boost to its type appetite. The UI shows an inline banner when this happens.

## Configurable settings

All stored as strings in the `settings` table; seeded with defaults so it works on day one.

| Key                              | Default          | What it does                                                       |
|----------------------------------|------------------|--------------------------------------------------------------------|
| `queue_target_size`              | 20               | Refill ceiling per run                                             |
| `queue_refill_threshold`         | 8                | Below this, the live UI fires a background refill                  |
| `staleness_days`                 | 7                | Discovery cards expire this many days after creation               |
| `mastery_streak_required`        | 5                | Consecutive correct reviews to auto-master a goal                  |
| `mastery_recent_window`          | 10               | Rolling window size for the alternative auto-mastery rule          |
| `mastery_recent_pct`             | 0.9              | Required correctness ratio in that window                          |
| `discovery_per_run`              | 8                | Max discovery cards per run                                        |
| `learning_per_run`               | 4                | Max learning cards per run                                         |
| `codebase_per_run`               | 4                | Max codebase cards per run                                         |
| `run_max_minutes`                | 15               | Soft budget for a run (advisory; not yet a hard cap)               |
| `llm_model`                      | `claude-opus-4-7`| Model used for all pipeline + discussion calls                     |
| `llm_effort`                     | `medium`         | Effort parameter (`low` / `medium` / `high` / `max`)               |
| `github_username`                | (empty)          | Your GitHub username for activity ingestion; blank = skip activity |
| `discussion_max_history`         | 20               | Max thread messages sent to the model per discussion turn          |
| `engagement_boost_threshold`     | 3                | User messages required on a card before the topic boost fires      |
| `engagement_boost_amount`        | 0.4              | Topic-weight delta applied at the threshold                        |

## HTTP routes

```
GET  /                              feed UI
GET  /settings                      settings + prompts UI
GET  /library                       learning goals UI
GET  /todos                         to-do list UI

GET  /api/feed?limit=N              cards (single indexed query)
POST /api/feedback                  thumbs / heart / follow / learning_outcome / consume / save
POST /api/requests                  submit a deferred request (immediate: true fires run now)
POST /api/run-now                   manual trigger
POST /api/scheduler/run             cloud scheduler entry point
GET  /api/status                    run-lock state + queue depth
POST /api/lock/force-release        emergency reset for a stuck lock

GET  /api/settings                  settings + prompts
PUT  /api/settings                  bulk set (body: {key: value, ...})
PUT  /api/prompts/:key              update one prompt
POST /api/prompts/:key/reset        reset to default

GET  /api/library                   goals + their cards
POST /api/goals/:id/status          change goal status

GET  /api/todos                     saved + done cards
POST /api/todos/:id/done            mark done
POST /api/todos/:id/undone          un-mark done
POST /api/todos/:id/delete          remove from to-do view (consumes the card)

GET  /api/cards/:id/messages        discussion history + card payload
POST /api/cards/:id/messages        send a message, get a reply
GET  /api/cards/:id/sources         provenance sources for a card
```

## Project layout

```
.
├── index.js                  # functions-framework entry; routes to src/routes.js
├── package.json              # buildpack reads this (main + engines.node + start)
├── src/
│   ├── schema.sql            # apply once on a fresh DB; idempotent migrations appended
│   ├── db.js                 # Cloud SQL Unix-socket pool, loud env-var validation
│   ├── payload.js            # serialize-and-validate / parse choke point for all card payloads
│   ├── runLock.js            # single-row advisory lock via SELECT ... FOR UPDATE
│   ├── settings.js           # typed settings access (getInt / getNumber / getString)
│   ├── prompts.js            # editable prompts + DEFAULT_INSTRUCTIONS + ensureDefaultPrompts
│   ├── llm.js                # Anthropic SDK boundary for the pipeline (themes, synthesis)
│   ├── conversation.js       # Anthropic SDK boundary for per-card discussion threads
│   ├── github.js             # GitHub Events / repo metadata / README / manifest fetchers
│   ├── hackernews.js         # Algolia HN search for discovery seeds
│   ├── sources.js            # upsert + follow + attach
│   ├── cards.js              # the feed query, insert path, card lifecycle helpers
│   ├── run.js                # the one orchestrator (scheduled/manual/immediate/refill)
│   ├── routes.js             # HTTP routing — static files + JSON API
│   └── pipeline/
│       ├── activity.js       # GitHub activity → compact summary for the LLM
│       ├── themes.js         # LLM step: activity + preferences → themes
│       ├── discovery.js      # LLM step: theme + HN seeds → discovery card
│       ├── codebase.js       # LLM step: repo data → codebase card
│       └── learning.js       # LLM step + spaced repetition + auto-mastery + goal lifecycle
└── public/
    ├── index.html            # feed
    ├── app.js                # feed + discussion drawer
    ├── settings.html         # settings + run-now + request submission + prompt editor
    ├── settings.js
    ├── library.html          # learning goals by state + their cards
    ├── library.js
    ├── todos.html            # saved + done cards with copy-for-Claude
    ├── todos.js
    ├── markdown.js           # vendored client-side markdown renderer
    └── styles.css
```

## Run-lock and concurrency

Concurrent runs would double-generate cards and confuse the activity cursor. Every run path acquires the single row in `run_lock` via `SELECT ... FOR UPDATE` before flipping `running=1`. A second caller blocks on its `SELECT FOR UPDATE` until the first commits, then sees `running=1` and refuses.

Lock release is durable (a follow-up `UPDATE`, not a transaction commit), so a crashed process leaves the lock set. The settings page exposes a "force release" button for this case.

## No-new-activity fallback

If GitHub has nothing new (or no `github_username` is configured), the run still produces cards. The themes step is fed the topic-preference list as the seed and the instruction explicitly tells the model to explore adjacent topics. The habit replacement only works if the queue isn't empty on quiet nights.

## Costs and safety

- Cloud Run + Cloud SQL costs are bounded by the run cadence and queue size — the live UI does no LLM calls, only the run pipeline and the discussion drawer do.
- The Anthropic call in `src/llm.js` uses prompt caching on the system slot (the editable instruction), so re-runs against the same prompts pay ~0.1× for that portion.
- All write paths through the API validate input before touching the database; payloads validate before insert through the choke point.
- The pipeline never invents URLs; the synthesis prompts forbid it and `src/pipeline/discovery.js` filters out any URL the model returns that wasn't in the seed list.

## License

See `LICENSE`.


