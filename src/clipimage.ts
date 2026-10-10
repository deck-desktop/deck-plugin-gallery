// Copy a picture itself to the clipboard, for pasting into a chat or a document.
//
// The clipboard takes PNG, so a PNG goes as it is and anything else the webview can decode (JPEG,
// WebP, GIF's first frame, BMP, AVIF) is drawn once and re-encoded. HEIC and TIFF, which the
// webview cannot decode, go as Windows' largest thumbnail, the same image the viewer shows.
import { fsReadBytes, fsThumbnail } from "../shim/bridge.js";
import { ext, needsThumbView } from "./logic";

export async function copyImage(path: string): Promise<void> {
  let png: Blob;
  if (needsThumbView(path)) {
    png = new Blob([(await fsThumbnail(path, 1024)) as BlobPart], { type: "image/png" });
  } else {
    const bytes = new Blob([(await fsReadBytes(path)) as BlobPart]);
    if (ext(path) === "png") png = new Blob([bytes], { type: "image/png" });
    else {
      const bmp = await createImageBitmap(bytes);
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      canvas.getContext("2d")!.drawImage(bmp, 0, 0);
      bmp.close();
      png = await canvas.convertToBlob({ type: "image/png" });
    }
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
