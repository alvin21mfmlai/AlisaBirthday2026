#!/usr/bin/env node
//
// Recompute the lucky draw allocation from the recorded seed.
//
// The point of this script is that it doesn't touch the database. Give it the
// seed and the list of names, and it prints the numbers. If they match what the
// site showed, the allocation was fixed the moment the seed was generated and
// nobody nudged it afterwards.
//
//   node tools/verify-draw.js <seed> "Sherman Tan" "Michelle Tan" ...
//   node tools/verify-draw.js <seed> < names.txt          # one name per line
//
// The seed is shown to the host when numbers are issued, and is returned by
// GET /api/rsvp under `draw.seed`.
//
// Note: this reproduces the initial allocation only. Anyone who replied after
// numbers went out was appended at the end and won't line up here — pass just
// the names that were on the list when the numbers were issued.

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

function shuffle(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function run(seed, names) {
  const bySlug = {};
  names.forEach(function (n) { bySlug[slug(n)] = n; });

  const fields = Object.keys(bySlug).sort();
  const order = shuffle(fields, mulberry32(xmur3(seed)()));

  console.log("seed:   " + seed);
  console.log("guests: " + order.length);
  console.log("");
  order.forEach(function (f, i) {
    console.log(String(i + 1).padStart(4) + "  " + bySlug[f]);
  });
}

const args = process.argv.slice(2);
const seed = args.shift();

if (!seed) {
  console.error("usage: node tools/verify-draw.js <seed> [names...]");
  console.error("       node tools/verify-draw.js <seed> < names.txt");
  process.exit(1);
}

if (args.length) {
  run(seed, args);
} else {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", function (c) { raw += c; });
  process.stdin.on("end", function () {
    const names = raw.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
    if (!names.length) {
      console.error("No names given. Pass them as arguments or pipe one per line.");
      process.exit(1);
    }
    run(seed, names);
  });
}
