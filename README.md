# Gallery for Deck

Every photo and video on this PC's fixed drives, newest first and grouped by date. It opens as a
tab in the top bar, and can also fill a pane in Workspaces (a pane's menu, then **Gallery**).

Needs Deck 0.21.0 or newer, which added the native parts it uses: finding files across the
drives, Windows' own thumbnails, photo properties, content hashes and the Recycle Bin.

## Where the pictures come from

The first time it opens, the gallery walks every fixed drive (USB sticks and network shares are
left out) and keeps what it finds as an index on this machine. It walks again in the background
when the index is an hour old, or when you press **Rescan**. While it is on screen it also looks
at Pictures, Videos, Desktop, Downloads and OneDrive's Pictures and Desktop every 30 seconds, so a
new screenshot or download appears without a rescan.

Folders that hold images which are not pictures are skipped: Windows, Program Files, ProgramData,
AppData, `node_modules`, `.git`, build folders and the like, and files under 30 KB (icons and
sprites). Both lists are editable in Settings → Plugins → Gallery. Right-click any picture and
choose **Hide this folder** for anything else; hidden folders can be shown again from the same
settings.

## Browsing

- **Tabs**: All, Photos, Videos, Favourites and Albums. An album is a folder, with its newest
  picture as the cover.
- **Types**: tick any combination of the file types in the current tab.
- **Sort**: newest, oldest, largest or by name. Dates are when a photo was taken, read from the
  photo itself in the background, and the file's modified date when it carries none.
- **Search** by file or folder name.
- **Keyboard**: click a tile, then the arrow keys move between pictures, Enter opens one and Space
  selects it.

## The viewer

Arrow keys move between pictures and Esc closes. The wheel zooms toward the cursor, drag pans
when zoomed in, and a double-click zooms to 2x or back. Space runs a full-screen slideshow, F
favourites the picture, Del deletes it, and I opens the info panel: dimensions, date taken,
camera, video length and location, with a link to the map. Videos Deck cannot play (mkv, avi,
wmv) offer to open in the default app instead.

## Doing things with pictures

From a right-click or the viewer: favourite, open with the default app, show in Explorer, copy
the image itself or its path, copy or move to a folder, set as Deck's wallpaper, and delete to the
Recycle Bin.

Ctrl+click, Shift+click or the check on a tile selects several; Ctrl+A selects everything in view.
The bar that appears favourites, copies, moves or deletes them together.

**Duplicates** finds files with exactly the same contents. Only files of the same size are
compared, then by a hash of their contents. Every copy but the oldest in each set is selected,
ready to delete.

## Where things are kept

On this machine only, in Deck's own config: the settings and favourites in `plugin-gallery`, the
index in `plugin-gallery-index`. Plugin configs never sync, and these are paths on this PC's
disks.

```sh
node plugins/gallery/build.mjs
node plugins/gallery/gallery.check.mjs
```
