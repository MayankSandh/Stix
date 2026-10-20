# Sticker Maker

A free, ad-free Android app that turns any image into WhatsApp stickers and adds them to WhatsApp as real sticker packs.

- **Share menu:** share an image from Chrome, Instagram, Gallery… to **Sticker Maker**, or pick one in the app.
- **Crop:** free shape or locked square.
- **Touch up:** an eraser brush removes background, a restore brush fixes mistakes, and there's undo/redo. Use two fingers to zoom and move.
- **Export:** saved as 512×512 WebP with a transparent background, under 100 KB. Non-square crops get see-through padding.
- **Groups = WhatsApp sticker packs:** once a group has 3+ stickers, tap **Add to WhatsApp**. Stickers you add later sync to WhatsApp automatically.

## How it works

| Part | What it does |
|---|---|
| `app/src/main/assets/web/` | The editor UI (HTML/CSS/JS) shown inside the app |
| `MainActivity.kt` | Hosts the editor, receives shared images, opens WhatsApp |
| `NativeBridge.kt` | Lets the editor save/list/move/delete stickers (`window.Android`) |
| `StickerRepository.kt` | Stores packs in the app's private storage, makes WebP stickers and tray icons |
| `StickerContentProvider.kt` | The interface WhatsApp reads packs from (format defined by [WhatsApp](https://github.com/WhatsApp/stickers)) |
| `WhatsApp.kt` | Checks whether a pack is already in WhatsApp; builds the "add pack" request |
| `.github/workflows/build.yml` | Builds the APK in the cloud on every push and publishes it as a GitHub Release |

## One-time setup (personal GitHub account)

1. **Create a repository** on your *personal* GitHub account, e.g. `StickerMaker` (private is fine).
2. **Add the signing key as secrets.** Every build must be signed with the same key, or Android refuses to update the app.
   The key lives in `~/StickerMaker-signing/` (never commit it; back it up somewhere safe).
   In the repo: **Settings → Secrets and variables → Actions → New repository secret**, add:

   | Secret name | Value |
   |---|---|
   | `SIGNING_KEYSTORE_BASE64` | contents of `~/StickerMaker-signing/release.jks.base64.txt` (`pbcopy < ~/StickerMaker-signing/release.jks.base64.txt`) |
   | `SIGNING_STORE_PASSWORD` | from `~/StickerMaker-signing/passwords.txt` |
   | `SIGNING_KEY_PASSWORD` | from `~/StickerMaker-signing/passwords.txt` |
   | `SIGNING_KEY_ALIAS` | `stickermaker` |

3. **Upload the code** (replace `YOUR_USERNAME`):
   ```sh
   cd ~/StickerMaker
   git branch -M main
   git remote add origin https://YOUR_USERNAME@github.com/YOUR_USERNAME/StickerMaker.git
   git push -u origin main
   ```
   When asked for a password, paste a personal access token from your personal account
   (GitHub → Settings → Developer settings → Fine-grained tokens, with Contents and Workflows read/write on this repo).
4. Open the repo's **Actions** tab and wait for **Build APK** to turn green (~5 min).

## Install on your phone

1. On the phone, open `https://github.com/YOUR_USERNAME/StickerMaker/releases/latest` (sign in if the repo is private).
2. Tap **StickerMaker.apk**. Android asks you to allow installs from Chrome once. If Play Protect warns about an unknown app, choose **Install anyway**.
3. To update later, push changes, wait for the build, and repeat. Your stickers are kept.

## Developing

- The editor can be opened in desktop Chrome (`python3 -m http.server` in `app/src/main/assets/web`), but saving needs the Android app's `window.Android` bridge.
- Adding `?debug` to the page URL exposes internals on `window.__sm` for tests.
- Uninstalling the app deletes its stickers (Android's auto-backup may restore them on a new phone).
