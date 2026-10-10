// The gallery's pure parts: what a file is, which files a view shows, and how they group by date.
// No React and no Deck, so gallery.check.mjs runs them directly.

export interface Item {
  path: string; size: number; mtime: number;
  /** When it was taken (the photo's own data), ms. 0 when read and absent; missing until read. */
  taken?: number;
}
/** The date an item is shown and sorted under: when it was taken, else when it was last written. */
export const when = (it: Item) => it.taken || it.mtime;
export type Kind = "photo" | "video";
/** "albums" lists folders; inside one, the folder's items show as "all" would. */
export type Filter = "all" | "photos" | "videos" | "favourites" | "albums";
export type Sort = "newest" | "oldest" | "largest" | "name";

export const PHOTO_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif", "avif", "tif", "tiff"];
export const VIDEO_EXTS = ["mp4", "mov", "mkv", "webm", "avi", "m4v", "wmv"];

/** Folders skipped at any depth: Windows and programs, app data, and build and package folders,
 *  which hold thousands of images that are parts of something rather than pictures. */
export const DEFAULT_EXCLUDES = [
  "Windows", "Windows.old", "Program Files", "Program Files (x86)", "ProgramData", "AppData",
  "$Recycle.Bin", "System Volume Information", "MSOCache",
  "node_modules", ".git", "build", ".dart_tool", "target", "dist", ".gradle", "Pods",
];
/** Smaller than this is an icon or a sprite, not a picture. */
export const DEFAULT_MIN_KB = 30;

/** The extension, lower case, without the dot: "jpg". */
export const ext = (p: string) => p.slice(p.lastIndexOf(".") + 1).toLowerCase();
export const kindOf = (p: string): Kind | null =>
  PHOTO_EXTS.includes(ext(p)) ? "photo" : VIDEO_EXTS.includes(ext(p)) ? "video" : null;
/** Videos WebView2 can play. The rest (mkv, avi, wmv) open in the default app instead. */
export const playsInline = (p: string) => ["mp4", "webm", "mov", "m4v"].includes(ext(p));
/** WebView2 cannot draw these itself, so the viewer shows a large shell thumbnail instead. */
export const needsThumbView = (p: string) => ["heic", "heif", "tif", "tiff"].includes(ext(p));

export const folderOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")));
export const nameOf = (p: string) => p.slice(Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1);
const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();

/** Whether `path` is inside `folder` (or is it), whatever the case and slashes. */
export function inFolder(path: string, folder: string): boolean {
  const p = norm(path), f = norm(folder).replace(/\\+$/, "");
  return p === f || p.startsWith(f + "\\");
}

/**
 * The items a view shows, newest first: of the right kind, outside every hidden folder, a
 * favourite when that is the filter, and with the query in the file or folder name.
 */
export function visible(items: readonly Item[], o: {
  filter: Filter; query: string; hidden: readonly string[]; favourites: ReadonlySet<string>;
  /** Extensions to keep; empty keeps every type. */
  types?: ReadonlySet<string>;
  /** Only the files directly in this folder (an open album). */
  folder?: string;
}): Item[] {
  const q = o.query.trim().toLowerCase();
  const types = o.types?.size ? o.types : null;
  const folder = o.folder ? norm(o.folder).replace(/\\+$/, "") : null;
  // Each hidden folder normalised once, and each path once, rather than per pair: this runs over
  // every file on the disk at each click of a filter.
  const hidden = o.hidden.map((h) => norm(h).replace(/\\+$/, ""));
  return items.filter((it) => {
    const k = kindOf(it.path);
    if (!k) return false;
    if (o.filter === "photos" && k !== "photo") return false;
    if (o.filter === "videos" && k !== "video") return false;
    if (types && !types.has(ext(it.path))) return false;
    const p = norm(it.path);
    if (folder && p.slice(0, p.lastIndexOf("\\")) !== folder) return false;
    if (o.filter === "favourites" && !o.favourites.has(p)) return false;
    if (hidden.some((h) => p === h || p.startsWith(h + "\\"))) return false;
    return !q || p.includes(q.replace(/\//g, "\\"));
  }).sort((a, b) => when(b) - when(a));
}

/** `items` (newest first, as visible returns them) in the order the sort asks for. Stable, so
 *  equal sizes or names stay newest first. */
export function sortItems(items: Item[], sort: Sort): Item[] {
  if (sort === "oldest") return [...items].reverse();
  if (sort === "largest") return [...items].sort((a, b) => b.size - a.size);
  if (sort === "name") return [...items].sort((a, b) => nameOf(a.path).localeCompare(nameOf(b.path), undefined, { numeric: true, sensitivity: "base" }));
  return items;
}
/** Date headings only mean something when the order is by date. */
export const groupsByDate = (sort: Sort) => sort === "newest" || sort === "oldest";

/**
 * What a click does to the selection. Ctrl toggles one; Shift selects from the anchor to here, in
 * the order on screen; a plain click toggles too once anything is selected (and otherwise opens
 * the file, which the caller handles: this returns null). Returns the new selection and anchor.
 */
export function clickSelect(order: readonly string[], selected: ReadonlySet<string>, anchor: string | null,
  path: string, mods: { ctrl: boolean; shift: boolean }): { selected: Set<string>; anchor: string } | null {
  if (mods.shift && anchor !== null) {
    const a = order.indexOf(anchor), b = order.indexOf(path);
    if (a !== -1 && b !== -1) {
      const next = new Set(selected);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(order[i]);
      return { selected: next, anchor };
    }
  }
  if (!mods.ctrl && !mods.shift && selected.size === 0) return null;
  const next = new Set(selected);
  if (next.has(path)) next.delete(path); else next.add(path);
  return { selected: next, anchor: path };
}
export const favKey = norm;

/** Each media type on disk and how many files have it, most first: the type filter's list. */
export function typeCounts(items: readonly Item[]): [string, number][] {
  const n = new Map<string, number>();
  for (const it of items) { const e = ext(it.path); if (kindOf(it.path)) n.set(e, (n.get(e) ?? 0) + 1); }
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** A folder as an album: its newest item is the cover. */
export interface Album { folder: string; count: number; cover: Item }

/**
 * Every folder the items are directly in, biggest first. `items` come newest first (visible's
 * order), so the first one seen in a folder is its cover. Folders differing only in case are one.
 */
export function albums(items: readonly Item[]): Album[] {
  const by = new Map<string, Album>();
  for (const it of items) {
    const folder = folderOf(it.path);
    const k = norm(folder);
    const a = by.get(k);
    if (a) a.count++;
    else by.set(k, { folder, count: 1, cover: it });
  }
  return [...by.values()].sort((a, b) => b.count - a.count || b.cover.mtime - a.cover.mtime);
}

/**
 * Newest-first items cut into date sections: Today, Yesterday, This week, then one per month
 * ("October 2026"). `now` is passed in so the check can fix it.
 */
export function groupByDate(items: readonly Item[], now: number): { label: string; items: Item[] }[] {
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  const today = day.getTime();
  const yesterday = today - 86_400_000;
  // Monday as the week's first day.
  const weekStart = today - ((day.getDay() + 6) % 7) * 86_400_000;
  // A month's name is formatted once and reused: formatting a date is slow enough that doing it
  // for each of 22,000 files took over a second on every click of a filter.
  const months = new Map<number, string>();
  const label = (t: number) => {
    if (t >= today) return "Today";
    if (t >= yesterday) return "Yesterday";
    if (t >= weekStart) return "This week";
    const d = new Date(t);
    const key = d.getFullYear() * 12 + d.getMonth();
    let name = months.get(key);
    if (!name) { name = d.toLocaleDateString("en-GB", { month: "long", year: "numeric" }); months.set(key, name); }
    return name;
  };
  const out: { label: string; items: Item[] }[] = [];
  for (const it of items) {
    const l = label(when(it));
    if (out.at(-1)?.label === l) out.at(-1)!.items.push(it);
    else out.push({ label: l, items: [it] });
  }
  return out;
}

/** A grid row: a section heading, or up to `cols` items. */
export type Row = { kind: "head"; label: string; count: number } | { kind: "tiles"; items: Item[] };

/** Sections flattened into the rows the virtual list draws. */
export function toRows(sections: { label: string; items: Item[] }[], cols: number): Row[] {
  const rows: Row[] = [];
  for (const s of sections) {
    rows.push({ kind: "head", label: s.label, count: s.items.length });
    for (let i = 0; i < s.items.length; i += cols) rows.push({ kind: "tiles", items: s.items.slice(i, i + cols) });
  }
  return rows;
}

/** The first and one-past-last row overlapping [top, bottom), given each row's top offset
 *  (`tops`, ascending, with the total height as its last entry). Binary search: 20,000 rows. */
export function rowRange(tops: readonly number[], top: number, bottom: number): [number, number] {
  const n = tops.length - 1;
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (tops[m + 1] <= top) lo = m + 1; else hi = m; }
  let end = lo;
  while (end < n && tops[end] < bottom) end++;
  return [lo, end];
}

/**
 * Files that could be copies of each other: two or more with exactly the same size. Only these
 * are worth hashing; a file with a size nobody else has cannot have a duplicate.
 */
export function sameSize(items: readonly Item[]): Item[] {
  const by = new Map<number, Item[]>();
  for (const it of items) { const g = by.get(it.size); if (g) g.push(it); else by.set(it.size, [it]); }
  return [...by.values()].filter((g) => g.length > 1).flat();
}

/**
 * Groups of identical files, by content hash: each group oldest first (the original, which the
 * gallery keeps), groups with the most bytes to reclaim first. Files without a hash are left out.
 */
export function duplicateGroups(items: readonly Item[], hashOf: (it: Item) => string | null | undefined): Item[][] {
  const by = new Map<string, Item[]>();
  for (const it of items) {
    const h = hashOf(it); if (!h) continue;
    const g = by.get(h); if (g) g.push(it); else by.set(h, [it]);
  }
  const waste = (g: Item[]) => g[0].size * (g.length - 1);
  return [...by.values()].filter((g) => g.length > 1)
    .map((g) => g.sort((a, b) => a.mtime - b.mtime || a.path.length - b.path.length))
    .sort((a, b) => waste(b) - waste(a));
}

/**
 * Where an arrow key moves the grid's focus from `path`: left and right step through the files in
 * order, across rows and sections; up and down go to the same column of the tile row above or
 * below, or its last tile when that row is shorter. Null when there is nowhere to go. With no
 * focus yet, any arrow lands on the first file.
 */
export function moveFocus(rows: readonly Row[], path: string | null, key: "left" | "right" | "up" | "down"): string | null {
  const tileRows = rows.filter((r): r is { kind: "tiles"; items: Item[] } => r.kind === "tiles");
  const flat = tileRows.flatMap((r) => r.items.map((it) => it.path));
  if (!flat.length) return null;
  if (path === null) return flat[0];
  const i = flat.indexOf(path);
  if (i === -1) return flat[0];
  if (key === "left") return i > 0 ? flat[i - 1] : null;
  if (key === "right") return i < flat.length - 1 ? flat[i + 1] : null;
  const r = tileRows.findIndex((row) => row.items.some((it) => it.path === path));
  const col = tileRows[r].items.findIndex((it) => it.path === path);
  const next = tileRows[key === "up" ? r - 1 : r + 1];
  return next ? next.items[Math.min(col, next.items.length - 1)].path : null;
}

export const fmtSize = (b: number) =>
  b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
