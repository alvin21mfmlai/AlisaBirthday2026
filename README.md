# Alisa's second birthday — RSVP page

Saturday, 31 October 2026. Venue to be confirmed.

A single-page RSVP site with a serverless guest list. Guests type their own name,
pick a side of the family, say yes or no, and see the list fill up live. Every
confirmed guest gets one lucky draw number, handed out on 30 October.

```
index.html      the whole site — HTML, CSS and JS in one file, no build step
api/rsvp.js     serverless function: GET the list, POST an RSVP, DELETE one
vercel.json     cache and noindex headers
package.json    metadata only; there are no dependencies to install
```

---

## Deploying

### 1. Push and import

```bash
git init && git add . && git commit -m "Alisa RSVP"
git remote add origin git@github.com:alvin21mfmlai/alisa-rsvp.git
git push -u origin main
```

Then in Vercel: **Add New → Project → Import** that repo. Framework preset
**Other**, no build command, no output directory. Deploy.

Or straight from this folder with the CLI:

```bash
npx vercel        # preview
npx vercel --prod # live
```

The first deploy will succeed, but the guest list will say it isn't connected to
its database yet. That's step 2.

### 2. Attach a Redis database

The RSVPs live in Redis. Vercel KV was retired, so this comes from the
Marketplace now:

1. Open the project → **Storage** → **Create Database** → **Upstash** → Redis.
2. Pick a region near your guests (`ap-southeast-1`, Singapore).
3. Connect it to this project, for all three environments.

Vercel injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically. The
function also accepts `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` or
`REDIS_REST_URL` / `REDIS_REST_TOKEN` if you'd rather create the database
directly at upstash.com and paste the credentials in yourself.

### 3. Redeploy

Environment variables are read at request time, but a fresh deploy is the
reliable way to pick them up. **Deployments → ⋯ → Redeploy.** Load the page: the
guest list should now say nobody has replied yet, which means it's talking to
Redis.

### 4. Check it works

```bash
curl https://your-project.vercel.app/api/rsvp
# {"guests":[]}
```

Send yourself a test RSVP through the form, confirm it appears, then use **Remove
my RSVP** to clear it.

---

## Free tier

Upstash's free plan covers 500,000 commands a month. A page load costs one
command and an RSVP costs two or three. A hundred guests refreshing all week
won't come close.

## Running it locally

`vercel dev` serves the page and the function together. Run `vercel env pull
.env.development.local` first so the Redis credentials are available.

Opening `index.html` straight from the filesystem will render the page, but every
guest-list call will fail — there's no `/api/rsvp` without the dev server.

---

## Things worth knowing

**The link is the only lock.** Anyone who has the URL can add, update or remove a
name, the same as a paper sign-up sheet on a table. That's the right trade for a
family party — no accounts, no passwords, grandparents can use it. The page is
`noindex` so it won't turn up in search, but keep the link inside the family
chat. Download the CSV now and then if you want a snapshot.

**Names are the primary key.** An RSVP is stored under a simplified version of
the name, so "Sherman Tan" and "sherman  tan" are the same person and the second
submission updates the first. Two genuinely different guests with the same name
need something to tell them apart — "Ethan Tan" and "Ethan Tan Jr".

**Group entries are refused twice.** The form rejects "Sherman's family", "Tan
family x4", "the Lims +3" and similar, and `api/rsvp.js` rejects them again
server-side, so a stale browser tab can't sneak one through. If a real name ever
trips the filter, the pattern is `GROUP_ENTRY` at the top of `api/rsvp.js` and
the matching one in the form handler in `index.html`.

**Capacity.** The function refuses new names past 500 guests, as a brake on
anything automated. Raise `MAX_GUESTS` if you somehow need to.

---

## Editing the content

Everything is plain text near the top of `index.html`:

- **Venue** — search for `To be confirmed`. Replace it and the sentence below it
  with the address once it's booked.
- **Prizes** — the five stubs are five `<article class="tk">` lines. Swap `1st`,
  `2nd` and so on for the actual prizes when you're ready to reveal them.
- **Date** — appears in the hero, the footer, and once in the script as
  `PARTY` (`2026-10-31T00:00:00+08:00`), which drives the countdown.
- **Draw numbers** — assign them from the CSV, then add a `Number` column to the
  tables in `renderGroup()` when you publish them on 30 October.

## Starting a fresh list

Set an environment variable `RSVP_KEY` to any new value and redeploy. The
function will read and write a different Redis hash, leaving the old list intact
in case you want it back.
