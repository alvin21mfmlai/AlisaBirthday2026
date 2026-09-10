# Alisa's second birthday — RSVP page

Saturday, 31 October 2026. Venue to be confirmed.

A single-page RSVP site with a serverless guest list. Guests type their own name,
pick a side of the family, say yes or no, and see the list fill up live. Every
confirmed guest gets one lucky draw number, handed out on 30 October.

```
index.html            the whole site — HTML, CSS and JS in one file, no build step
api/rsvp.js           serverless function: the guest list and the draw allocation
tools/verify-draw.js  recomputes the draw from its seed, to prove it was fair
vercel.json           cache and noindex headers
package.json          metadata only; there are no dependencies to install
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

### 2. Attach a database — free, either way

The RSVPs live in Redis. Vercel KV was retired, so it comes from Upstash now.
Upstash's free tier is permanent: 256 MB of storage and 500,000 commands a
month. This party will use well under 1% of that. Two ways in, both free:

**Through Vercel (fewer steps).** Project → **Storage** → **Create Database** →
**Upstash** → Redis. Pick `ap-southeast-1` (Singapore). Connect it to this
project for all three environments. Vercel injects `KV_REST_API_URL` and
`KV_REST_API_TOKEN` for you. Marketplace storage is available on the Hobby plan,
and the free plan is selected automatically.

**Direct at upstash.com (no card, guaranteed).** Sign up, create a Redis
database in `ap-southeast-1`, and copy the REST URL and token from the database
page. In Vercel: **Settings → Environment Variables**, add

```
UPSTASH_REDIS_REST_URL    https://xxxx.upstash.io
UPSTASH_REDIS_REST_TOKEN  AX...
```

for Production, Preview and Development. Upstash asks for no payment method on
the free tier, so nothing can bill you by surprise.

`api/rsvp.js` reads whichever pair it finds, and also accepts
`REDIS_REST_URL` / `REDIS_REST_TOKEN` if you name them yourself.

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

## What it actually costs

Nothing, on both halves. Vercel Hobby is free for a personal project like this,
and Upstash's free tier is permanent rather than a trial.

Where the commands go:

| Action | Redis commands |
| --- | --- |
| Loading or refreshing the page | 2 |
| Sending an RSVP | 3–4 |
| Removing one | 2 |
| An open tab, per minute | 1 |

A sixty-guest party, with everyone visiting a few times and you checking
obsessively, lands around 2,000 commands. The monthly allowance is 500,000.

The one thing that could add up is a tab left open for days, so the page stops
polling after twenty minutes without any interaction and picks up again when
you come back to it.

### If you'd rather use something else

Any of these have permanent free tiers and would work here: **Neon** or
**Supabase** (Postgres, both on the Vercel Marketplace), **Turso**,
**Cloudflare D1**, **MongoDB Atlas M0**. Swapping means rewriting the four
`redis(...)` calls in `api/rsvp.js` — the rest of the file, and the whole
front end, stays as it is.

A **Google Sheet** driven by Apps Script is also a real option, and has the
nice property that the guest list lands somewhere you can sort and print
directly. It costs a Google account and no card at all.

## Running it locally

`vercel dev` serves the page and the function together. Run `vercel env pull
.env.development.local` first so the Redis credentials are available.

Opening `index.html` straight from the filesystem will render the page, but every
guest-list call will fail — there's no `/api/rsvp` without the dev server.

---

## Lucky draw numbers

Numbers appear by themselves. There's no cron job — Hobby plans only get one
scheduled run a day — so instead the first page load on or after **30 October
2026, 00:00 Singapore time** does the allocation and writes it down. Everyone
who loads the page after that reads the same stored result.

### How the allocation works

Everyone down as coming is sorted into a fixed order, then shuffled with
Fisher-Yates and numbered 1 upwards. The shuffle is driven by a random seed
generated once and stored alongside the numbers, which makes the whole thing
reproducible after the fact:

```bash
node tools/verify-draw.js <seed> "Sherman Tan" "Michelle Tan" "Ethan Tan" ...
```

That script doesn't touch the database. If its output matches what the site
showed, the allocation was fixed the moment the seed was created and nothing was
nudged afterwards. The seed is shown to you when numbers go out, and is in
`draw.seed` from `GET /api/rsvp`.

### Rules the allocation follows

- **Numbers never move.** Once someone has been told their number it's theirs.
  Nothing reshuffles, so a screenshot taken on the 30th stays true.
- **Latecomers get the next number up.** Someone who replies on the 31st is
  appended rather than triggering a reshuffle. A batch of latecomers is shuffled
  among themselves so they don't come out alphabetical.
- **Changing to "can't make it" reserves the number** rather than releasing it.
  Switch back and the same number returns. Nobody ever inherits a used number.
- **The draw won't run against an empty list.** If a stray request arrives before
  anyone has replied, no seed is burned.

### Rehearsing it early

Two ways, both harmless:

- In host mode, an **Issue draw numbers now** button appears in the host bar
  until numbers are out.
- Set `DRAW_DATE` to any ISO timestamp to move the date. Useful for a full dry
  run on a preview deployment.

To scrap a test allocation and start clean, delete the `alisa2:rsvp:draw` key in
the Upstash console, or change `RSVP_KEY`.

### What the site does not do

It hands out numbers; it doesn't pick the winners. Draw those on the day however
you like — numbers in a bowl works, and everyone can see it's fair.

---

## Removing and fixing names

### Host mode

Set an environment variable in Vercel:

```
HOST_KEY   any long random string, e.g. alisa-31oct-7fq3x
```

Redeploy, then open `https://your-project.vercel.app/?host=alisa-31oct-7fq3x`
once. Every row in both guest lists — and in the can't-make-it list — gains
**Edit** and **Remove**.

- **Remove** asks for confirmation, then deletes the entry.
- **Edit** loads that person into the form so you can fix a spelling, move
  someone to the other side of the family, or flip a yes to a no. Changing the
  name is a rename: the old entry is deleted and the corrected one takes its
  place.

The key is stripped out of the address bar the moment it loads, so it won't ride
along in a screenshot or a link you paste to someone. It's remembered in that
browser until you press **Leave host mode**. Do that on any shared or borrowed
device.

### What setting HOST_KEY changes for everyone else

Without `HOST_KEY`, deletion is open — anyone with the link can remove any name.
Setting it tightens that up. From then on, a guest can only remove a name their
own browser submitted, and everything else needs the host key. Guests who have
replied see a line under the form — *You replied as Sherman Tan. Change your
answer or remove yourself* — which survives closing the page, so they can undo
themselves without bothering you.

If a guest replies on their phone and later edits on a laptop, both devices can
remove that entry. The five most recent devices to submit a name keep that
ability.

### Without host mode

Two fallbacks, both fine for a one-off fix:

```bash
# with HOST_KEY set
curl -X DELETE "https://your-project.vercel.app/api/rsvp?name=Sherman%20Tan" \
     -H "x-host-key: alisa-31oct-7fq3x"

# without it
curl -X DELETE "https://your-project.vercel.app/api/rsvp?name=Sherman%20Tan"
```

Or open the Upstash console, find the `alisa2:rsvp` hash, and delete the field.
Field names are the simplified version of the guest's name — `sherman-tan`.

To clear the whole list and start again, change `RSVP_KEY` to a new value and
redeploy.

---

## Things worth knowing

**The link is the only lock on adding names.** Anyone who has the URL can add a
name or change an answer, the same as a paper sign-up sheet on a table. That's
the right trade for a family party — no accounts, no passwords, grandparents can
use it. Setting `HOST_KEY` closes off deletion, which is the destructive half.
The page is `noindex` so it won't turn up in search, but keep the link inside the
family chat, and download the CSV now and then if you want a snapshot.

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
- **The note box** is currently commented out in the form. Uncomment that block
  to bring it back; the code handles the field being present or absent, and
  notes already collected are kept either way rather than blanked on the next
  edit.
- **Date** — appears in the hero, the footer, and once in the script as
  `PARTY` (`2026-10-31T00:00:00+08:00`), which drives the countdown.
- **Draw date** — `DRAW_DATE` in the environment, or the default at the top of
  `api/rsvp.js`.

## Starting a fresh list

Set an environment variable `RSVP_KEY` to any new value and redeploy. The
function will read and write a different Redis hash, leaving the old list intact
in case you want it back.
