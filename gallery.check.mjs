// node gallery.check.mjs
//
// The gallery's pure parts: which files a view shows, the date sections, the rows the virtual
// grid draws, and which rows are on screen.
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({ entryPoints: ["src/logic.ts"], bundle: true, format: "esm", write: false, platform: "node" });
const L = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

// ---- kinds ------------------------------------------------------------------------------------
assert.equal(L.kindOf("C:\\a\\IMG_1.JPG"), "photo", "extension in capitals");
assert.equal(L.kindOf("C:\\a\\clip.mov"), "video");
assert.equal(L.kindOf("C:\\a\\notes.txt"), null);
assert.equal(L.needsThumbView("x.HEIC"), true);
assert.equal(L.needsThumbView("x.jpg"), false);
assert.equal(L.playsInline("a.MP4"), true);
assert.equal(L.playsInline("a.mkv"), false, "WebView2 has no mkv");

// ---- folders ----------------------------------------------------------------------------------
assert.equal(L.inFolder("D:\\Games\\Factorio\\a.png", "d:/games/factorio"), true, "case and slashes");
assert.equal(L.inFolder("D:\\Games\\Factorio2\\a.png", "D:\\Games\\Factorio"), false, "a sibling with a longer name");
assert.equal(L.inFolder("D:\\Games\\Factorio", "D:\\Games\\Factorio\\"), true);
assert.equal(L.folderOf("C:\\a\\b\\c.jpg"), "C:\\a\\b");
assert.equal(L.nameOf("C:\\a\\b\\c.jpg"), "c.jpg");

// ---- visible ----------------------------------------------------------------------------------
const items = [
  { path: "C:\\Pics\\old.jpg", size: 1, mtime: 1000 },
  { path: "C:\\Pics\\new.jpg", size: 1, mtime: 3000 },
  { path: "C:\\Pics\\trip.mp4", size: 1, mtime: 2000 },
  { path: "D:\\Game\\tex.png", size: 1, mtime: 5000 },
  { path: "C:\\Pics\\readme.txt", size: 1, mtime: 9000 },
];
const v = (o) => L.visible(items, { filter: "all", query: "", hidden: [], favourites: new Set(), ...o }).map((i) => L.nameOf(i.path));
assert.deepEqual(v({}), ["tex.png", "new.jpg", "trip.mp4", "old.jpg"], "newest first, non-media dropped");
assert.deepEqual(v({ filter: "photos" }), ["tex.png", "new.jpg", "old.jpg"]);
assert.deepEqual(v({ filter: "videos" }), ["trip.mp4"]);
assert.deepEqual(v({ hidden: ["d:\\game"] }), ["new.jpg", "trip.mp4", "old.jpg"], "a hidden folder drops its files");
assert.deepEqual(v({ query: "TRIP" }), ["trip.mp4"], "query ignores case");
assert.deepEqual(v({ query: "pics" }), ["new.jpg", "trip.mp4", "old.jpg"], "query matches the folder too");
assert.deepEqual(v({ filter: "favourites", favourites: new Set([L.favKey("C:/PICS/old.jpg")]) }), ["old.jpg"], "favourites keyed case-insensitively");

// ---- date sections ----------------------------------------------------------------------------
// Friday 9 October 2026, 15:00 local time. The week starts on Monday the 5th.
const now = new Date(2026, 9, 9, 15, 0).getTime();
const at = (y, m, d, h = 12) => new Date(y, m, d, h).getTime();
const dated = [
  at(2026, 9, 9, 9), at(2026, 9, 9, 1),  // today, twice
  at(2026, 9, 8),                        // yesterday
  at(2026, 9, 5, 0),                     // Monday, this week
  at(2026, 9, 4),                        // Sunday: last week, so October
  at(2026, 8, 30),                       // September
].map((mtime, i) => ({ path: `C:\\p\\${i}.jpg`, size: 1, mtime }));
const sections = L.groupByDate(dated, now);
assert.deepEqual(sections.map((s) => [s.label, s.items.length]),
  [["Today", 2], ["Yesterday", 1], ["This week", 1], ["October 2026", 1], ["September 2026", 1]]);

// ---- rows -------------------------------------------------------------------------------------
const rows = L.toRows(sections, 4);
assert.deepEqual(rows.map((r) => r.kind === "head" ? r.label : r.items.length),
  ["Today", 2, "Yesterday", 1, "This week", 1, "October 2026", 1, "September 2026", 1]);
const nine = L.toRows([{ label: "X", items: Array.from({ length: 9 }, (_, i) => ({ path: `${i}.jpg`, size: 1, mtime: 0 })) }], 4);
assert.deepEqual(nine.map((r) => r.kind === "head" ? "h" : r.items.length), ["h", 4, 4, 1], "a section's last row is short");

// ---- on-screen rows ---------------------------------------------------------------------------
// Rows 0..3 at tops 0, 30, 130, 230; total height 330.
const tops = [0, 30, 130, 230, 330];
assert.deepEqual(L.rowRange(tops, 0, 100), [0, 2], "first two rows overlap 0..100");
assert.deepEqual(L.rowRange(tops, 130, 230), [2, 3], "exactly one row");
assert.deepEqual(L.rowRange(tops, 200, 1000), [2, 4], "to the end");
assert.deepEqual(L.rowRange(tops, 29, 31), [0, 2], "a band across a boundary");

assert.equal(L.fmtSize(40 * 1024), "40 KB");
assert.equal(L.fmtSize(3.5 * 1024 * 1024), "3.5 MB");

// ---- types ------------------------------------------------------------------------------------
// Windows paths, written with / here and turned into \ .
const W = (p) => p.replaceAll("/", "\\");
const mixed = [
  { path: W("C:/A/1.jpg"), size: 1, mtime: 5 }, { path: W("C:/A/2.JPG"), size: 1, mtime: 4 },
  { path: W("C:/A/sub/3.png"), size: 1, mtime: 9 }, { path: W("C:/B/4.mp4"), size: 1, mtime: 3 },
  { path: W("C:/B/5.jpg"), size: 1, mtime: 2 }, { path: W("C:/B/notes.txt"), size: 1, mtime: 1 },
];
assert.deepEqual(L.typeCounts(mixed), [["jpg", 3], ["mp4", 1], ["png", 1]], "most first, case folded, non-media left out");
const vt = (o) => L.visible(mixed, { filter: "all", query: "", hidden: [], favourites: new Set(), ...o }).map((i) => L.nameOf(i.path));
assert.deepEqual(vt({ types: new Set(["png", "mp4"]) }), ["3.png", "4.mp4"], "several types at once");
assert.deepEqual(vt({ types: new Set() }), ["3.png", "1.jpg", "2.JPG", "4.mp4", "5.jpg"], "no types ticked keeps all");

// ---- albums -----------------------------------------------------------------------------------
assert.deepEqual(vt({ folder: "c:/a" }), ["1.jpg", "2.JPG"], "an album holds its folder's files, not its subfolders'");
assert.deepEqual(vt({ folder: W("C:/A/") }), ["1.jpg", "2.JPG"]);
const al = L.albums(L.visible(mixed, { filter: "all", query: "", hidden: [], favourites: new Set() }));
assert.deepEqual(al.map((a) => [a.folder, a.count, L.nameOf(a.cover.path)]),
  [[W("C:/A"), 2, "1.jpg"], [W("C:/B"), 2, "4.mp4"], [W("C:/A/sub"), 1, "3.png"]],
  "biggest first, ties by newest cover; the cover is the newest file");

// ---- sort -------------------------------------------------------------------------------------
const byDate = L.visible(mixed, { filter: "all", query: "", hidden: [], favourites: new Set() });
const sizes = byDate.map((it, i) => ({ ...it, size: [10, 30, 30, 5, 20][i] }));
const names = (xs) => xs.map((i) => L.nameOf(i.path));
assert.deepEqual(names(L.sortItems(byDate, "newest")), ["3.png", "1.jpg", "2.JPG", "4.mp4", "5.jpg"]);
assert.deepEqual(names(L.sortItems(byDate, "oldest")), ["5.jpg", "4.mp4", "2.JPG", "1.jpg", "3.png"]);
assert.deepEqual(names(L.sortItems(sizes, "largest")), ["1.jpg", "2.JPG", "5.jpg", "3.png", "4.mp4"], "equal sizes keep newest first");
const numbered = ["img10.jpg", "img2.jpg", "IMG1.jpg"].map((n, i) => ({ path: W(`C:/x/${n}`), size: 1, mtime: i }));
assert.deepEqual(names(L.sortItems(numbered, "name")), ["IMG1.jpg", "img2.jpg", "img10.jpg"], "numbers in names sort as numbers, case ignored");
assert.equal(L.groupsByDate("oldest"), true);
assert.equal(L.groupsByDate("largest"), false);

// ---- selection --------------------------------------------------------------------------------
const order = ["a", "b", "c", "d", "e"];
const none = new Set();
assert.equal(L.clickSelect(order, none, null, "c", { ctrl: false, shift: false }), null, "a plain click with nothing selected opens");
let s = L.clickSelect(order, none, null, "b", { ctrl: true, shift: false });
assert.deepEqual([...s.selected], ["b"]);
s = L.clickSelect(order, s.selected, s.anchor, "e", { ctrl: false, shift: true });
assert.deepEqual([...s.selected].sort(), ["b", "c", "d", "e"], "shift selects the range from the anchor");
assert.equal(s.anchor, "b", "the anchor stays for the next shift-click");
s = L.clickSelect(order, s.selected, s.anchor, "c", { ctrl: false, shift: false });
assert.deepEqual([...s.selected].sort(), ["b", "d", "e"], "with a selection, a plain click toggles");
s = L.clickSelect(order, new Set(["d"]), "d", "a", { ctrl: false, shift: true });
assert.deepEqual([...s.selected].sort(), ["a", "b", "c", "d"], "a range backwards");

// ---- date taken -------------------------------------------------------------------------------
const shot = { path: "a.jpg", size: 1, mtime: 9000, taken: 1000 };
assert.equal(L.when(shot), 1000, "taken wins over modified");
assert.equal(L.when({ ...shot, taken: 0 }), 9000, "read and absent: modified");
assert.equal(L.when({ path: "b.jpg", size: 1, mtime: 9000 }), 9000, "not read yet: modified");
assert.deepEqual(L.visible([{ path: "x.jpg", size: 1, mtime: 5000 }, shot], { filter: "all", query: "", hidden: [], favourites: new Set() })
  .map((i) => i.path), ["x.jpg", "a.jpg"], "a photo copied today but taken long ago sorts by when it was taken");

// ---- duplicates -------------------------------------------------------------------------------
const files = [
  { path: "C:/a/1.jpg", size: 100, mtime: 3 }, { path: "C:/b/1 (copy).jpg", size: 100, mtime: 5 },
  { path: "C:/c/other.jpg", size: 100, mtime: 4 },  // same size, different contents
  { path: "C:/d/big.mp4", size: 900, mtime: 1 }, { path: "C:/e/big.mp4", size: 900, mtime: 2 }, { path: "C:/f/big.mp4", size: 900, mtime: 7 },
  { path: "C:/g/alone.png", size: 55, mtime: 1 },
];
assert.deepEqual(L.sameSize(files).map((f) => f.path).sort(), files.slice(0, 6).map((f) => f.path).sort(), "a unique size is never hashed");
const hash = { "C:/a/1.jpg": "h1", "C:/b/1 (copy).jpg": "h1", "C:/c/other.jpg": "h2", "C:/d/big.mp4": "h3", "C:/e/big.mp4": "h3", "C:/f/big.mp4": "h3" };
const groups = L.duplicateGroups(L.sameSize(files), (f) => hash[f.path]);
assert.deepEqual(groups.map((g) => g.map((f) => f.path)), [
  ["C:/d/big.mp4", "C:/e/big.mp4", "C:/f/big.mp4"],  // 1,800 bytes to reclaim
  ["C:/a/1.jpg", "C:/b/1 (copy).jpg"],               // 100
], "most to reclaim first, each oldest first; a lone hash is no group");
assert.deepEqual(L.duplicateGroups(files, () => null), [], "nothing hashed, no groups");

// ---- keyboard focus ---------------------------------------------------------------------------
const tiles = (...ps) => ({ kind: "tiles", items: ps.map((p) => ({ path: p, size: 1, mtime: 0 })) });
const grid = [{ kind: "head", label: "Today", count: 5 }, tiles("a", "b", "c"), tiles("d", "e"), { kind: "head", label: "Old", count: 3 }, tiles("f", "g", "h")];
assert.equal(L.moveFocus(grid, null, "down"), "a", "no focus: the first file");
assert.equal(L.moveFocus(grid, "c", "right"), "d", "right runs on into the next row");
assert.equal(L.moveFocus(grid, "e", "right"), "f", "and across a heading");
assert.equal(L.moveFocus(grid, "a", "left"), null);
assert.equal(L.moveFocus(grid, "c", "down"), "e", "down to a shorter row lands on its last tile");
assert.equal(L.moveFocus(grid, "e", "down"), "g", "down across a heading keeps the column");
assert.equal(L.moveFocus(grid, "b", "up"), null);
assert.equal(L.moveFocus(grid, "h", "down"), null);

console.log("gallery ok");
