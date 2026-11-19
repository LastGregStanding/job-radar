# Job Radar

A self-hosted service that watches company job boards and sends me a push notification when a new role matching my criteria is posted.

I built this to make job hunting a little less soul-draining.

## How it works

Job Radar has two parts:

1. **Building the list.** You put the job boards you want to watch in `boards.txt`. `check-boards.mjs` verifies each one through its ATS's API and saves the working ones to `companies.json`.
2. **Watching the list.** Each time `loop.mjs` runs, it checks every board in `companies.json`, saves new jobs to PostgreSQL, and sends a Pushover notification for each new job that matches your criteria.

Step by step, `loop.mjs`:

1. Reads the list of boards from `companies.json`.
2. Fetches each board's open jobs from its ATS's public API (currently Greenhouse, Lever, and Ashby).
3. Converts every job into one common shape (`id`, `company`, `title`, `location`, `url`, `postedAt`) through a small adapter per ATS.
4. Filters jobs by title and location.
5. Saves every job in PostgreSQL. A job ID can only be saved once, which prevents duplicate notifications.
6. Sends a notification for each new matching job, with a direct link to the application form.

## Features

- **Three ATS adapters** (Greenhouse, Lever, Ashby) that normalize different APIs into one schema. Adding a new ATS means adding one adapter function.
- **Deduplication** with PostgreSQL upserts. Each job is stored once, no matter how many runs see it.
- **Posting dates** from each ATS, shown in notifications ("posted 3h ago") and used to sort the backlog.
- **Quiet onboarding for new boards.** The first time a board is checked, only jobs posted in the last 24 hours notify. Older ones are saved quietly as backlog. This avoids getting 300 notifications if you add 300 new companies to the search.
- **Filtering** by role keywords, excluded words, security clearance, and location (local area, remote US).
- **Grouping** of near-identical postings (the same job posted once per city) into a single notification.
- **Board verification** with `check-boards.mjs`: confirms each board responds and has open jobs, removes duplicates (case-insensitive), and honors a blocklist.

## Tech

Node.js · PostgreSQL · Docker · Pushover

## Setup

Requirements: Docker, Node.js 20.6+, and a [Pushover](https://pushover.net) account.

```bash
git clone https://github.com/LastGregStanding/job-radar.git
cd job-radar
npm install
cp .env.example .env                      # then fill in your Pushover keys and a DB password
cp companies.example.json companies.json  # starter list of boards
docker compose up -d db
npm start
```

To run the poller in Docker instead of on your machine:

```bash
docker compose run --rm --build poller
```

`companies.example.json` is a small starter list. Build your own board list as described below.

### Useful settings (environment variables)

| Variable                 | Default | What it does                                                  |
| ------------------------ | ------- | ------------------------------------------------------------- |
| `SILENT`                 | off     | `SILENT=1 npm start` saves jobs without sending notifications |
| `DELAY_MS`               | `500`   | Pause between boards (be polite to the APIs!!!)               |
| `NEW_BOARD_WINDOW_HOURS` | `24`    | How recent a job on a first-time board must be to notify      |

Filter criteria (role words, excluded words, local places) live in the `criteria` object near the top of `loop.mjs`.

## Building a board list

Job Radar watches whatever boards you give it. A board is an ATS plus the company's name on that ATS, which you can see in any job posting's URL:

- `boards.greenhouse.io/airbnb` or `job-boards.greenhouse.io/airbnb` → `greenhouse:airbnb`
- `jobs.lever.co/palantir` → `lever:palantir`
- `jobs.ashbyhq.com/openai` → `ashby:openai`

1. Add boards to `boards.txt`, one per line (see `boards.example.txt` for the format).
2. Run `npm run check-boards`. It verifies each new board through its ATS's API, skips anything broken or empty, removes duplicates, and adds the working boards to `companies.json`.

To keep a board out of your list for good (aggregators, test boards), add it to `blocklist.txt` (see `blocklist.example.txt`).

The repo only includes a small example list. You'll need to build your own.

## Running on a schedule

Job Radar runs once and exits, so you'll likely want a scheduler to run it regularly. For example, with cron (every two hours on weekdays):

```
0 */2 * * 1-5 cd /path/to/job-radar && docker compose run --rm poller
```

## Notes

- Job Radar only reads public job-board APIs that ATSs provide for exactly this purpose. It does not scrape HTML, log in anywhere, or apply to jobs. It simply finds them and notifies you.
