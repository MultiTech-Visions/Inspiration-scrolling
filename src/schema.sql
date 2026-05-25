-- Inspiration-scrolling: schema for the nightly project-inspiration feed.
-- Apply against an empty MySQL 8 database. Idempotent via IF NOT EXISTS where
-- supported; seed inserts use INSERT IGNORE.

CREATE TABLE IF NOT EXISTS goals (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  topic           VARCHAR(255)    NOT NULL,
  status          ENUM('active','paused','mastered','cancelled') NOT NULL DEFAULT 'active',
  mastery_threshold INT           NOT NULL DEFAULT 5,
  correct_streak  INT             NOT NULL DEFAULT 0,
  total_reviewed  INT             NOT NULL DEFAULT 0,
  total_correct   INT             NOT NULL DEFAULT 0,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_goals_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cards (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  type            ENUM('discovery','codebase','learning') NOT NULL,
  status          ENUM('queued','active','consumed','expired','mastered','saved','done') NOT NULL DEFAULT 'queued',
  goal_id         BIGINT UNSIGNED NULL,
  payload         LONGTEXT        NOT NULL,
  score           DOUBLE          NOT NULL DEFAULT 0,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  seed_recency_at DATETIME        NULL,
  expires_at      DATETIME        NULL,
  consumed_at     DATETIME        NULL,
  saved_at        DATETIME        NULL,
  done_at         DATETIME        NULL,
  engagement_boosted TINYINT(1)   NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_cards_feed (status, score, created_at),
  KEY idx_cards_goal (goal_id),
  CONSTRAINT fk_cards_goal FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sources (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind            VARCHAR(64)     NOT NULL,
  external_ref    VARCHAR(1024)   NOT NULL,
  title           VARCHAR(512)    NULL,
  weight          DOUBLE          NOT NULL DEFAULT 1.0,
  followed        TINYINT(1)      NOT NULL DEFAULT 0,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_sources_ref (kind, external_ref(255)),
  KEY idx_sources_followed_weight (followed, weight)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS card_sources (
  card_id         BIGINT UNSIGNED NOT NULL,
  source_id       BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (card_id, source_id),
  KEY idx_card_sources_source (source_id),
  CONSTRAINT fk_card_sources_card   FOREIGN KEY (card_id)   REFERENCES cards(id)   ON DELETE CASCADE,
  CONSTRAINT fk_card_sources_source FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS learning_reviews (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  card_id         BIGINT UNSIGNED NOT NULL,
  goal_id         BIGINT UNSIGNED NOT NULL,
  result          ENUM('correct','incorrect') NOT NULL,
  reviewed_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_learning_reviews_goal_time (goal_id, reviewed_at),
  KEY idx_learning_reviews_card (card_id),
  CONSTRAINT fk_learning_reviews_card FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE,
  CONSTRAINT fk_learning_reviews_goal FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS topic_preferences (
  topic           VARCHAR(255)    NOT NULL,
  weight          DOUBLE          NOT NULL DEFAULT 1.0,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (topic)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS type_appetite (
  type            ENUM('discovery','codebase','learning') NOT NULL,
  weight          DOUBLE          NOT NULL DEFAULT 1.0,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS requests (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  body            LONGTEXT        NOT NULL,
  immediate       TINYINT(1)      NOT NULL DEFAULT 0,
  status          ENUM('pending','processed','errored') NOT NULL DEFAULT 'pending',
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at    DATETIME        NULL,
  error           TEXT            NULL,
  PRIMARY KEY (id),
  KEY idx_requests_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS prompts (
  prompt_key       VARCHAR(128)    NOT NULL,
  instruction_text LONGTEXT        NOT NULL,
  default_text     LONGTEXT        NOT NULL,
  updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (prompt_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settings (
  setting_key      VARCHAR(128)    NOT NULL,
  value            VARCHAR(1024)   NOT NULL,
  updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Single-row run-lock control. Lock acquired via SELECT ... FOR UPDATE on id=1.
CREATE TABLE IF NOT EXISTS run_lock (
  id              TINYINT         NOT NULL,
  running         TINYINT(1)      NOT NULL DEFAULT 0,
  run_id          VARCHAR(64)     NULL,
  started_at      DATETIME        NULL,
  finished_at     DATETIME        NULL,
  last_cursor     VARCHAR(255)    NULL,
  last_error      TEXT            NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO run_lock (id, running) VALUES (1, 0);

-- Type-appetite seeds (equal weight).
INSERT IGNORE INTO type_appetite (type, weight) VALUES
  ('discovery', 1.0),
  ('codebase',  1.0),
  ('learning',  1.0);

-- Baked-in settings defaults. All values stored as strings; parsed at read time.
INSERT IGNORE INTO settings (setting_key, value) VALUES
  ('queue_target_size',         '20'),
  ('queue_refill_threshold',    '8'),
  ('staleness_days',            '7'),
  ('mastery_streak_required',   '5'),
  ('mastery_recent_window',     '10'),
  ('mastery_recent_pct',        '0.9'),
  ('discovery_per_run',         '8'),
  ('learning_per_run',          '4'),
  ('codebase_per_run',          '4'),
  ('run_max_minutes',           '15'),
  ('llm_model',                 'claude-opus-4-7'),
  ('llm_effort',                'medium'),
  ('github_username',           ''),
  ('discussion_max_history',    '20'),
  ('engagement_boost_threshold','3'),
  ('engagement_boost_amount',   '0.4'),
  ('blocked_domains',           ''),
  ('discovery_search_max_uses', '4');

-- ---------------------------------------------------------------------------
-- Card discussion threads. One row per message in the thread; the conversation
-- itself is the memory (the model's "scratchpad" for a card is the static
-- payload.discussion_context field, populated at generation time and never
-- mutated here).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_messages (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  card_id         BIGINT UNSIGNED NOT NULL,
  role            ENUM('user','assistant') NOT NULL,
  content         LONGTEXT        NOT NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_card_messages_card_time (card_id, created_at),
  CONSTRAINT fk_card_messages_card FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- In-place migrations for upgrades. Each statement is idempotent: re-running
-- against a schema already at the target shape is a no-op or a self-replace.
-- Fresh deploys hit these after CREATE TABLE IF NOT EXISTS already produced
-- the desired shape, so the ALTERs become no-ops.
--
-- If you have pre-discussion-context cards in the table from before this
-- migration, payload parsing will throw loudly on read. Wipe them with:
--   DELETE FROM cards WHERE payload NOT LIKE '%discussion_context%';
-- (Only after confirming you don't want those rows.)
-- ---------------------------------------------------------------------------
ALTER TABLE cards
  MODIFY COLUMN status
    ENUM('queued','active','consumed','expired','mastered','saved','done')
    NOT NULL DEFAULT 'queued';

ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS saved_at        DATETIME    NULL,
  ADD COLUMN IF NOT EXISTS done_at         DATETIME    NULL,
  ADD COLUMN IF NOT EXISTS engagement_boosted TINYINT(1) NOT NULL DEFAULT 0;
