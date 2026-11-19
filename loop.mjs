import pg from "pg";
import { readFile } from "node:fs/promises";

// Set SILENT=1 to save jobs without sending notifications
const SILENT = process.env.SILENT === "1";

// Pause between companies in milliseconds (default 500)
const DELAY_MS = Number(process.env.DELAY_MS ?? 500);

// For a board checked for the FIRST time, only notify about jobs posted
// within this many hours. Older ones are saved quietly as backlog.
const NEW_BOARD_WINDOW_HOURS = Number(process.env.NEW_BOARD_WINDOW_HOURS ?? 24);

const db = new pg.Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5433),
  user: process.env.DB_USER ?? "radar",
  password: process.env.DB_PASSWORD ?? "radar",
  database: process.env.DB_NAME ?? "jobradar",
});

// "posted 3h ago", "posted 5d ago"
function ago(date) {
  if (!date) return "";
  const hours = (Date.now() - date.getTime()) / 36e5;
  if (hours < 1) return "posted <1h ago";
  if (hours < 48) return `posted ${Math.round(hours)}h ago`;
  return `posted ${Math.round(hours / 24)}d ago`;
}

// Send a Pushover notification
async function notify(job) {
  const res = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: process.env.PUSHOVER_TOKEN,
      user: process.env.PUSHOVER_USER,
      title: `${job.title} @ ${job.company}`,
      message: [job.location || "Location not listed", ago(job.postedAt)]
        .filter(Boolean)
        .join(" · "),
      url: job.url,
      url_title: "Open application",
    }),
  });
  if (!res.ok) {
    console.log(`✗ Notification failed: ${res.status} ${await res.text()}`);
  }
}

async function saveIfNew(job, isMatch) {
  // Inserts the job if it's new. If it already exists without a posting
  // date, fills the date in. (xmax = 0) is true only for a freshly inserted row.
  const result = await db.query(
    `INSERT INTO jobs (id, company, title, location, url, matched, posted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET posted_at = EXCLUDED.posted_at
       WHERE jobs.posted_at IS NULL AND EXCLUDED.posted_at IS NOT NULL
     RETURNING (xmax = 0) AS inserted`,
    [
      job.id,
      job.company,
      job.title,
      job.location,
      job.url,
      isMatch,
      job.postedAt,
    ],
  );
  return result.rows[0]?.inserted === true; // true = new job, false = already seen
}

// The list of companies to check, read from companies.json
// (created by check-boards.mjs)
let companies;
try {
  companies = JSON.parse(
    await readFile(new URL("./companies.json", import.meta.url), "utf8"),
  );
} catch {
  console.log(
    "No companies.json found. Copy companies.example.json to companies.json, or build one with check-boards.mjs.",
  );
  process.exit(1);
}

// One "adapter" per ATS: fetch jobs, then convert them to the same shape

// Turns an ATS date (text or milliseconds) into a Date, or null if missing/invalid
function toDate(value) {
  if (value == null) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

async function fetchGreenhouse(company) {
  const res = await fetch(
    `https://boards-api.greenhouse.io/v1/boards/${company}/jobs`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.jobs.map((job) => ({
    id: `greenhouse-${job.id}`,
    company,
    title: job.title,
    location: job.location?.name ?? "",
    url: job.absolute_url,
    postedAt: toDate(job.first_published),
  }));
}

async function fetchLever(company) {
  const res = await fetch(
    `https://api.lever.co/v0/postings/${company}?mode=json`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.map((job) => ({
    id: `lever-${job.id}`,
    company,
    title: job.text,
    location: job.categories?.location ?? "",
    url: job.hostedUrl,
    postedAt: toDate(job.createdAt),
  }));
}

async function fetchAshby(company) {
  const res = await fetch(
    `https://api.ashbyhq.com/posting-api/job-board/${company}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.jobs.map((job) => ({
    id: `ashby-${job.id}`,
    company,
    title: job.title,
    location: job.location ?? "",
    url: job.jobUrl,
    postedAt: toDate(job.publishedAt),
  }));
}

const adapters = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
};

// A small pause so we're polite to the APIs
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Job criteria: edit these lists to fit your own search
const criteria = {
  // Title must contain at least one of these (the kind of role)
  roleWords: [
    "software",
    "swe",
    "developer",
    "full stack",
    "frontend",
    "backend",
    "devops",
  ],

  // Title must NOT contain any of these
  titleExclude: [
    "senior",
    "staff",
    "principal",
    "lead",
    "manager",
    "director",
    "intern",
    "internship",
    "co-op",
  ],

  // Turn this on to skip jobs that require a security clearance
  skipClearanceJobs: false,
  clearanceWords: [
    "clearance",
    "cleared",
    "ts/sci",
    "top secret",
    "secret",
    "polygraph",
    "poly",
  ],

  // Places that count as "local"
  localPlaces: [
    "denver",
    "boulder",
    "littleton",
    "highlands ranch",
    "colorado",
  ],
};

// Helpers for matching words
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const startsWord = (text, word) =>
  new RegExp(`\\b${escape(word)}`, "i").test(text);
const wholeWord = (text, word) =>
  new RegExp(`\\b${escape(word)}\\b`, "i").test(text);

// Checks ONE location, like "Remote - US" or "Denver, CO"
function placeOk(raw) {
  const place = raw.trim();
  if (!place) return false;

  // Local: any place in localPlaces (plus "CO" for Colorado abbreviations)
  if (criteria.localPlaces.some((w) => wholeWord(place, w))) return true;
  if (/\bCO\b/.test(place)) return true; // "Aurora CO", "Aurora, CO"

  const isRemote = /\bremote\b/i.test(place);
  const isUS =
    /\b(united states|usa|north america)\b/i.test(place) ||
    /\bUS\b/.test(place);

  // Remote in the US: "Remote - US", "Remote (US/Canada)", "Remote, United States"
  if (isRemote && isUS) return true;

  // Just "Remote" (or "Full Remote") with no country named
  const leftover = place.replace(/\b(fully|full|remote)\b|[\s\-–,()]/gi, "");
  if (isRemote && leftover === "") return true;

  // Just a country, like "United States" or "USA" (usually means remote)
  if (/^(united states( of america)?|usa|us)$/i.test(place)) return true;

  return false;
}

function matches(job) {
  const hasRoleWord = criteria.roleWords.some((w) => startsWord(job.title, w));
  const hasBadWord = criteria.titleExclude.some((w) => wholeWord(job.title, w));
  const needsClearance =
    criteria.skipClearanceJobs &&
    criteria.clearanceWords.some((w) => wholeWord(job.title, w));

  // Some jobs list several locations separated by ";". One good one is enough.
  const locationOk = job.location.split(";").some(placeOk);

  return hasRoleWord && !hasBadWord && !needsClearance && locationOk;
}

// Boards the radar has checked before
const knownBoards = new Set(
  (await db.query(`SELECT ats, name FROM boards`)).rows.map(
    (r) => `${r.ats}:${r.name}`,
  ),
);

// The loop
const allJobs = [];
const checkedBoards = []; // boards fetched successfully this run

for (const { name, ats } of companies) {
  const adapter = adapters[ats];
  if (!adapter) {
    console.log(`? ${name}: unknown ATS "${ats}", skipped`);
    continue;
  }
  try {
    const firstRun = !knownBoards.has(`${ats}:${name}`);
    const jobs = await adapter(name);
    console.log(
      `✓ ${name} (${ats}): ${jobs.length} jobs${firstRun ? " (first check)" : ""}`,
    );
    for (const job of jobs) job.firstRun = firstRun;
    allJobs.push(...jobs);
    checkedBoards.push({ ats, name });
  } catch (err) {
    console.log(`✗ ${name} (${ats}): ${err.message}`);
  }
  await sleep(DELAY_MS);
}

// Save new jobs, collect new matches
const newMatches = [];
let newCount = 0;

let backlogCount = 0;
const windowMs = NEW_BOARD_WINDOW_HOURS * 36e5;

for (const job of allJobs) {
  const isMatch = matches(job);
  const isNew = await saveIfNew(job, isMatch);
  if (isNew) {
    newCount++;
    if (!isMatch) continue;
    // First check of a board: only recently posted jobs notify.
    // Older ones are saved quietly as backlog.
    const recent =
      job.postedAt && Date.now() - job.postedAt.getTime() <= windowMs;
    if (job.firstRun && !recent) {
      backlogCount++;
      continue;
    }
    newMatches.push(job);
  }
}

// Remember the boards checked this run
for (const { ats, name } of checkedBoards) {
  await db.query(
    `INSERT INTO boards (ats, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [ats, name],
  );
}

console.log(`\n${newCount} new jobs, ${newMatches.length} new matches`);
if (backlogCount > 0) {
  console.log(
    `${backlogCount} older matches from first-time boards saved quietly as backlog`,
  );
}
console.log("");
if (SILENT) console.log("(SILENT mode: no notifications sent)\n");

// Group near-identical postings (same company + same title, often one per city)
// so they send ONE notification instead of dozens.
// "Software Engineer - Denver, CO, USA" -> "software engineer"
const baseTitle = (title) =>
  title
    .replace(/\s[-–—]\s[^-–—]*,[^-–—]*$/, "")
    .trim()
    .toLowerCase();

const groups = new Map();
for (const job of newMatches) {
  const key = `${job.company}|${baseTitle(job.title)}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(job);
}

console.log(`${groups.size} notifications (after grouping similar postings)\n`);

for (const jobs of groups.values()) {
  const job = jobs[0];
  const extra =
    jobs.length > 1 ? ` (+${jobs.length - 1} similar postings)` : "";
  console.log(
    `${job.company} | ${job.title} | ${job.location}${extra} ${ago(job.postedAt)}`,
  );
  console.log(`  ${job.url}\n`);
  if (!SILENT) {
    await notify({ ...job, location: `${job.location}${extra}` });
    await sleep(500);
  }
}

await db.end();
