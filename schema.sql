CREATE TABLE jobs (
  id          TEXT PRIMARY KEY,
  company     TEXT NOT NULL,
  title       TEXT NOT NULL,
  location    TEXT,
  url         TEXT NOT NULL,
  matched     BOOLEAN NOT NULL,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at   TIMESTAMPTZ
);

CREATE TABLE boards (
  ats            TEXT NOT NULL,
  name           TEXT NOT NULL,
  first_checked  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ats, name)
);
