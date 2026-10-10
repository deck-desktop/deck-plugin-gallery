// Thumbnails from Windows (fsThumbnail), loaded only for tiles on screen.
//
// A queue rather than a request per tile: scrolling past a thousand tiles mounts and unmounts a
// thousand of them, and only the ones still mounted should cost anything. Newest requests go
// first, so the tiles you stopped on load before the ones you scrolled past. Finished thumbnails
// are blob URLs in a capped cache; the oldest is revoked when it fills, so memory stays bounded.
import { useEffect, useState } from "react";
import { fsThumbnail } from "../shim/bridge.js";

/** Pixels per side requested: a 160 px tile on a 1.5x display. */
export const THUMB_PX = 256;
const CACHE = 800;
const PARALLEL = 4;

/** path -> blob URL, or "" for a file Windows has no thumbnail for. Insertion order is age. */
const cache = new Map<string, string>();
const waiting = new Map<string, Set<(url: string) => void>>();
const queue: string[] = [];
let running = 0;

function store(path: string, url: string) {
  cache.set(path, url);
  if (cache.size > CACHE) {
    const [oldPath, oldUrl] = cache.entries().next().value!;
    cache.delete(oldPath);
    if (oldUrl) URL.revokeObjectURL(oldUrl);
  }
}

function pump() {
  while (running < PARALLEL && queue.length) {
    const path = queue.pop()!; // newest first
    if (!waiting.has(path)) continue; // every tile that wanted it has gone
    running++;
    fsThumbnail(path, THUMB_PX)
      .then((bytes: Uint8Array) => URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" })))
      .catch(() => "")
      .then((url: string) => {
        store(path, url);
        waiting.get(path)?.forEach((f) => f(url));
        waiting.delete(path);
        running--;
        pump();
      });
  }
}

/** The thumbnail's URL once loaded, "" when there is none, undefined while waiting. */
export function useThumb(path: string): string | undefined {
  const [url, setUrl] = useState<string | undefined>(() => cache.get(path));
  useEffect(() => {
    const hit = cache.get(path);
    if (hit !== undefined) { setUrl(hit); return; }
    setUrl(undefined);
    let subs = waiting.get(path);
    if (!subs) { subs = new Set(); waiting.set(path, subs); queue.push(path); }
    const done = (u: string) => setUrl(u);
    subs.add(done);
    pump();
    return () => {
      const s = waiting.get(path);
      s?.delete(done);
      if (s && s.size === 0) waiting.delete(path); // left in the queue, skipped by pump
    };
  }, [path]);
  return url;
}

/** Release every cached thumbnail: the plugin is being reloaded or switched off. */
export function clearThumbs() {
  for (const url of cache.values()) if (url) URL.revokeObjectURL(url);
  cache.clear();
  waiting.clear();
  queue.length = 0;
}
