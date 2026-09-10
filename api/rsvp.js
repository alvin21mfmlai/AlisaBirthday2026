// RSVP store for Alisa's birthday page.
//
// Talks to Upstash Redis over its REST API using plain fetch, so this file has
// no npm dependencies and nothing to build. Every guest is one field in a single
// Redis hash, which means a whole list is one round trip and two people
// replying at the same moment can't overwrite each other.
//
// Environment variables (the Vercel Marketplace Upstash integration injects the
// first pair automatically; the others are accepted so a hand-made Upstash
// database works too):
//   KV_REST_API_URL        / KV_REST_API_TOKEN
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   REDIS_REST_URL         / REDIS_REST_TOKEN
//
// Optional:
//   RSVP_KEY   name of the Redis hash (default "alisa2:rsvp"). Change it to
//              start a fresh, empty guest list without touching the old one.

const REST_URL =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.REDIS_REST_URL;

const REST_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.REDIS_REST_TOKEN;

const HASH = process.env.RSVP_KEY || "alisa2:rsvp";

// Optional. When set, the guest list gains a host mode at ?host=<HOST_KEY>
// which can edit or remove anyone, and deletions by anyone else are limited to
// the entry they created. Leave it unset and the list stays fully open.
const HOST_KEY = process.env.HOST_KEY || "";

// When lucky draw numbers become visible. Numbers are handed out by the first
// request that arrives on or after this moment — no cron job needed, which
// matters because Hobby plans only get one scheduled run a day. Override it to
// rehearse the whole thing early.
const DRAW_DATE = process.env.DRAW_DATE || "2026-10-30T00:00:00+08:00";
const DRAW_AT = Date.parse(DRAW_DATE);
const DRAW_KEY = HASH + ":draw";

const MAX_GUESTS = 500;
const NAME_MAX = 60;
const NOTE_MAX = 140;
const TOKEN_MAX = 64;

const crypto = require("crypto");

// Catches "Sherman's family", "Tan family x4", "the Lims +3" and friends.
const GROUP_ENTRY =
  /\b(?:family|families|fam|household|clan|pax|et\s*al)\b|\band\s+(?:kids|family|co)\b|\bx\s*\d+\b|\+\s*\d+|\b\d+\s*(?:pax|persons?|people|adults?|kids?|children)\b/i;

async function redis(command) {
  const r = await fetch(REST_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + REST_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });
  const data = await r.json().catch(function () { return {}; });
  if (!r.ok || data.error) throw new Error(data.error || "Redis HTTP " + r.status);
  return data.result;
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, NAME_MAX);
}

function cleanName(raw) {
  return String(raw == null ? "" : raw).replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
}

// HGETALL comes back as a flat [field, value, field, value] array over REST,
// but some client configurations hand back a plain object. Accept either.
function toEntries(result) {
  const out = [];
  if (!result) return out;
  if (Array.isArray(result)) {
    for (let i = 0; i < result.length; i += 2) {
      try { out.push(JSON.parse(result[i + 1])); } catch (e) { /* skip a bad row */ }
    }
  } else if (typeof result === "object") {
    Object.keys(result).forEach(function (k) {
      try { out.push(JSON.parse(result[k])); } catch (e) { /* skip a bad row */ }
    });
  }
  return out.filter(function (g) { return g && g.name; }).map(function (g) {
    // `t` is the browser token that lets a guest remove their own entry. It is
    // never sent to the client.
    return { name: g.name, group: g.group, going: g.going, note: g.note, at: g.at };
  });
}

// A seeded shuffle, so the whole allocation can be recomputed from the seed
// alone and shown to anyone who wonders whether the draw was rigged. xmur3
// turns the seed string into a 32-bit state; mulberry32 is the generator.
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher-Yates. Every ordering is equally likely, which is the whole point.
function shuffle(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

// Allocates 1..N across everyone coming, once, and then hands the next number
// up to anyone who replies later. Numbers are never reused or reshuffled: once
// a guest has been told their number, it is theirs, and someone who switches to
// "can't make it" keeps theirs reserved in case they switch back.
async function ensureDraw(fields) {
  const raw = await redis(["GET", DRAW_KEY]);
  let draw = raw ? JSON.parse(raw) : null;

  // Nothing to allocate yet. Creating an empty draw here would burn the seed on
  // an empty roster and leave every real guest numbered in the order they
  // happened to reply.
  if (!draw && !fields.length) return null;

  if (!draw) {
    const seed = crypto.randomBytes(8).toString("hex");
    const order = shuffle(fields.slice().sort(), mulberry32(xmur3(seed)()));
    const numbers = {};
    order.forEach(function (f, i) { numbers[f] = i + 1; });
    draw = { seed: seed, issuedAt: new Date().toISOString(), numbers: numbers };

    // NX means the first request through wins; a second one that raced it reads
    // the winner's allocation instead of overwriting it.
    const claimed = await redis(["SET", DRAW_KEY, JSON.stringify(draw), "NX"]);
    if (claimed === null) {
      draw = JSON.parse(await redis(["GET", DRAW_KEY]));
    }
  }

  const missing = fields.filter(function (f) { return !(f in draw.numbers); }).sort();
  if (missing.length) {
    // Sorted order means two requests appending at once compute the same
    // numbers, so whichever write lands last is still correct.
    let next = 0;
    Object.keys(draw.numbers).forEach(function (k) {
      if (draw.numbers[k] > next) next = draw.numbers[k];
    });
    const batchSeed = draw.seed + ":" + next;
    shuffle(missing, mulberry32(xmur3(batchSeed)())).forEach(function (f) {
      draw.numbers[f] = ++next;
    });
    await redis(["SET", DRAW_KEY, JSON.stringify(draw)]);
  }

  return draw;
}

// `t` has been a single string in earlier versions of this file; accept both.
function toTokenList(entry) {
  if (!entry || !entry.t) return [];
  return Array.isArray(entry.t) ? entry.t : [entry.t];
}

function attendingFields(guests) {
  return guests
    .filter(function (g) { return g.going === "yes"; })
    .map(function (g) { return slug(g.name); });
}

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch (e) { return {}; } }
  return b;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!REST_URL || !REST_TOKEN) {
    return res.status(500).json({
      error: "storage_not_configured",
      message: "No Redis database is connected to this project yet."
    });
  }

  try {
    if (req.method === "GET") {
      const guests = toEntries(await redis(["HGETALL", HASH]));
      const claimedKey = (req.query && req.query.host) || "";
      const host = !!HOST_KEY && claimedKey === HOST_KEY;

      const due = Number.isFinite(DRAW_AT) && Date.now() >= DRAW_AT;
      const alreadyIssued = await redis(["GET", DRAW_KEY]);
      let draw = null;
      if (due || alreadyIssued) {
        draw = await ensureDraw(attendingFields(guests));
      }
      if (draw) {
        guests.forEach(function (g) {
          // Held, not shown: switching back to "coming" restores the same one.
          g.number = g.going === "yes" ? (draw.numbers[slug(g.name)] || null) : null;
        });
      }

      return res.status(200).json({
        guests: guests,
        host: host,
        hostModeAvailable: !!HOST_KEY,
        draw: {
          issued: !!draw,
          issuedAt: draw ? draw.issuedAt : null,
          seed: draw ? draw.seed : null,
          opensAt: DRAW_DATE
        }
      });
    }

    if (req.method === "POST") {
      const body = readBody(req);

      // Host-only: hand out numbers before the date, for a dry run.
      if (body.action === "issue") {
        if (!HOST_KEY || req.headers["x-host-key"] !== HOST_KEY) {
          return res.status(403).json({
            error: "not_host",
            message: "Only the host can issue draw numbers."
          });
        }
        const guests = toEntries(await redis(["HGETALL", HASH]));
        const draw = await ensureDraw(attendingFields(guests));
        return res.status(200).json({ ok: true, issuedAt: draw.issuedAt, seed: draw.seed });
      }

      const name = cleanName(body.name);
      const group = body.group;
      const going = body.going;
      const note = String(body.note == null ? "" : body.note).replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);

      if (name.length < 2) {
        return res.status(400).json({
          error: "invalid_name",
          message: "Please type your full name so we know who to give a number to."
        });
      }
      if (GROUP_ENTRY.test(name)) {
        return res.status(400).json({
          error: "group_entry",
          message: "That looks like a group entry. Each person needs their own name and their own number \u2014 please add one entry per guest."
        });
      }
      if (group !== "alvin" && group !== "gwen") {
        return res.status(400).json({
          error: "invalid_group",
          message: "Pick a side of the family so we can seat you together."
        });
      }
      if (going !== "yes" && going !== "no") {
        return res.status(400).json({
          error: "invalid_going",
          message: "Let us know whether you can make it."
        });
      }

      const field = slug(name);
      if (!field) {
        return res.status(400).json({
          error: "invalid_name",
          message: "That name uses characters we can't store. Try letters and numbers."
        });
      }

      // Room check, so a stray script can't inflate the list forever. Updating
      // someone already on the list is always allowed.
      const existing = await redis(["HEXISTS", HASH, field]);
      if (!existing) {
        const total = await redis(["HLEN", HASH]);
        if (Number(total) >= MAX_GUESTS) {
          return res.status(409).json({
            error: "list_full",
            message: "The guest list is full. Message Alvin or Gwen and they'll sort it out."
          });
        }
      }

      // Every browser that has submitted this name may later remove it, so a
      // guest who replies on their phone and edits on a laptop isn't locked out
      // of either. Oldest claims fall off past five.
      const token = String(body.token == null ? "" : body.token).slice(0, TOKEN_MAX);
      let tokens = [];
      if (existing) {
        try {
          const prev = JSON.parse(await redis(["HGET", HASH, field]));
          tokens = toTokenList(prev);
        } catch (e) { /* unreadable previous row; start the claim list fresh */ }
      }
      if (token && tokens.indexOf(token) === -1) tokens.push(token);
      tokens = tokens.slice(-5);

      const entry = {
        name: name,
        group: group,
        going: going,
        note: note,
        at: new Date().toISOString(),
        t: tokens
      };
      await redis(["HSET", HASH, field, JSON.stringify(entry)]);
      return res.status(200).json({
        ok: true,
        entry: { name: name, group: group, going: going, note: note, at: entry.at }
      });
    }

    if (req.method === "DELETE") {
      const name = cleanName(
        (req.query && req.query.name) ||
        (readBody(req).name) ||
        ""
      );
      const field = slug(name);
      if (!field) {
        return res.status(400).json({ error: "invalid_name", message: "Tell us which name to remove." });
      }

      if (HOST_KEY) {
        const asHost = req.headers["x-host-key"] === HOST_KEY;
        if (!asHost) {
          const offered = String(
            (req.query && req.query.token) || readBody(req).token || ""
          ).slice(0, TOKEN_MAX);
          let stored = [];
          try {
            const prev = JSON.parse(await redis(["HGET", HASH, field]));
            stored = toTokenList(prev);
          } catch (e) { /* no such entry; fall through to the check below */ }
          if (!offered || stored.indexOf(offered) === -1) {
            return res.status(403).json({
              error: "not_yours",
              message: "Only the person who added this name can remove it. Ask Alvin or Gwen to take it off."
            });
          }
        }
      }

      await redis(["HDEL", HASH, field]);
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    console.error("rsvp:", err && err.message);
    return res.status(502).json({
      error: "storage_error",
      message: "The guest list is temporarily unreachable. Try again in a moment."
    });
  }
};
