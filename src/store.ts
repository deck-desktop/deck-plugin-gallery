// The gallery's state: what is on disk (the index), and what you chose (favourites, hidden
// folders, what a scan skips). Module scope, shared by the tab and every Gallery pane.
//
// Two config files, both kept on this machine (plugin configs never sync, and these are paths on
// this machine's disks):
// - `plugin-gallery`: settings, favourites, hidden folders. Small, written when you change one.
// - `plugin-gallery-index`: every file the last scan found. Tens of thousands of rows, so it is a
//   file of its own, written only when a scan finds something different (rule 3: every write
//   wakes every config listener in Deck).
import { configRead, configWrite, fsFind, fsTrash, fsMove, fsCopy, fsHomeDir, fsHash, mediaMeta } from "../shim/bridge.js";
import { DEFAULT_EXCLUDES, DEFAULT_MIN_KB, PHOTO_EXTS, VIDEO_EXTS, duplicateGroups, favKey, inFolder, sameSize, type Filter, type Item, type Sort } from "./logic";

const CFG = "plugin-gallery";
const INDEX = "plugin-gallery-index";
/** A scan older than this is redone, in the background, when the gallery opens. */
const STALE_MS = 60 * 60 * 1000;

export interface Settings {
  favourites: string[];
  /** Folders whose files are not shown ("Hide this folder"), full paths. */
  hidden: string[];
  /** Folder names a scan skips at any depth. */
  excludes: string[];
  minKb: number;
  filter: Filter;
  /** Extensions the type filter keeps; empty keeps every type. */
  types: string[];
  sort: Sort;
}
const DEFAULTS: Settings = { favourites: [], hidden: [], excludes: DEFAULT_EXCLUDES, minKb: DEFAULT_MIN_KB, filter: "all", types: [], sort: "newest" };

let settings: Settings = DEFAULTS;
let favSet = new Set<string>();
let items: Item[] = [];
let scannedAt = 0;
let scanning = false;
let scanError = "";
let loaded = false;
let loading: Promise<void> | null = null;
let lastCfg = "", lastIndex = "";

let version = 0;
const listeners = new Set<() => void>();
const emit = () => { version++; listeners.forEach((f) => f()); };
export const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const getVersion = () => version;

export const getSettings = () => settings;
export const getItems = () => items;
export const favourites = () => favSet;
export const scanState = () => ({ scanning, scannedAt, error: scanError });
export const isLoaded = () => loaded;

/** Read both files once, then rescan if the index is old or missing. Every view waits on it. */
export function load(): Promise<void> {
  loading ??= (async () => {
    try {
      const t = await configRead(CFG);
      if (t.trim()) { settings = { ...DEFAULTS, ...JSON.parse(t) }; lastCfg = t; }
    } catch (e) { console.warn("[gallery] settings load failed", e); /* defaults */ }
    try {
      const t = await configRead(INDEX);
      if (t.trim()) {
        const v = JSON.parse(t) as { scannedAt: number; items: [string, number, number, number?][] };
        items = v.items.map(([path, size, mtime, taken]) => (typeof taken === "number" ? { path, size, mtime, taken } : { path, size, mtime }));
        scannedAt = v.scannedAt;
        lastIndex = t;
      }
    } catch { /* no index yet */ }
    favSet = new Set(settings.favourites.map(favKey));
    loaded = true;
    emit();
    if (Date.now() - scannedAt > STALE_MS) void rescan();
  })();
  return loading;
}

/** Walk every fixed drive again. The index on screen stays until the new one is complete. */
export async function rescan(): Promise<void> {
  if (scanning) return;
  scanning = true; scanError = ""; emit();
  try {
    const found = keepDates(await fsFind(null, [...PHOTO_EXTS, ...VIDEO_EXTS], settings.excludes, settings.minKb * 1024));
    items = found;
    scannedAt = Date.now();
    const text = indexText();
    // The time always differs, so compare the rows: an unchanged disk writes nothing.
    if (text.slice(text.indexOf(',"items"')) !== lastIndex.slice(lastIndex.indexOf(',"items"'))) {
      lastIndex = text;
      await configWrite(INDEX, text);
    }
  } catch (e) {
    scanError = String(e);
  } finally {
    scanning = false;
    emit();
  }
}

/** Where new pictures usually arrive: screenshots, downloads, a phone's import, the desktop. */
const RECENT_DIRS = ["Pictures", "Videos", "Desktop", "Downloads", "OneDrive\\Pictures", "OneDrive\\Desktop"];
let home = "";
let refreshing = false;

/**
 * Look again at only the folders new pictures usually land in, and fold what is there into the
 * index: new files appear, deleted ones go. Milliseconds, against a minute for every drive, so
 * the gallery runs it on a short timer while it is on screen. A folder that does not exist is
 * skipped by the walk.
 */
export async function refreshRecent(): Promise<void> {
  if (scanning || refreshing || !loaded) return;
  refreshing = true;
  try {
    home ||= await fsHomeDir();
    const roots = RECENT_DIRS.map((d) => `${home}\\${d}`);
    const found = await fsFind(roots, [...PHOTO_EXTS, ...VIDEO_EXTS], settings.excludes, settings.minKb * 1024);
    const inRoots = (p: string) => roots.some((r) => inFolder(p, r));
    const before = items.filter((it) => inRoots(it.path));
    // The same files with the same times: nothing to show and nothing to write.
    const sig = (xs: Item[]) => xs.map((x) => `${favKey(x.path)}|${x.mtime}`).sort().join("\n");
    if (sig(before) === sig(found)) return;
    items = [...items.filter((it) => !inRoots(it.path)), ...keepDates(found)];
    const text = indexText();
    lastIndex = text;
    emit();
    await configWrite(INDEX, text);
  } catch { /* the next tick tries again */ } finally {
    refreshing = false;
  }
}

/** The index file's text. Arrays, not objects: the keys would be most of a 20,000-row file. */
function indexText() {
  return JSON.stringify({ scannedAt, items: items.map((f) => (f.taken === undefined ? [f.path, f.size, f.mtime] : [f.path, f.size, f.mtime, f.taken])) });
}

/** A walk knows nothing of dates taken: carry each one over from the file it was read from, as
 *  long as the file has not changed since. */
function keepDates(found: Item[]): Item[] {
  const known = new Map(items.filter((it) => it.taken !== undefined).map((it) => [`${favKey(it.path)}|${it.mtime}`, it.taken!]));
  return found.map((f) => { const t = known.get(`${favKey(f.path)}|${f.mtime}`); return t === undefined ? f : { ...f, taken: t }; });
}

let enriching = false;
let stopEnrich = false;
/**
 * Read when each file was taken, from its own data, for every file not read yet: about 4 ms a
 * file, so the first time a minute or two in the background, and then only for new files. The
 * grid regroups as dates arrive. Runs while a gallery is open (it calls this); stops on dispose.
 */
export async function enrichDates(): Promise<void> {
  if (enriching || !loaded) return;
  enriching = true; stopEnrich = false;
  try {
    let sinceSave = 0;
    for (;;) {
      const todo = items.filter((it) => it.taken === undefined).slice(0, 200);
      if (!todo.length || stopEnrich) break;
      const meta = await mediaMeta(todo.map((it) => it.path));
      const got = new Map(todo.map((it, i) => [it.path, meta[i]?.taken ?? 0]));
      items = items.map((it) => (got.has(it.path) ? { ...it, taken: got.get(it.path)! } : it));
      emit();
      sinceSave += todo.length;
      // Written every few thousand rather than per batch: the index is a megabyte or two.
      if (sinceSave >= 3000) { sinceSave = 0; lastIndex = indexText(); await configWrite(INDEX, lastIndex); }
    }
    if (sinceSave) { lastIndex = indexText(); await configWrite(INDEX, lastIndex); }
  } catch { /* the next open carries on from what was saved */ } finally {
    enriching = false;
  }
}
export const datesLeft = () => items.reduce((n, it) => n + (it.taken === undefined ? 1 : 0), 0);

/** Content hashes this session, keyed by path, size and time, so an edited file is hashed again. */
const hashes = new Map<string, string | null>();
const hashKey = (it: Item) => `${favKey(it.path)}|${it.size}|${it.mtime}`;
let dup: { checking: boolean; done: number; total: number; groups: Item[][] | null } = { checking: false, done: 0, total: 0, groups: null };
export const dupState = () => dup;

/**
 * Find identical files among `among` (what the gallery shows: hidden folders are left out). Only
 * files sharing a size with another are hashed, a few at a time so progress shows.
 */
export async function findDuplicates(among: Item[]): Promise<void> {
  if (dup.checking) return;
  const candidates = sameSize(among);
  dup = { checking: true, done: 0, total: candidates.length, groups: null }; emit();
  try {
    for (let i = 0; i < candidates.length; i += 16) {
      const batch = candidates.slice(i, i + 16).filter((it) => !hashes.has(hashKey(it)));
      if (batch.length) {
        const hs = await fsHash(batch.map((it) => it.path));
        batch.forEach((it, k) => hashes.set(hashKey(it), hs[k] ?? null));
      }
      dup = { ...dup, done: Math.min(candidates.length, i + 16) }; emit();
    }
    dup = { ...dup, checking: false, groups: duplicateGroups(candidates, (it) => hashes.get(hashKey(it))) };
  } catch (e) {
    dup = { ...dup, checking: false, groups: [] };
    throw e;
  } finally { emit(); }
}
export function closeDuplicates() { dup = { checking: false, done: 0, total: 0, groups: null }; emit(); }

function save() {
  const text = JSON.stringify(settings);
  if (text === lastCfg) return;
  lastCfg = text;
  void configWrite(CFG, text);
}
function setSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch };
  favSet = new Set(settings.favourites.map(favKey));
  emit();
  save();
}

export const setFilter = (filter: Filter) => setSettings({ filter });
export const setTypes = (types: string[]) => setSettings({ types });
export const setSort = (sort: Sort) => setSettings({ sort });
/** Favourite (or not) several at once: a selection. */
export function setFavourite(paths: string[], on: boolean) {
  const keys = new Set(paths.map(favKey));
  const rest = settings.favourites.filter((f) => !keys.has(favKey(f)));
  setSettings({ favourites: on ? [...rest, ...paths] : rest });
}
export function toggleFavourite(path: string) {
  const k = favKey(path);
  setSettings({ favourites: favSet.has(k) ? settings.favourites.filter((f) => favKey(f) !== k) : [...settings.favourites, path] });
}
export const hideFolder = (folder: string) =>
  setSettings({ hidden: [...settings.hidden.filter((h) => !inFolder(h, folder)), folder] });
export const unhideFolder = (folder: string) => setSettings({ hidden: settings.hidden.filter((h) => h !== folder) });
export const setScanRules = (excludes: string[], minKb: number) => setSettings({ excludes, minKb });

/** Drop a file from the index without a rescan, after it was moved away or deleted. */
function forget(path: string, replacement?: Item) {
  const k = favKey(path);
  items = items.flatMap((it) => (favKey(it.path) === k ? (replacement ? [replacement] : []) : [it]));
  if (favSet.has(k)) {
    const favs = settings.favourites.filter((f) => favKey(f) !== k);
    setSettings({ favourites: replacement ? [...favs, replacement.path] : favs });
  } else emit();
}

/** To the Recycle Bin. */
export async function trash(path: string) {
  await fsTrash(path);
  forget(path);
}
/** Into `dir`; the index follows it there, favourite and all. */
export async function moveTo(item: Item, dir: string) {
  const dest = await fsMove(item.path, dir, "rename");
  forget(item.path, { ...item, path: dest });
}
/** A copy into `dir`, which shows up in the gallery after the next scan. */
export const copyTo = (item: Item, dir: string) => fsCopy(item.path, dir);

/** Nothing at module scope runs on a timer: the only thing to land is a pending save. */
export function dispose() { save(); stopEnrich = true; }
