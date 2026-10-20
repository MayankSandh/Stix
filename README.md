# Sticker Maker

A free, ad-free web app that turns any image into a WhatsApp sticker.

- **Crop:** free shape or locked square.
- **Touch up:** an eraser brush to remove background, a restore brush to fix mistakes, and undo/redo. Use two fingers to zoom and move.
- **Export:** 512×512 with a transparent background. Non-square crops get see-through padding, and the WebP is kept under WhatsApp's 100 KB limit.
- **Groups:** organise stickers into named groups (stored only in your browser).
- **Share menu:** once installed, it appears in Android's **Share** menu, so you can send an image straight from Chrome, Instagram, the gallery, etc.
- **Offline:** works offline after the first visit.

Plain HTML, CSS and JavaScript, with no dependencies and no build step.

## Run it on your computer

```sh
cd ~/StickerMaker
python3 -m http.server 8765
```

Open http://localhost:8765. You can paste images with Ctrl/Cmd+V or drag and drop them.

## Put it on your phone

The Share-menu and install features need HTTPS, so host it somewhere free.

**Vercel (free Hobby plan, for personal use)**
- With the CLI: `npx vercel --prod` from this folder. Log in with your personal account and accept the defaults. There's nothing to build; it's a static site.
- Or push this folder to a Git repo (GitHub, GitLab or Bitbucket) and import it at vercel.com/new.

**No-tools alternative:** drag this folder onto https://app.netlify.com/drop.

Then, on your Android phone:
1. Open the URL in **Chrome**.
2. Menu (⋮) → **Add to Home screen** / **Install app**.
3. The app now shows up as **Stickers** in the Share menu.

## Getting stickers into WhatsApp

Browsers can't add named sticker packs to WhatsApp; only native Android apps can. So:

1. Open a sticker → **Share to WhatsApp** → send it to a chat (e.g. “Message yourself”).
2. If it arrives as a sticker, tap it → **Add to Favorites**.
3. If it arrives as a photo instead, use **Save image to phone**, then in WhatsApp: sticker panel → **Create** → pick the saved image. It's already cropped, so WhatsApp's editor has nothing left to cut.

## Notes

- Stickers live in this browser's storage (IndexedDB) on this device. Clearing Chrome's site data for the app deletes them.
- Adding `?debug` to the URL exposes internals on `window.__sm` (used by tests).
- When you change files listed in `sw.js`, bump `CACHE` there so installed copies refresh their offline cache.

## Files

| File | Purpose |
|---|---|
| `index.html`, `css/style.css` | Screens and styling |
| `js/app.js` | Screen flow, groups, sharing, saving |
| `js/crop.js` | Crop box |
| `js/brush.js` | Eraser/restore brush, undo, pinch zoom |
| `js/image.js` | Loading, cropping, 512×512 fitting, WebP/PNG encoding |
| `js/db.js` | IndexedDB storage |
| `sw.js`, `manifest.webmanifest` | Offline support, install, Share-menu target |
