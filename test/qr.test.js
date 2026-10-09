import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const source = await readFile(new URL("../public/qr.js", import.meta.url), "utf8");
const context = createContext({ TextEncoder });
runInContext(source, context);
const qr = context.nexusQr;

// Independent reference reader: recovers the payload from the module grid
// using its own function-pattern map and a hard-coded alignment table, so the
// round-trip checks layout, masking, interleaving and padding rather than
// echoing the encoder's own data structures.
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
const ECC_M = { 1: [10, 1], 2: [16, 1], 3: [26, 1], 4: [18, 2], 5: [24, 2],
  6: [16, 4], 7: [18, 4], 8: [22, 4], 9: [22, 5], 10: [26, 5] };
const MASK = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0, (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => ((((r + c) % 2) + ((r * c) % 3)) % 2) === 0,
];

function functionMap(version, n) {
  const f = Array.from({ length: n }, () => new Array(n).fill(false));
  const rect = (r0, c0, h, w) => {
    for (let r = r0; r < r0 + h; r += 1) for (let c = c0; c < c0 + w; c += 1) if (r < n && c < n) f[r][c] = true;
  };
  rect(0, 0, 9, 9); rect(0, n - 8, 9, 8); rect(n - 8, 0, 8, 9); // finders + separators + format
  rect(6, 0, 1, n); rect(0, 6, n, 1); // timing
  if (version >= 7) { rect(0, n - 11, 6, 3); rect(n - 11, 0, 3, 6); }
  const a = ALIGN[version];
  a.forEach((r, i) => a.forEach((c, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === a.length - 1) || (i === a.length - 1 && j === 0)) return;
    rect(r - 2, c - 2, 5, 5);
  }));
  return f;
}

function formatMask(modules, n) {
  const bits = [];
  for (let i = 0; i <= 5; i += 1) bits.push(modules[i][8]);
  bits.push(modules[7][8], modules[8][8], modules[8][7]);
  for (let i = 9; i < 15; i += 1) bits.push(modules[8][14 - i]);
  const value = bits.reduce((acc, bit, i) => acc | (bit ? 1 << i : 0), 0) ^ 0x5412;
  // Second copy must agree.
  const second = [];
  for (let i = 0; i < 8; i += 1) second.push(modules[8][n - 1 - i]);
  for (let i = 8; i < 15; i += 1) second.push(modules[n - 15 + i][8]);
  assert.equal(second.reduce((acc, bit, i) => acc | (bit ? 1 << i : 0), 0) ^ 0x5412, value);
  assert.equal(value >> 13, 0, "error-correction level M");
  assert.equal(modules[n - 8][8], true, "dark module");
  return (value >> 10) & 7;
}

function decode({ version, size: n, modules }) {
  const mask = formatMask(modules, n);
  const f = functionMap(version, n);
  const bits = [];
  let up = true;
  for (let c = n - 1; c > 0; c -= 2) {
    if (c === 6) c -= 1;
    for (let k = 0; k < n; k += 1) {
      const r = up ? n - 1 - k : k;
      for (const col of [c, c - 1]) {
        if (!f[r][col]) bits.push(modules[r][col] !== MASK[mask](r, col));
      }
    }
    up = !up;
  }
  const codewords = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | (bit ? 1 : 0), 0));
  }
  const [ecc, blocks] = ECC_M[version];
  const total = codewords.length;
  const shortCount = blocks - (total % blocks);
  const shortLen = Math.floor(total / blocks) - ecc;
  const data = Array.from({ length: blocks }, () => []);
  const parity = Array.from({ length: blocks }, () => []);
  let p = 0;
  for (let i = 0; i < shortLen + 1; i += 1) {
    for (let b = 0; b < blocks; b += 1) {
      if (i === shortLen && b < shortCount) continue;
      data[b].push(codewords[p]); p += 1;
    }
  }
  for (let i = 0; i < ecc; i += 1) for (let b = 0; b < blocks; b += 1) { parity[b].push(codewords[p]); p += 1; }
  // Every block must carry a valid Reed-Solomon remainder.
  data.forEach((block, b) => assert.deepEqual([...qr.reedSolomonRemainder(block, ecc)], parity[b]));
  const stream = data.flat().flatMap((byte) => [...Array(8)].map((_, i) => (byte >> (7 - i)) & 1));
  const read = (from, count) => stream.slice(from, from + count).reduce((acc, bit) => (acc << 1) | bit, 0);
  assert.equal(read(0, 4), 0b0100, "byte mode");
  const countBits = version <= 9 ? 8 : 16;
  const length = read(4, countBits);
  const bytes = Array.from({ length }, (_, i) => read(4 + countBits + i * 8, 8));
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

test("Reed-Solomon matches the published HELLO WORLD version 1-M vector", () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual([...qr.reedSolomonRemainder(data, 10)], [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test("encoded symbols round-trip through the independent reader", () => {
  const lengths = [1, 14, 15, 26, 27, 42, 43, 62, 63, 84, 85, 106, 107, 122, 123, 152, 153, 180, 181, 213];
  const seen = new Set();
  for (const length of lengths) {
    const text = `http://192.168.1.20:3000/${"abc-xyz/".repeat(40)}`.slice(0, length).padEnd(length, "q");
    const symbol = qr.encode(text);
    seen.add(symbol.version);
    assert.equal(symbol.size, symbol.version * 4 + 17);
    assert.equal(decode(symbol), text, `length ${length}`);
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const unicode = "http://nexus.test:3000/games/café-☃/";
  assert.equal(decode(qr.encode(unicode)), unicode);
});

test("typical LAN game and board links fit a compact symbol", () => {
  assert.ok(qr.encode("http://192.168.100.200:3000/games/captain-flip/board/").version <= 4);
});

test("function patterns are fixed and every mask choice is deterministic", () => {
  const symbol = qr.encode("http://192.168.1.20:3000/games/a/");
  for (const [r, c] of [[0, 0], [0, symbol.size - 7], [symbol.size - 7, 0]]) {
    for (let i = 0; i < 7; i += 1) {
      assert.equal(symbol.modules[r][c + i], true);
      assert.equal(symbol.modules[r + 6][c + i], true);
    }
    assert.equal(symbol.modules[r + 3][c + 3], true);
    assert.equal(symbol.modules[r + 1][c + 1], false);
  }
  assert.equal(JSON.stringify(qr.encode("http://192.168.1.20:3000/games/a/").modules), JSON.stringify(symbol.modules));
});

test("rejects empty and oversized input instead of emitting a bad code", () => {
  assert.throws(() => qr.encode(""), { name: "TypeError" });
  assert.throws(() => qr.encode(1), { name: "TypeError" });
  assert.throws(() => qr.encode("x".repeat(214)), { name: "RangeError" });
  assert.doesNotThrow(() => qr.encode("x".repeat(213)));
});

test("SVG and data URL contain only inert vector content", () => {
  const svg = qr.toSvg("http://nexus.test:3000/games/a/");
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+"/);
  assert.doesNotMatch(svg, /<script|href=|on\w+=|http:\/\/nexus/);
  const url = qr.toDataUrl("http://nexus.test:3000/games/a/");
  assert.ok(url.startsWith("data:image/svg+xml,%3Csvg"));
});

test("themed SVG keeps every module and colours only the finder squares separately", () => {
  const text = "http://192.168.1.24:3000/games/salt-and-sail/";
  const svg = qr.toSvg(text, { quietZone: 3, dark: "#2b1a0e", light: "#fbf5e8", finder: "#234a3f" });
  const { size, modules } = qr.encode(text);
  const fills = [...svg.matchAll(/<path d="([^"]*)" fill="(#[0-9a-f]+)"\/>/g)];
  assert.deepEqual(fills.map(([, , fill]) => fill), ["#2b1a0e", "#234a3f"]);
  assert.match(svg, /<rect width="\d+" height="\d+" fill="#fbf5e8"\/>/);
  const grid = Array.from({ length: size }, () => new Array(size).fill(false));
  const finder = (x, y) => (x < 7 && y < 7) || (x >= size - 7 && y < 7) || (x < 7 && y >= size - 7);
  fills.forEach(([, path], index) => {
    for (const [, x, y, w] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      for (let dx = 0; dx < Number(w); dx += 1) {
        const col = Number(x) - 3 + dx;
        const row = Number(y) - 3;
        assert.equal(grid[row][col], false, "modules are drawn once");
        assert.equal(finder(col, row), index === 1, "finder colour covers exactly the finder squares");
        grid[row][col] = true;
      }
    }
  });
  assert.deepEqual(grid, Array.from(modules, (row) => Array.from(row)));
  assert.throws(() => qr.toSvg(text, { dark: "red\"/><script>" }), /hex/);
});
