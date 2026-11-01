// Gallery — every photo and video on this machine's fixed drives, newest first, grouped by date.
//
// A tab and a pane view, both the same component over one shared store (store.ts). The files come
// from Deck's fs_find, a walk of every fixed drive saved as an index and redone in the background
// when it is an hour old; thumbnails are the system's own (thumbs.ts). The grid draws only the rows on
// screen, so a disk with tens of thousands of pictures scrolls like a short one.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Star, Play, RefreshCw, X, ChevronLeft, ChevronRight, Trash2, FolderOpen, ExternalLink, Copy,
  FolderInput, EyeOff, Pause, Search, ChevronDown, Folder, ClipboardCopy, Check, Image as ImageIcon,
  Info, Wallpaper, Layers, MapPin,
} from "lucide-react";
import { convertFileSrc, fsList, fsOpen, fsReveal, fsThumbnail, isWindows, mediaMeta, openExternal, pickFolder, setWallpaper, type MediaMeta } from "../shim/bridge.js";

/** Where a deleted photo goes: the Recycle Bin on Windows, the desktop's Trash elsewhere. */
const BIN = () => (isWindows() ? "the Recycle Bin" : "the Trash");
import { getSettings as deckSettings, saveSettings as saveDeckSettings } from "../shim/settings.js";
import { chordFor, ConfirmDialog, ContextMenu, parseChord, Segmented, TextInput, Field, type ConfirmState, type MenuEntry } from "../shim/ui.js";
import { notice, failure } from "./notice";

/** The favourite star, in the amber tone (a light theme darkens it). */
const STAR = "rgb(var(--tone-amber-300))";
/** A toolbar button beside text: a secondary button the size of the toolbar's controls. */
const BAR_BTN = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-subtle bg-elev px-2.5 text-[12px] text-text-secondary transition-colors hover:border-strong hover:text-text-primary disabled:opacity-50";
/** A quiet text button inside a bar: Back, Clear, the selection's actions. */
const BAR_TEXT = "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-text-secondary transition-colors hover:bg-white/5 hover:text-text-primary";
/** An icon-only toolbar button. */
const ICON_BTN = "grid size-7 shrink-0 place-items-center rounded-lg text-text-muted transition-colors hover:bg-white/5 hover:text-text-primary"
import {
  albums, clickSelect, ext, fmtSize, folderOf, groupByDate, groupsByDate, kindOf, moveFocus, nameOf, needsThumbView, playsInline, rowRange,
  sortItems, toRows, typeCounts, visible, favKey, when, PHOTO_EXTS, VIDEO_EXTS,
  type Album, type Filter, type Item, type Sort,
} from "./logic";
import {
  copyTo, dispose as disposeStore, favourites, getItems, getSettings, getVersion, hideFolder, isLoaded, load,
  moveTo, refreshRecent, rescan, scanState, setFavourite, setFilter, setScanRules, setSort, setTypes, subscribe, toggleFavourite,
  trash, unhideFolder, enrichDates, datesLeft, findDuplicates, closeDuplicates, dupState,
} from "./store";
import { copyImage } from "./clipimage";
import { clearThumbs, useThumb } from "./thumbs";

const TILE = 160, GAP = 6, HEAD = 34, OVERSCAN = 600;

function useStore() {
  useSyncExternalStore(subscribe, getVersion);
  useEffect(() => { void load(); }, []);
}

function ago(t: number) {
  if (!t) return "never";
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

/** The actions a file offers, from a tile's right-click and the viewer's toolbar alike. */
function useActions(onRemoved?: (path: string) => void) {
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const run = (p: Promise<unknown>, done: string) =>
    p.then(() => notice(done)).catch((e: unknown) => failure(String(e)));
  const actions = {
    favourite: (it: Item) => toggleFavourite(it.path),
    reveal: (it: Item) => void fsReveal(it.path),
    copyPath: (it: Item) => run(navigator.clipboard.writeText(it.path), "Path copied"),
    copyImage: (it: Item) => run(copyImage(it.path), "Image copied"),
    // Deck copies the picture into its own folder, so the wallpaper outlives the original.
    wallpaper: (it: Item) => run(setWallpaper(it.path).then((stored: string) => saveDeckSettings({ ...deckSettings(), wallpaper: stored })), "Set as Deck's wallpaper"),
    open: (it: Item) => void fsOpen(it.path),
    copy: async (it: Item) => {
      const dir = await pickFolder(); if (!dir) return;
      run(copyTo(it, dir), `Copied to ${dir}`);
    },
    move: async (it: Item) => {
      const dir = await pickFolder(); if (!dir) return;
      run(moveTo(it, dir).then(() => onRemoved?.(it.path)), `Moved to ${dir}`);
    },
    trash: (it: Item) => setConfirm({
      title: `Delete ${nameOf(it.path)}?`,
      body: `It goes to ${BIN()}, where it can be restored.`,
      confirmLabel: "Delete",
      onConfirm: () => run(trash(it.path).then(() => onRemoved?.(it.path)), `Moved to ${BIN()}`),
    }),
    hide: (it: Item) => {
      hideFolder(folderOf(it.path));
      notice(`Hidden: ${folderOf(it.path)}. Unhide it in the plugin's settings.`);
    },
  };
  const dialog = <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />;
  return { actions, dialog };
}

function menuFor(it: Item, a: ReturnType<typeof useActions>["actions"]): MenuEntry[] {
  const fav = favourites().has(favKey(it.path));
  return [
    { label: fav ? "Remove from favourites" : "Add to favourites", icon: Star, onClick: () => a.favourite(it) },
    { label: "Open with default app", icon: ExternalLink, onClick: () => a.open(it) },
    { label: "Show in Explorer", icon: FolderOpen, onClick: () => a.reveal(it) },
    ...(kindOf(it.path) === "photo" ? [{ label: "Copy image", icon: ImageIcon, onClick: () => a.copyImage(it) }] : []),
    ...(canWallpaper(it) ? [{ label: "Set as Deck's wallpaper", icon: Wallpaper, onClick: () => a.wallpaper(it) }] : []),
    { label: "Copy path", subLabel: it.path, icon: ClipboardCopy, onClick: () => a.copyPath(it) },
    "sep",
    { label: "Copy to folder…", icon: Copy, onClick: () => void a.copy(it) },
    { label: "Move to folder…", icon: FolderInput, onClick: () => void a.move(it) },
    { label: "Hide this folder", subLabel: folderOf(it.path), icon: EyeOff, onClick: () => a.hide(it) },
    "sep",
    { label: "Delete", hint: "Del", icon: Trash2, danger: true, onClick: () => a.trash(it) },
  ];
}

/** A tile's click, with the keys held: the grid decides whether it selects or opens. */
type TileClick = (e: { ctrl: boolean; shift: boolean }) => void;

/** Deck's wallpaper shows the file as it is, so only what the webview can draw. */
const canWallpaper = (it: Item) => ["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(ext(it.path));

function Tile({ item, size, selected, selecting, focused, onClick, onMenu }: {
  item: Item; size: number; selected: boolean; selecting: boolean; focused: boolean;
  onClick: TileClick; onMenu: (e: React.MouseEvent) => void;
}) {
  const url = useThumb(item.path);
  const fav = favourites().has(favKey(item.path));
  return (
    <button onClick={(e) => onClick({ ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })} onContextMenu={onMenu}
      title={`${nameOf(item.path)}\n${folderOf(item.path)}`}
      className="group relative shrink-0 overflow-hidden rounded-md bg-card outline-none focus-visible:ring-2"
      style={{ width: size, height: size,
        boxShadow: selected ? "inset 0 0 0 3px var(--accent)" : undefined,
        outline: focused ? "2px solid var(--text-primary)" : undefined, outlineOffset: 2 }}>
      {/* The check: on hover it starts a selection; once selecting, it shows on every tile. */}
      <span role="checkbox" aria-checked={selected}
        onClick={(e) => { e.stopPropagation(); onClick({ ctrl: true, shift: e.shiftKey }); }}
        className={`absolute left-1 top-1 z-10 flex size-5 items-center justify-center rounded-full border transition ${selecting || selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
        style={{ background: selected ? "var(--accent)" : "rgba(0,0,0,0.45)", borderColor: selected ? "var(--accent)" : "rgba(255,255,255,0.8)" }}>
        {selected && <Check size={12} className="text-white" strokeWidth={3} />}
      </span>
      {url ? <img src={url} alt="" draggable={false} className="h-full w-full object-cover" />
        : <span className="flex h-full w-full items-center justify-center text-[10px] text-text-muted">
            {url === "" ? nameOf(item.path) : ""}
          </span>}
      {kindOf(item.path) === "video" && (
        <span className="absolute bottom-1 left-1 rounded p-0.5 text-white" style={{ background: "rgba(0,0,0,0.6)" }}><Play size={11} fill="currentColor" /></span>
      )}
      {fav && <span className="absolute right-1 top-1" style={{ color: STAR }}><Star size={13} fill="currentColor" /></span>}
    </button>
  );
}

/** Full size, one at a time: arrows to move, wheel to zoom, Space for a slideshow. */
function Viewer({ list, index, setIndex, onClose }: { list: Item[]; index: number; setIndex: (i: number) => void; onClose?: () => void }) {
  const it = list[index];
  const ref = useRef<HTMLDivElement>(null);
  // Zoom and pan of a photo. The pan is the image's offset from centre in screen pixels.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [big, setBig] = useState<string>("");
  const [info, setInfo] = useState(false);
  const { actions, dialog } = useActions();
  const kind = it ? kindOf(it.path) : null;
  const step = (d: number) => { if (list.length) setIndex((index + d + list.length) % list.length); };

  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, [index]);
  /** Zoom to `next` keeping the point under the cursor (offset `c` from the stage's centre) still. */
  const zoomAt = (next: number, c: { x: number; y: number }) => {
    const z = Math.min(8, Math.max(1, next));
    if (z === 1) { setZoom(1); setPan({ x: 0, y: 0 }); return; }
    setPan((p) => ({ x: c.x - (c.x - p.x) * (z / zoom), y: c.y - (c.y - p.y) * (z / zoom) }));
    setZoom(z);
  };
  const fromCentre = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
  };
  // HEIC and TIFF: WebView2 cannot draw them, so a large shell thumbnail stands in.
  useEffect(() => {
    if (!it || !needsThumbView(it.path)) { setBig(""); return; }
    let url = "", live = true;
    fsThumbnail(it.path, 1024).then((b: Uint8Array) => {
      if (!live) return;
      url = URL.createObjectURL(new Blob([b as BlobPart], { type: "image/png" }));
      setBig(url);
    }).catch(() => {});
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [it?.path]);
  // Slideshow: a photo stays four seconds; a video plays to its end (its onEnded advances).
  // A video Deck cannot play also stays four seconds rather than stopping the show.
  const timed = kind === "photo" || !playsInline(it?.path ?? "");
  useEffect(() => {
    if (!playing || !timed) return;
    const t = setTimeout(() => step(1), 4000);
    return () => clearTimeout(t);
    // Re-armed per item, not per render: a favourite or a finished scan re-renders the viewer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, timed, index]);
  // The viewer's own document, the one its fullscreen is in: Deck's main window's, or a floating
  // window's, which the main page's exitFullscreen does not leave.
  useEffect(() => {
    const doc = ref.current?.ownerDocument ?? document;
    if (playing) void ref.current?.requestFullscreen?.().catch(() => {});
    else if (doc.fullscreenElement) void doc.exitFullscreen().catch(() => {});
  }, [playing]);
  useEffect(() => {
    const doc = ref.current?.ownerDocument ?? document;
    return () => { if (doc.fullscreenElement) void doc.exitFullscreen().catch(() => {}); };
  }, []);
  useEffect(() => { if (!it) onClose?.(); });
  if (!it) return null;

  const onKey = (e: React.KeyboardEvent) => {
    // Trash, favourite and info follow their keys in Settings > Keybindings (declared below).
    const chord = parseChord(e.nativeEvent);
    if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "Escape") { if (playing) setPlaying(false); else if (onClose) onClose(); else return; }
    else if (e.key === " ") setPlaying((p) => !p);
    else if (chord === chordFor("plugin:gallery:trash")) actions.trash(it);
    else if (chord === chordFor("plugin:gallery:favourite")) actions.favourite(it);
    else if (chord === chordFor("plugin:gallery:info")) setInfo((v) => !v);
    else return;
    e.preventDefault();
  };
  const fav = favourites().has(favKey(it.path));
  const btn = ICON_BTN;
  /** Round arrows floating over the picture, on the card surface so they read on any image. */
  const float = "absolute grid place-items-center rounded-full border border-subtle p-2 text-text-secondary shadow-xl transition-colors hover:text-text-primary";
  const src = convertFileSrc(it.path);

  return (
    <div ref={ref} tabIndex={-1} onKeyDown={onKey} className="absolute inset-0 z-20 flex flex-col outline-none"
      // Inline, not a Tailwind class: a class only this plugin uses is not generated until the dev
      // server restarts, and the viewer was see-through.
      style={{ background: "var(--bg-app)" }}>
      {!playing && (
        <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-subtle px-2 text-[12px] text-text-secondary" style={{ background: "var(--bg-panel)" }}>
          <span className="min-w-0 truncate pl-1 font-medium text-text-primary" title={it.path}>{nameOf(it.path)}</span>
          <span className="ml-1.5 shrink-0 text-[11.5px] text-text-muted">{new Date(when(it)).toLocaleString()} · {fmtSize(it.size)} · {index + 1} / {list.length}</span>
          <span className="flex-1" />
          <button className={btn} title="Favourite (F)" onClick={() => actions.favourite(it)}>
            <Star size={15} fill={fav ? "currentColor" : "none"} style={fav ? { color: STAR } : undefined} />
          </button>
          <button className={btn} title="Slideshow (Space)" onClick={() => setPlaying(true)}><Play size={15} /></button>
          <button className={btn} title="Open with default app" onClick={() => actions.open(it)}><ExternalLink size={15} /></button>
          <button className={btn} title="Show in Explorer" onClick={() => actions.reveal(it)}><FolderOpen size={15} /></button>
          {kind === "photo" && <button className={btn} title="Copy image" onClick={() => actions.copyImage(it)}><ImageIcon size={15} /></button>}
          <button className={btn} title="Copy path" onClick={() => actions.copyPath(it)}><ClipboardCopy size={15} /></button>
          <button className={btn} title="Copy to folder…" onClick={() => void actions.copy(it)}><Copy size={15} /></button>
          <button className={btn} title="Move to folder…" onClick={() => void actions.move(it)}><FolderInput size={15} /></button>
          <button className={btn + " hover:!text-red-400"} title="Delete (Del)" onClick={() => actions.trash(it)}><Trash2 size={15} /></button>
          {canWallpaper(it) && <button className={btn} title="Set as Deck's wallpaper" onClick={() => actions.wallpaper(it)}><Wallpaper size={15} /></button>}
          <button className={btn + (info ? " !text-text-primary" : "")} title="Info (I)" onClick={() => setInfo((v) => !v)} aria-pressed={info}
            style={info ? { background: "var(--accent-soft)" } : undefined}>
            <Info size={15} />
          </button>
          {onClose && <>
            <i aria-hidden className="mx-1 h-3.5 w-px bg-white/10" />
            <button className={btn} title="Close (Esc)" onClick={onClose}><X size={16} /></button>
          </>}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        onWheel={(e) => { if (kind === "photo") zoomAt(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), fromCentre(e)); }}
        // Zoomed in, a drag pans; a double-click zooms to 2x where clicked, or back out.
        onDoubleClick={(e) => { if (kind === "photo") zoomAt(zoom > 1 ? 1 : 2, fromCentre(e)); }}
        onPointerDown={(e) => {
          if (kind !== "photo" || zoom === 1 || e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
          drag.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
          setDragging(true);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => { const d = drag.current; if (d) setPan({ x: e.clientX - d.x, y: e.clientY - d.y }); }}
        onPointerUp={() => { drag.current = null; setDragging(false); }}
        style={{ cursor: kind === "photo" && zoom > 1 ? (dragging ? "grabbing" : "grab") : undefined }}>
        {kind === "video" && !playsInline(it.path)
          ? <div className="flex flex-col items-center gap-3 text-center text-[12.5px] text-text-muted">
              Deck cannot play this kind of video.
              <button onClick={() => actions.open(it)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium text-white transition hover:brightness-110" style={{ background: "var(--accent)" }}>
                <ExternalLink size={13} /> Open with the default app
              </button>
            </div>
          : kind === "video"
          ? <video key={it.path} src={src} controls autoPlay className="max-h-full max-w-full" onEnded={() => playing && step(1)} />
          : <img key={it.path} src={needsThumbView(it.path) ? big : src} alt="" draggable={false}
              className={`max-h-full max-w-full select-none object-contain ${dragging ? "" : "transition-transform duration-75"}`}
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }} />}
        <button className={float + " left-2 top-1/2 -translate-y-1/2"} style={{ background: "var(--bg-card)" }} onClick={() => step(-1)}><ChevronLeft size={20} /></button>
        <button className={float + " right-2 top-1/2 -translate-y-1/2"} style={{ background: "var(--bg-card)" }} onClick={() => step(1)}><ChevronRight size={20} /></button>
        {playing && (
          <button className={float + " bottom-4 right-4"} style={{ background: "var(--bg-card)" }} title="Stop (Space)" onClick={() => setPlaying(false)}>
            <Pause size={18} />
          </button>
        )}
      </div>
      {info && !playing && <InfoPanel it={it} />}
      {dialog}
    </div>
  );
}

/** The viewer's side panel: what the system knows about the file, read when it is shown. */
function InfoPanel({ it }: { it: Item }) {
  const [m, setM] = useState<MediaMeta | null>(null);
  useEffect(() => {
    let live = true; setM(null);
    mediaMeta([it.path]).then((r: MediaMeta[]) => { if (live) setM(r[0] ?? null); }).catch(() => {});
    return () => { live = false; };
  }, [it.path]);
  const date = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const dur = (ms: number) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const rows: [string, React.ReactNode][] = [
    ["Name", nameOf(it.path)],
    ["Folder", <button key="f" className="text-left underline-offset-2 hover:underline" onClick={() => void fsReveal(it.path)}>{folderOf(it.path)}</button>],
    ["Size", fmtSize(it.size)],
    ...(m?.width && m.height ? [["Dimensions", `${m.width} × ${m.height}`] as [string, string]] : []),
    ...(m?.taken ? [["Taken", date(m.taken)] as [string, string]] : []),
    ["Modified", date(it.mtime)],
    ...(m?.duration_ms ? [["Length", dur(m.duration_ms)] as [string, string]] : []),
    ...(m?.camera ? [["Camera", m.camera] as [string, string]] : []),
    ...(m?.lat != null && m.lon != null ? [["Location", (
      <button key="l" className="inline-flex items-center gap-1 text-left underline-offset-2 hover:underline"
        onClick={() => void openExternal(`https://www.google.com/maps?q=${m.lat},${m.lon}`)}>
        <MapPin size={12} /> {m.lat.toFixed(5)}, {m.lon.toFixed(5)}
      </button>
    )] as [string, React.ReactNode]] : []),
  ];
  return (
    <div className="scroll-thin absolute bottom-0 right-0 top-10 z-10 w-72 overflow-y-auto border-l border-subtle px-3.5 py-3 text-[12px]"
      style={{ background: "var(--bg-panel)" }}>
      {rows.map(([k, v]) => (
        <div key={k} className="mb-2.5">
          <div className="text-[11px] text-text-muted">{k}</div>
          <div className="break-all text-text-primary">{v}</div>
        </div>
      ))}
      {!m && <div className="text-text-muted">Reading…</div>}
    </div>
  );
}

/**
 * A checkbox list of the types in this tab, with counts. None ticked shows every type. `chosen`
 * is what applies here; `stored` is every type ticked, including ones this tab has none of, which
 * a change here keeps.
 */
function TypesMenu({ counts, chosen, stored }: { counts: [string, number][]; chosen: string[]; stored: string[] }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const set = new Set(chosen);
  const toggle = (ext: string) => setTypes(set.has(ext) ? stored.filter((x) => x !== ext) : [...stored, ext]);
  const label = !chosen.length ? "All types" : chosen.length <= 2 ? chosen.map((x) => x.toUpperCase()).join(", ") : `${chosen.length} types`;
  // Ticked rows keep the menu open, so several types can be picked in one visit.
  const items: MenuEntry[] = [
    ...counts.map(([ext, n]): MenuEntry => ({ label: ext.toUpperCase(), hint: n.toLocaleString(), checked: set.has(ext), onClick: () => toggle(ext) })),
    ...(chosen.length > 0 ? ["sep" as const, { label: "Show all types", onClick: () => setTypes(stored.filter((x) => !set.has(x))) }] : []),
  ];
  return (
    <>
      {/* A filter that is on carries the accent's ring, as Deck's toggles do. */}
      <button aria-haspopup="menu" aria-expanded={!!at}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt((o) => (o ? null : { x: r.left, y: r.bottom + 4 })); }}
        className={BAR_BTN + (chosen.length ? " !text-text-primary" : "")}
        style={chosen.length ? { background: "var(--accent-soft)", boxShadow: "inset 0 0 0 1px var(--accent)" } : undefined}>
        {label} <ChevronDown size={12} />
      </button>
      {at && <ContextMenu x={at.x} y={at.y} items={items} onClose={() => setAt(null)} />}
    </>
  );
}

/** An album card: the folder's newest picture, its name and count. */
function AlbumCard({ album, size, onOpen }: { album: Album; size: number; onOpen: () => void }) {
  const url = useThumb(album.cover.path);
  return (
    <button onClick={onOpen} title={album.folder} className="group relative shrink-0 overflow-hidden rounded-md bg-card text-left"
      style={{ width: size, height: size }}>
      {url && <img src={url} alt="" draggable={false} className="h-full w-full object-cover" />}
      <span className="absolute inset-x-0 bottom-0 px-2 pb-1.5 pt-6 text-white"
        style={{ background: "linear-gradient(transparent, rgba(0,0,0,0.75))" }}>
        <span className="block truncate text-[12px] font-semibold">{nameOf(album.folder) || album.folder}</span>
        <span className="block text-[11px] opacity-80">{album.count.toLocaleString()}</span>
      </span>
    </button>
  );
}

function Gallery() {
  useStore();
  const s = getSettings();
  const { scanning, scannedAt, error } = scanState();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; item: Item } | null>(null);
  /** The open album's folder, inside the Albums tab. */
  const [album, setAlbum] = useState<string | null>(null);
  /** Selected paths, and where the last click was (a Shift+click selects from there). */
  const [sel, setSel] = useState<{ paths: Set<string>; anchor: string | null }>({ paths: new Set(), anchor: null });
  const clearSel = () => setSel({ paths: new Set(), anchor: null });

  // New screenshots and downloads appear without a rescan: the folders they land in are looked at
  // again every 30 s while the gallery is on screen, and at once when the window comes back.
  // Not while hidden (rule 11): nobody would see the result.
  useEffect(() => {
    const tick = () => { if (!document.hidden) void refreshRecent(); };
    // Dates taken are read once per file, in the background; the grid regroups as they arrive.
    void load().then(() => { tick(); void enrichDates(); });
    const id = setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, []);
  const { actions, dialog } = useActions();
  const [bulkConfirm, setBulkConfirm] = useState<ConfirmState | null>(null);
  /** The tile the arrow keys move; Enter opens it, Space selects it. */
  const [focus, setFocus] = useState<string | null>(null);
  const dups = dupState();
  const inDups = dups.checking || dups.groups !== null;

  const version = getVersion();
  const inAlbums = s.filter === "albums";
  const view = { filter: (inAlbums ? "all" : s.filter) as Filter, hidden: s.hidden, folder: inAlbums && album ? album : undefined };
  // The type list follows the tab: what this tab (or the open album) holds, before the type filter
  // and the search. Photos lists no MP4.
  const counts = useMemo(() => typeCounts(visible(getItems(), { ...view, query: "", favourites: favourites() })),
    // version stands for the items and favourites, which change in place in the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, s.filter, s.hidden, album]);
  // A ticked type this tab has none of is left out here rather than emptying the view; it applies
  // again on a tab that has it.
  const chosen = useMemo(() => s.types.filter((t) => counts.some(([e]) => e === t)), [s.types, counts]);
  const types = useMemo(() => new Set(chosen), [chosen]);
  const shown = useMemo(() => sortItems(visible(getItems(), { ...view, query, favourites: favourites(), types }), s.sort),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, s.filter, query, s.hidden, types, album, s.sort]);
  // In the duplicates view, the groups, minus anything since deleted or moved, and only while a
  // group still has a copy to spare.
  const dupGroups = useMemo(() => {
    if (!dups.groups) return [];
    const on = new Set(getItems().map((it) => it.path));
    return dups.groups.map((g) => g.filter((it) => on.has(it.path))).filter((g) => g.length > 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dups.groups, version]);
  const list = inDups ? dupGroups.flat() : shown;
  // When the check finishes, every copy but the oldest in each group is selected, ready for Delete.
  useEffect(() => {
    if (dups.groups) setSel({ paths: new Set(dups.groups.flatMap((g) => g.slice(1).map((it) => it.path))), anchor: null });
  }, [dups.groups]);
  // The selection is only what is still on screen: a file moved away or filtered out drops out.
  const order = useMemo(() => list.map((it) => it.path), [list]);
  const selected = useMemo(() => { const on = new Set(order); return [...sel.paths].filter((x) => on.has(x)); }, [sel.paths, order]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selItems = useMemo(() => list.filter((it) => selectedSet.has(it.path)), [list, selectedSet]);
  const onTile = (it: Item): TileClick => (mods) => {
    const r = clickSelect(order, selectedSet, sel.anchor, it.path, mods);
    setFocus(it.path);
    if (r) setSel({ paths: r.selected, anchor: r.anchor });
    else setOpen(indexOf.get(it.path) ?? null);
  };
  /** Run one action over the selection, one file at a time, and say how it went. */
  const bulk = async (what: string, each: (it: Item) => Promise<unknown>, clear = true) => {
    let failed = 0;
    for (const it of selItems) { try { await each(it); } catch { failed++; } }
    if (failed) failure(`${what}: ${selItems.length - failed} done, ${failed} failed`);
    else notice(`${what}: ${selItems.length} done`);
    if (clear) clearSel();
  };
  const allFav = selItems.length > 0 && selItems.every((it) => favourites().has(favKey(it.path)));
  // The Albums tab's cards, when no album is open.
  const folders = useMemo(() => (inAlbums && !album ? albums(list) : []), [inAlbums, album, list]);
  const indexOf = useMemo(() => new Map(list.map((it, i) => [it.path, i])), [list]);
  // A new tab, album or search starts with nothing selected.
  useEffect(() => { clearSel(); }, [s.filter, album, query]);

  // The grid's size decides the columns; the scroll position decides which rows exist.
  const scroller = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [top, setTop] = useState(0);
  // Keyed on loading: the first render shows "Loading…" and has no grid to measure, so the
  // observer attaches once the grid exists. Without it every tile was 0 px wide.
  const ready = isLoaded();
  useEffect(() => {
    const el = scroller.current; if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);
  const width = Math.max(0, box.w - 24);
  const cols = Math.max(1, Math.floor((width + GAP) / (TILE + GAP)));
  const tile = Math.floor((width - GAP * (cols - 1)) / cols);
  // Albums are rows of cards with no date headings: one unlabelled section, its heading dropped.
  const showAlbums = inAlbums && !album;
  const rows = useMemo(() => (inDups
    ? toRows(dupGroups.map((g) => ({ label: `${g.length} copies · ${fmtSize(g[0].size)} each`, items: g })), cols)
    : showAlbums
    ? toRows([{ label: "", items: folders.map((a) => a.cover) }], cols).slice(1)
    : groupsByDate(s.sort) ? toRows(groupByDate(list, Date.now()), cols)
    : toRows([{ label: "", items: list }], cols).slice(1)), [inDups, dupGroups, showAlbums, folders, list, cols, s.sort]);
  const albumOf = useMemo(() => new Map(folders.map((a) => [a.cover.path, a])), [folders]);
  const tops = useMemo(() => {
    const t = [0];
    for (const r of rows) t.push(t[t.length - 1] + (r.kind === "head" ? HEAD : tile + GAP));
    return t;
  }, [rows, tile]);
  const [from, to] = rowRange(tops, top - OVERSCAN, top + box.h + OVERSCAN);
  /** Scroll so the tile for `path` is fully on screen. */
  const reveal = (path: string) => {
    const i = rows.findIndex((r) => r.kind === "tiles" && r.items.some((it) => it.path === path));
    const el = scroller.current; if (i < 0 || !el) return;
    const y = tops[i], h = tops[i + 1] - tops[i];
    if (y < el.scrollTop) el.scrollTop = Math.max(0, y - HEAD);
    else if (y + h > el.scrollTop + el.clientHeight) el.scrollTop = y + h - el.clientHeight;
  };
  const waste = dupGroups.reduce((n, g) => n + g[0].size * (g.length - 1), 0);

  if (!isLoaded()) return <div className="p-4 text-[12px] text-text-muted">Loading…</div>;
  const empty = !getItems().length;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-app"
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).closest("input, textarea") || open !== null || showAlbums) return;
        const arrow = ({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" } as const)[e.key as "ArrowLeft"];
        if (arrow) {
          e.preventDefault();
          const next = moveFocus(rows, focus && indexOf.has(focus) ? focus : null, arrow);
          if (next) { setFocus(next); reveal(next); }
        }
        else if (e.key === "Enter" && focus && indexOf.has(focus)) { e.preventDefault(); setOpen(indexOf.get(focus)!); }
        else if (e.key === " " && focus && indexOf.has(focus)) {
          e.preventDefault();
          const r = clickSelect(order, selectedSet, sel.anchor, focus, { ctrl: true, shift: e.shiftKey });
          if (r) setSel({ paths: r.selected, anchor: r.anchor });
        }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); setSel({ paths: new Set(order), anchor: null }); }
        else if (e.key === "Escape" && selected.length) { e.preventDefault(); clearSel(); }
      }}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-subtle px-3 py-2">
        <Segmented<Filter> value={s.filter} onChange={(f) => { setAlbum(null); setFilter(f); }} layoutId="gallery-filter" options={[
          { value: "all", label: "All" }, { value: "photos", label: "Photos" },
          { value: "videos", label: "Videos" }, { value: "favourites", label: "Favourites" },
          { value: "albums", label: "Albums" },
        ]} />
        <TypesMenu counts={counts} chosen={chosen} stored={s.types} />
        {!showAlbums && (
          <select value={s.sort} onChange={(e) => setSort(e.target.value as Sort)} title="Sort"
            className="h-8 cursor-pointer rounded-lg border border-subtle bg-elev px-2 text-[12px] text-text-secondary outline-none transition-colors hover:border-strong hover:text-text-primary focus:border-[var(--accent)]">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="largest">Largest first</option>
            <option value="name">By name</option>
          </select>
        )}
        <label className="flex h-8 w-56 items-center gap-2 rounded-lg border border-subtle bg-elev px-2.5 transition-colors focus-within:border-[var(--accent)]">
          <Search size={13} className="shrink-0 text-text-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false}
            placeholder="Filter by file or folder name" className="min-w-0 flex-1 bg-transparent text-[12.5px] text-text-primary outline-none placeholder:text-text-muted" />
        </label>
        <span className="flex-1" />
        <span className="text-[11px] text-text-muted" title={error || undefined} style={error ? { color: "rgb(var(--tone-red-400))" } : undefined}>
          {error ? "Scan failed" : `${showAlbums ? `${folders.length.toLocaleString()} albums` : `${list.length.toLocaleString()} shown`} · scanned ${ago(scannedAt)}`}
          {datesLeft() > 0 && ` · reading dates, ${datesLeft().toLocaleString()} left`}
        </span>
        <button onClick={() => void findDuplicates(visible(getItems(), { filter: "all", query: "", hidden: s.hidden, favourites: favourites() }))
            .catch((e: unknown) => failure(String(e)))}
          disabled={inDups} title="Find files that are exact copies of each other"
          className={BAR_BTN}>
          <Layers size={12} /> Duplicates
        </button>
        <button onClick={() => void rescan()} disabled={scanning} title="Walk every fixed drive again"
          className={BAR_BTN}>
          <RefreshCw size={12} className={scanning ? "animate-spin" : ""} /> {scanning ? "Scanning…" : "Rescan"}
        </button>
      </div>

      {inDups && (
        <div className="flex shrink-0 items-center gap-2 border-b border-subtle px-3 py-1.5 text-[12px]">
          <button onClick={() => { closeDuplicates(); clearSel(); }} className={BAR_TEXT}>
            <ChevronLeft size={14} /> Back
          </button>
          <Layers size={13} className="text-text-muted" />
          <span className="text-text-primary">
            {dups.checking ? `Comparing ${dups.done.toLocaleString()} of ${dups.total.toLocaleString()} files with the same size…`
              : dupGroups.length ? `${dupGroups.length.toLocaleString()} sets of copies · ${fmtSize(waste)} to free. The oldest of each set is kept; the rest are selected.`
              : "No duplicates found."}
          </span>
        </div>
      )}
      {selected.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-subtle px-3 py-1.5 text-[12px]" style={{ background: "var(--accent-soft)" }}>
          <span className="mr-2 font-semibold text-text-primary">{selected.length.toLocaleString()} selected</span>
          {[
            { label: allFav ? "Unfavourite" : "Favourite", icon: Star, run: () => { setFavourite(selected, !allFav); } },
            { label: "Copy to…", icon: Copy, run: async () => { const dir = await pickFolder(); if (dir) void bulk("Copied", (it) => copyTo(it, dir), false); } },
            { label: "Move to…", icon: FolderInput, run: async () => { const dir = await pickFolder(); if (dir) void bulk("Moved", (it) => moveTo(it, dir)); } },
            { label: "Delete", icon: Trash2, danger: true, run: () => setBulkConfirm({
              title: `Delete ${selected.length.toLocaleString()} items?`,
              body: `They go to ${BIN()}, where they can be restored.`,
              confirmLabel: "Delete",
              onConfirm: () => void bulk(`Moved to ${BIN()}`, (it) => trash(it.path)),
            }) },
          ].map((b) => (
            <button key={b.label} onClick={() => void b.run()}
              className={BAR_TEXT + " px-2" + ("danger" in b ? " hover:!text-red-400" : "")}>
              <b.icon size={13} /> {b.label}
            </button>
          ))}
          <span className="flex-1" />
          {selected.length < order.length && (
            <button onClick={() => setSel({ paths: new Set(order), anchor: null })} className={BAR_TEXT + " px-2"}>
              Select all {order.length.toLocaleString()}
            </button>
          )}
          <button onClick={clearSel} title="Esc" className={BAR_TEXT + " px-2"}>Clear</button>
        </div>
      )}
      {inAlbums && album && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-subtle px-3 py-1.5 text-[12px]">
          <button onClick={() => setAlbum(null)} className={BAR_TEXT}>
            <ChevronLeft size={14} /> Albums
          </button>
          <Folder size={13} className="text-text-muted" />
          <span className="font-medium text-text-primary">{nameOf(album) || album}</span>
          <span className="min-w-0 truncate text-text-muted" title={album}>{album}</span>
          <button onClick={() => void fsReveal(album)} title="Show in Explorer" className="ml-auto grid size-6 shrink-0 place-items-center rounded-md text-text-muted transition-colors hover:bg-white/5 hover:text-text-primary">
            <FolderOpen size={13} />
          </button>
        </div>
      )}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3" onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
        {empty ? (
          <div className="mx-auto mt-16 flex max-w-[460px] items-start gap-2.5 rounded-lg border border-subtle bg-elev px-3 py-3 text-[12px] leading-relaxed text-text-muted">
            {scanning ? <RefreshCw size={16} className="mt-0.5 shrink-0 animate-spin" /> : <ImageIcon size={16} className="mt-0.5 shrink-0" />}
            <div className="flex flex-col items-start gap-2.5">
              <span>{scanning ? "Looking for photos and videos on every fixed drive… this takes up to a minute the first time."
                : "No photos or videos found. Check the skipped folders in the plugin's settings, then rescan."}</span>
              {!scanning && (
                <button onClick={() => void rescan()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium text-white transition hover:brightness-110" style={{ background: "var(--accent)" }}>
                  <RefreshCw size={13} /> Rescan
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="relative" style={{ height: tops[tops.length - 1] }}>
            {rows.slice(from, to).map((r, k) => {
              const i = from + k;
              return r.kind === "head" ? (
                <div key={`h${i}`} className="absolute left-0 right-0 flex items-end gap-1.5 pb-1.5 text-[12px] font-medium text-text-secondary"
                  style={{ top: tops[i], height: HEAD }}>
                  {r.label}
                  <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10.5px] font-normal text-text-secondary" style={{ background: "var(--bg-elev)" }}>{r.count.toLocaleString()}</span>
                </div>
              ) : (
                <div key={`r${i}`} className="absolute left-0 flex" style={{ top: tops[i], gap: GAP }}>
                  {r.items.map((it) => showAlbums ? (
                    <AlbumCard key={it.path} album={albumOf.get(it.path)!} size={tile}
                      onOpen={() => { setAlbum(albumOf.get(it.path)!.folder); setTop(0); scroller.current?.scrollTo(0, 0); }} />
                  ) : (
                    <Tile key={it.path} item={it} size={tile} selected={selectedSet.has(it.path)} selecting={selected.length > 0} focused={focus === it.path}
                      onClick={onTile(it)}
                      onMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, item: it }); }} />
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {open !== null && <Viewer list={list} index={Math.min(open, list.length - 1)} setIndex={setOpen} onClose={() => setOpen(null)} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuFor(menu.item, actions)} onClose={() => setMenu(null)} />}
      {dialog}
      <ConfirmDialog state={bulkConfirm} onClose={() => setBulkConfirm(null)} />
    </div>
  );
}

/**
 * A photo or video opened in Gallery from anywhere in Deck (Files, the Editor's file tree, a link in
 * a terminal): the viewer on it, its arrows going through the other photos and videos in its
 * folder, by name. Its tab is closed as any tab is, so the viewer has no close button of its own.
 */
function FileView({ file }: { file: string }) {
  const [list, setList] = useState<Item[]>([{ path: file, size: 0, mtime: 0 }]);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const dir = file.slice(0, Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/")));
    let live = true;
    fsList(dir, false).then((entries: { name: string; path: string; dir: boolean; size: number; mtimeMs: number }[]) => {
      if (!live) return;
      const items = entries.filter((e) => !e.dir && OPENS.includes(`.${ext(e.path)}`))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .map((e) => ({ path: e.path, size: e.size, mtime: e.mtimeMs }));
      const i = items.findIndex((x) => x.path.toLowerCase() === file.toLowerCase());
      if (i >= 0) { setList(items); setIndex(i); }
    }).catch((e: unknown) => console.warn("[gallery] the folder could not be listed", e));
    return () => { live = false; };
  }, [file]);
  return <div className="relative h-full w-full"><Viewer list={list} index={index} setIndex={setIndex} /></div>;
}

/** What Deck opens in Gallery: photos (HEIC and TIFF through the system's thumbnail) and the videos it plays. */
const OPENS = [...PHOTO_EXTS, ...VIDEO_EXTS.filter((e) => playsInline(`x.${e}`))].map((e) => `.${e}`);
export const opens = OPENS;

export default Gallery;
export function PaneView({ file }: { file?: string }) {
  return file ? <FileView file={file} /> : <Gallery />;
}

// The photo viewer's keys. Defaults only; a rebinding in Settings > Keybindings wins.
export const keybindings = () => [
  { id: "trash", title: "Delete the photo (to the Recycle Bin or Trash)", defaultChord: "delete" },
  { id: "favourite", title: "Favourite the photo", defaultChord: "f" },
  { id: "info", title: "Show the photo's details", defaultChord: "i" },
];

/** What a scan skips, and the folders hidden from view. Settings > Plugins > Gallery. */
export function Settings() {
  useStore();
  const s = getSettings();
  const [excludes, setExcludes] = useState(s.excludes.join("\n"));
  const [minKb, setMinKb] = useState(String(s.minKb));
  const dirty = excludes !== s.excludes.join("\n") || minKb !== String(s.minKb);
  const apply = () => {
    setScanRules(excludes.split(/\r?\n/).map((x) => x.trim()).filter(Boolean), Math.max(0, Number(minKb) || 0));
    void rescan();
  };
  return (
    <div className="space-y-3 text-[12px]">
      <Field label="Skipped folders" hint="One name per line. A folder with this name is skipped at any depth.">
        <textarea value={excludes} onChange={(e) => setExcludes(e.target.value)} rows={8} spellCheck={false}
          className="w-full max-w-xl rounded-lg border border-subtle bg-elev px-2.5 py-2 font-mono text-[12px] text-text-primary outline-none transition-colors focus:border-[var(--accent)]" />
      </Field>
      <Field label="Smallest file (KB)" hint="Smaller files are icons and sprites rather than pictures.">
        <TextInput value={minKb} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMinKb(e.target.value)} className="w-24" />
      </Field>
      <button disabled={!dirty} onClick={apply}
        className="inline-flex h-8 items-center rounded-lg px-3 text-[12.5px] font-medium text-white transition hover:brightness-110 disabled:opacity-50" style={{ background: "var(--accent)" }}>
        Save and rescan
      </button>
      <div className="max-w-xl">
        <div className="mb-1 text-[12px] font-medium text-text-secondary">Hidden folders</div>
        {s.hidden.length === 0 ? <div className="text-text-muted">None. Right-click a picture and choose “Hide this folder”.</div>
          : s.hidden.map((h) => (
            <div key={h} className="group flex h-6 items-center gap-2 rounded-md px-2 transition-colors hover:bg-white/5">
              <EyeOff size={13} className="shrink-0 text-text-muted" />
              <span className="min-w-0 flex-1 truncate text-text-secondary" title={h}>{h}</span>
              <button onClick={() => unhideFolder(h)}
                className="shrink-0 rounded px-1.5 text-[11.5px] text-text-muted opacity-0 transition-colors hover:bg-white/10 hover:text-text-primary focus:opacity-100 group-hover:opacity-100">Unhide</button>
            </div>
          ))}
      </div>
    </div>
  );
}

export function dispose() {
  disposeStore();
  clearThumbs();
}
