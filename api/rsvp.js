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

const MAX_GUESTS = 500;
const NAME_MAX = 60;
const NOTE_MAX = 140;

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
  return out.filter(function (g) { return g && g.name; });
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
      return res.status(200).json({ guests: guests });
    }

    if (req.method === "POST") {
      const body = readBody(req);
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

      const entry = {
        name: name,
        group: group,
        going: going,
        note: note,
        at: new Date().toISOString()
      };
      await redis(["HSET", HASH, field, JSON.stringify(entry)]);
      return res.status(200).json({ ok: true, entry: entry });
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
