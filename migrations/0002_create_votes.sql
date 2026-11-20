-- One row per ingested passage vote. bill_key matches billKey() in utils.js
-- ("119-HR-3424") so the frontend can look bills up directly.
CREATE TABLE votes (
  vote_id TEXT PRIMARY KEY,
  chamber TEXT NOT NULL,
  congress INTEGER NOT NULL,
  session INTEGER NOT NULL,
  roll INTEGER NOT NULL,
  date TEXT,
  question TEXT,
  vote_type TEXT,
  result TEXT,
  bill_key TEXT NOT NULL,
  bill_title TEXT,
  policy_area TEXT
);
CREATE INDEX idx_votes_bill ON votes (bill_key);

CREATE TABLE member_votes (
  vote_id TEXT NOT NULL,
  bioguide_id TEXT NOT NULL,
  vote_cast TEXT NOT NULL,
  PRIMARY KEY (vote_id, bioguide_id)
);
CREATE INDEX idx_member_votes_member ON member_votes (bioguide_id);

-- Highest roll call already checked per session, passage or not, so the cron
-- never re-fetches a vote it has already looked at and skipped.
CREATE TABLE vote_ingest_cursor (
  chamber TEXT NOT NULL,
  congress INTEGER NOT NULL,
  session INTEGER NOT NULL,
  last_roll INTEGER NOT NULL,
  PRIMARY KEY (chamber, congress, session)
);
