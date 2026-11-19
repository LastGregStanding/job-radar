import { readFile, writeFile } from "node:fs/promises";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// How to count open jobs for each ATS
const countJobs = {
  greenhouse: async (n) =>
    (await getJson(`https://boards-api.greenhouse.io/v1/boards/${n}/jobs`)).jobs
      .length,
  lever: async (n) =>
    (await getJson(`https://api.lever.co/v0/postings/${n}?mode=json`)).length,
  ashby: async (n) =>
    (await getJson(`https://api.ashbyhq.com/posting-api/job-board/${n}`)).jobs
      .length,
};

// Read boards.txt
let raw;
try {
  raw = await readFile("boards.txt", "utf8");
} catch {
  console.log(
    "No boards.txt found. Create one (see boards.example.txt) and run this again.",
  );
  process.exit(1);
}
const lines = raw
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
// Remove duplicates, ignoring upper/lowercase ("ashby:OpenAI" = "ashby:openai")
const seenLines = new Set();
const unique = lines.filter((l) => {
  const key = l.toLowerCase();
  if (seenLines.has(key)) return false;
  seenLines.add(key);
  return true;
});

// Boards to never add, listed in blocklist.txt (one per line).
// "lever:some-aggregator" blocks one board; "some-aggregator" blocks that name on any ATS.
let blocklist = [];
try {
  blocklist = (await readFile("blocklist.txt", "utf8"))
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith("#"));
} catch {}
const isBlocked = (ats, name) =>
  blocklist.includes(`${ats}:${name}`.toLowerCase()) ||
  blocklist.includes(name.toLowerCase());

// Keep anything already verified in companies.json (minus blocked boards)
let companies = [];
try {
  companies = JSON.parse(await readFile("companies.json", "utf8"));
} catch {}
const before = companies.length;
companies = companies.filter((c) => !isBlocked(c.ats, c.name));
if (companies.length < before) {
  console.log(
    `⊘ Removed ${before - companies.length} blocked board(s) from companies.json`,
  );
}
// Also remove upper/lowercase duplicates already in companies.json
const keyOf = (ats, name) => `${ats}:${name}`.toLowerCase();
const beforeDedupe = companies.length;
const seenCompanies = new Set();
companies = companies.filter((c) => {
  const key = keyOf(c.ats, c.name);
  if (seenCompanies.has(key)) return false;
  seenCompanies.add(key);
  return true;
});
if (companies.length < beforeDedupe) {
  console.log(
    `⊘ Removed ${beforeDedupe - companies.length} duplicate board(s) (same name, different case)`,
  );
}
const known = new Set(companies.map((c) => keyOf(c.ats, c.name)));

let added = 0;
for (const line of unique) {
  if (known.has(line.toLowerCase())) continue;
  const [ats, name] = line.split(":");
  if (!name) {
    console.log(
      `? ${line}: expected "ats:name" (like greenhouse:airbnb), skipped`,
    );
    continue;
  }
  if (isBlocked(ats, name)) {
    console.log(`⊘ ${line}: on blocklist, skipped`);
    continue;
  }
  if (!countJobs[ats]) {
    console.log(`? ${line}: unknown ATS, skipped`);
    continue;
  }
  try {
    const count = await countJobs[ats](name);
    if (count === 0) {
      console.log(`– ${line}: 0 jobs, skipped`);
    } else {
      console.log(`✓ ${line}: ${count} jobs`);
      companies.push({ name, ats });
      known.add(line.toLowerCase());
      added++;
    }
  } catch (err) {
    console.log(`✗ ${line}: ${err.message}`);
  }
  await sleep(300);
}

await writeFile("companies.json", JSON.stringify(companies, null, 2));
console.log(
  `\nAdded ${added}. companies.json now has ${companies.length} boards.`,
);
