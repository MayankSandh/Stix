import { call } from './native.js';
import { CropTool } from './crop.js';
import { BrushEditor } from './brush.js';
import { loadImage, cropImage, makeSticker } from './image.js';
import { findPictures, clearRoundedCorners } from './detect.js';
import { decodeAnimation, releaseAnimation, firstFrameCanvas, contentRect, drawStickerFrame, encodeAnimatedSticker } from './animated.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const DEFAULT_GROUP = '__default';
const NEW_GROUP = '__new';
const LAST_GROUP_KEY = 'lastGroupId';
const LAST_GIF_GROUP_KEY = 'lastGifGroupId';

const state = {
  packs: [],
  whatsAppInstalled: true,
  minStickers: 3,
  maxStickers: 30,
  // editor
  source: null, // original image
  edited: null, // same size as source, with erasing applied (kept when re-cropping)
  step: null,
  cropKey: null,
  cropRect: null,
  stickerCanvas: null,
  anim: null, // { frames, width, height } when editing a GIF / video
  previewTimer: null,
  sourceUrl: null, // set when the image was shared to Stix (so its screenshot can be cleaned up)
  depth: 0,
  afterHome: null,
  // sticker dialog
  open: null, // { pack, sticker }
};

// ---------- small UI helpers ----------

let toastTimer;
function toast(message, ms = 3000) {
  const el = $('#toast');
  el.textContent = message;
  // Re-showing moves it to the top of the top layer, above any open dialog.
  if (el.matches(':popover-open')) el.hidePopover();
  el.showPopover();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.hidePopover(), ms);
}

async function withBusy(fn, text = '') {
  $('#busy-text').textContent = text;
  $('#busy').hidden = false;
  try {
    return await fn((t) => { $('#busy-text').textContent = t; });
  } finally {
    $('#busy').hidden = true;
  }
}

function askText(title, initial = '', { maxLength = 60, placeholder = '' } = {}) {
  const dialog = $('#prompt-dialog');
  const input = $('#prompt-input');
  $('#prompt-title').textContent = title;
  input.maxLength = maxLength;
  input.placeholder = placeholder;
  input.value = initial;
  dialog.returnValue = '';
  dialog.showModal();
  input.focus();
  input.select();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      const value = input.value.trim();
      resolve(dialog.returnValue === 'ok' && value ? value : null);
    }, { once: true });
  });
}

function confirmDelete(text, okLabel = 'Delete') {
  const dialog = $('#confirm-dialog');
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

function errorMessage(err) {
  return (err && err.message) || String(err);
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/** Emojis in the text, or null if there isn't 1–3 of them (WhatsApp's rule). */
function parseEmojis(text) {
  const emojis = [...new Set([...graphemes.segment(text)].map((g) => g.segment).filter((g) => EMOJI.test(g)))];
  return emojis.length >= 1 && emojis.length <= 3 ? emojis : null;
}

function timeAgo(ms) {
  if (!ms) return 'never';
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString();
}

// ---------- settings: backup & updates ----------

async function openSettings() {
  $('#settings-dialog').showModal();
  await renderSettings();
}

async function renderSettings() {
  const settings = await call('getSettings');
  const b = settings.backup;
  let text;
  if (!b.location) {
    text = 'Not set up. Your stickers are only on this phone, so uninstalling Stix or losing the phone would lose them.';
  } else if (b.error) {
    text = `Backing up to ${b.location}. Last backup failed: ${b.error}`;
  } else {
    text = `Backing up to ${b.location} automatically after every change. Last backup: ${timeAgo(b.lastBackupAt)}.`;
  }
  $('#backup-status').textContent = text;
  $('#backup-choose').textContent = b.location ? 'Change backup file…' : 'Set up backup…';
  $('#backup-choose').classList.toggle('primary', !b.location);
  $('#backup-choose').classList.toggle('secondary', !!b.location);
  $('#backup-now').hidden = !b.location;
  $('#version-text').textContent = `You're on Stix ${settings.versionName}.`;
  renderShotSettings(settings.screenshots);
  return settings;
}

// ---------- shared screenshot cleanup ----------

function renderShotSettings(shots) {
  $('#shots-section').hidden = !shots.supported;
  $$('[data-shot-mode]').forEach((b) => b.classList.toggle('active', b.dataset.shotMode === shots.mode));
  let text = '';
  if (shots.mode !== 'keep') {
    if (shots.silent) text = '✓ Happens automatically, without asking.';
    else if (shots.canBeSilent) text = 'Android will ask each time. Allow it once below to skip that.';
    else text = 'Android will ask each time (your Android version requires it).';
  }
  $('#shots-status').textContent = text;
  $('#shots-grant').hidden = shots.mode === 'keep' || shots.silent || !shots.canBeSilent;
}

async function setShotMode(mode) {
  const shots = await call('setScreenshotMode', { mode });
  renderShotSettings(shots);
}

async function grantShotAccess() {
  const shots = await call('grantScreenshotAccess');
  if ($('#settings-dialog').open) renderShotSettings(shots);
  if (shots.silent) toast('Done. Screenshots will be cleaned up without asking.', 4000);
  else if (!shots.photoAccess) toast('Photo access wasn’t allowed (choose “Allow all”). Android will ask each time instead.', 6000);
  else toast('Media management wasn’t switched on. Android will ask each time instead.', 6000);
  return shots;
}


/** Shows the one-time choice. Resolves to 'setup' | 'ask' | 'keep' | null (dismissed). */
function askShotSetup() {
  const dialog = $('#shots-dialog');
  dialog.showModal();
  return new Promise((resolve) => {
    const finish = (choice) => { dialog.close(); resolve(choice); };
    $('#shots-setup').onclick = () => finish('setup');
    $('#shots-ask').onclick = () => finish('ask');
    $('#shots-keep').onclick = () => finish('keep');
    dialog.addEventListener('close', () => resolve(null), { once: true });
  });
}

const CLEANUP_MESSAGES = {
  trashed: 'Screenshot moved to trash.',
  deleted: 'Screenshot deleted.',
};

/** Cleans up the shared screenshot per the user's setting; returns a short message or null. */
async function cleanupScreenshot(url) {
  try {
    let result = await call('cleanupShared', { url });
    if (result.status === 'setup') {
      const choice = await askShotSetup();
      if (choice === 'keep') {
        await call('setScreenshotMode', { mode: 'keep' });
        return 'Screenshots will be kept (change this in ⚙ Settings).';
      }
      if (choice === null) return null; // dismissed: ask again next time, leave the screenshot
      if (choice === 'setup') await grantShotAccess();
      else await call('skipScreenshotSetup');
      result = await call('cleanupShared', { url, allowPrompt: true });
    }
    return CLEANUP_MESSAGES[result.status] || null;
  } catch (err) {
    return `Couldn’t clean up the screenshot: ${errorMessage(err)}`;
  }
}

async function chooseBackupLocation() {
  try {
    const result = await call('chooseBackupLocation');
    if (result.cancelled) return;
    toast(`Backed up to ${result.location}. It will stay up to date automatically.`, 5000);
    localStorage.setItem('backupNudgeDone', '1');
    $('#backup-nudge').hidden = true;
  } catch (err) {
    toast(errorMessage(err), 6000);
  }
  if ($('#settings-dialog').open) await renderSettings();
}

async function backupNow() {
  try {
    await withBusy(() => call('backupNow'), 'Backing up…');
    toast('Backup done.');
  } catch (err) {
    toast(errorMessage(err), 6000);
  }
  await renderSettings();
}

async function restoreFromBackup() {
  let summary;
  try {
    summary = await call('pickRestoreFile');
  } catch (err) {
    toast(errorMessage(err), 6000);
    return;
  }
  if (!summary || summary.cancelled) return;
  const when = summary.createdAt ? new Date(summary.createdAt).toLocaleString() : 'an unknown date';
  const ok = await confirmDelete(
    `Restore ${summary.packs} group${summary.packs === 1 ? '' : 's'} with ${summary.stickers} sticker${summary.stickers === 1 ? '' : 's'} from the backup made ${when}? This replaces the stickers currently in Stix.`,
    'Restore',
  );
  if (!ok) return;
  try {
    await withBusy(() => call('applyRestore'), 'Restoring…');
    await refresh();
    toast('Restored. Tap “Add to WhatsApp” on each pack if it isn’t in WhatsApp yet.', 6000);
  } catch (err) {
    toast(errorMessage(err), 6000);
  }
  if ($('#settings-dialog').open) await renderSettings();
}

async function checkForUpdate({ quiet = false } = {}) {
  try {
    const info = await call('checkForUpdate');
    $('#update-banner').hidden = !info.available;
    if (info.available) {
      $('#update-text').textContent = `Stix ${info.versionName} is available${info.notes ? `: ${info.notes}` : '.'}`;
      if (!quiet) toast(`Update available: ${info.versionName}`);
    } else if (!quiet) {
      toast(`You're up to date (${info.currentVersion}).`);
    }
  } catch (err) {
    if (!quiet) toast(errorMessage(err), 5000);
  }
}

async function installUpdate() {
  const busyText = (pct) => { $('#busy-text').textContent = `Downloading update… ${pct}%`; };
  window.onUpdateProgress = busyText;
  try {
    const result = await withBusy(() => call('installUpdate'), 'Downloading update…');
    if (result.status === 'denied') toast('To update, allow Stix to install apps when Android asks, then tap Update again.', 7000);
  } catch (err) {
    toast(errorMessage(err), 6000);
  } finally {
    window.onUpdateProgress = null;
  }
}

async function maybeNudgeBackup() {
  if (localStorage.getItem('backupNudgeDone')) return;
  const hasStickers = state.packs.some((p) => p.stickers.length);
  if (!hasStickers) return;
  const settings = await call('getSettings').catch(() => null);
  $('#backup-nudge').hidden = !settings || !!settings.backup.location;
}

// ---------- home: packs ----------

async function refresh() {
  const data = await call('listPacks');
  state.packs = data.packs;
  state.whatsAppInstalled = data.whatsAppInstalled;
  state.minStickers = data.minStickers;
  state.maxStickers = data.maxStickers;
  renderHome();
  if (data.loadError) toast(data.loadError, 15000);
}

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function renderHome() {
  const root = $('#groups');
  root.replaceChildren();
  $('#empty').hidden = state.packs.length > 0;

  for (const pack of state.packs) {
    const count = pack.stickers.length;
    const rename = el('button', { className: 'icon-btn', textContent: '✎', onclick: () => renameGroup(pack) });
    rename.setAttribute('aria-label', `Rename ${pack.name}`);
    const del = el('button', { className: 'icon-btn', textContent: '🗑', onclick: () => deleteGroup(pack) });
    del.setAttribute('aria-label', `Delete ${pack.name}`);
    const title = el('h3', { textContent: `${pack.name} ` }, [el('span', { className: 'count', textContent: `${count}/${state.maxStickers}` })]);
    if (pack.animated) title.append(el('span', { className: 'badge', textContent: 'GIF' }));
    const section = el('section', { className: 'group' }, [el('div', { className: 'group-head' }, [title, rename, del])]);

    if (count) {
      const grid = el('div', { className: 'grid' });
      for (const sticker of pack.stickers) {
        const tile = el('button', { className: 'tile', onclick: () => openStickerDialog(pack, sticker) }, [
          el('img', { src: sticker.url, alt: '', loading: 'lazy' }),
        ]);
        tile.setAttribute('aria-label', `Sticker ${sticker.emojis.join(' ')}`);
        grid.append(tile);
      }
      section.append(grid);
    } else {
      section.append(el('p', { className: 'group-empty', textContent: 'No stickers in this group yet.' }));
    }
    section.append(packStatus(pack));
    root.append(section);
  }
}

function packStatus(pack) {
  const row = el('div', { className: 'pack-status' });
  const missing = state.minStickers - pack.stickers.length;
  if (!state.whatsAppInstalled) {
    row.textContent = 'Install WhatsApp to use this pack.';
  } else if (missing > 0) {
    row.textContent = `Add ${missing} more sticker${missing === 1 ? '' : 's'} to use this pack in WhatsApp.`;
  } else if (pack.inWhatsApp) {
    row.append(el('span', { className: 'ok', textContent: '✓ In WhatsApp' }), el('span', { textContent: 'Changes sync automatically.' }));
  } else {
    const btn = el('button', { className: 'btn primary', textContent: 'Add to WhatsApp' });
    btn.onclick = () => addToWhatsApp(pack, btn);
    row.append(btn);
  }
  return row;
}

async function addToWhatsApp(pack, btn) {
  btn.disabled = true;
  try {
    const result = await call('addToWhatsApp', { packId: pack.id });
    const messages = {
      added: `“${pack.name}” added to WhatsApp.`,
      already: 'This pack is already in WhatsApp.',
      cancelled: 'Not added.',
    };
    toast(messages[result.status] || result.message || 'WhatsApp couldn’t add the pack.', 5000);
  } catch (err) {
    toast(errorMessage(err));
  } finally {
    btn.disabled = false;
    await refresh();
  }
}

async function newGroup() { // a group becomes a still or GIF pack with its first sticker
  const name = await askText('New group name');
  if (!name) return null;
  const { id } = await call('createPack', { name });
  await refresh();
  return id;
}

async function renameGroup(pack) {
  const name = await askText('Rename group', pack.name);
  if (!name) return;
  await call('renamePack', { packId: pack.id, name });
  await refresh();
}

async function deleteGroup(pack) {
  const count = pack.stickers.length;
  const text = count
    ? `Delete “${pack.name}” and its ${count} sticker${count === 1 ? '' : 's'}?`
    : `Delete “${pack.name}”?`;
  if (!(await confirmDelete(text))) return;
  await call('deletePack', { packId: pack.id });
  await refresh();
}

// ---------- sticker dialog ----------

/** Packs a sticker of this kind may go in: same kind, or still empty (kind not decided yet). */
function packsFor(animated) {
  return state.packs.filter((p) => p.animated === null || p.animated === undefined || p.animated === animated);
}

function defaultGroupName(animated) {
  return animated ? 'My GIF stickers' : 'My stickers';
}

function fillGroupSelect(select, selectedId, { allowNew, currentId = null, animated = false }) {
  select.replaceChildren();
  const packs = packsFor(animated);
  if (!packs.length) select.append(new Option(defaultGroupName(animated), DEFAULT_GROUP));
  for (const p of packs) {
    const full = p.stickers.length >= state.maxStickers && p.id !== currentId;
    const option = new Option(full ? `${p.name} (full)` : p.name, p.id);
    option.disabled = full;
    select.append(option);
  }
  if (allowNew) select.append(new Option('+ New group…', NEW_GROUP));
  const usable = [...select.options].filter((o) => !o.disabled && o.value !== NEW_GROUP).map((o) => o.value);
  select.value = usable.includes(selectedId) ? selectedId : (usable[0] ?? NEW_GROUP);
  select.dataset.prev = select.value;
}

function openStickerDialog(pack, sticker) {
  state.open = { pack, sticker };
  $('#sticker-img').src = sticker.url;
  $('#sticker-emoji').value = sticker.emojis.join('');
  fillGroupSelect($('#move-select'), pack.id, { allowNew: false, currentId: pack.id, animated: !!pack.animated });
  $('#sticker-dialog').showModal();
}

async function saveOpenEmojis() {
  const { pack, sticker } = state.open || {};
  if (!sticker) return;
  const input = $('#sticker-emoji');
  const emojis = parseEmojis(input.value);
  if (!emojis) {
    toast('Use 1 to 3 emojis.');
    input.value = sticker.emojis.join('');
    return;
  }
  await call('setEmojis', { packId: pack.id, file: sticker.file, emojis });
  sticker.emojis = emojis;
  input.value = emojis.join('');
  await refresh();
}

async function moveOpenSticker(toPackId) {
  const { pack, sticker } = state.open || {};
  if (!sticker || toPackId === pack.id) return;
  try {
    await call('moveSticker', { packId: pack.id, file: sticker.file, toPackId });
    state.open.pack = state.packs.find((p) => p.id === toPackId) || pack;
    toast('Moved.');
  } catch (err) {
    toast(errorMessage(err));
  }
  await refresh();
}

async function deleteOpenSticker() {
  const { pack, sticker } = state.open || {};
  if (!sticker) return;
  $('#sticker-dialog').close();
  if (!(await confirmDelete('Delete this sticker?'))) {
    openStickerDialog(pack, sticker);
    return;
  }
  await call('deleteSticker', { packId: pack.id, file: sticker.file });
  await refresh();
}

// ---------- editor ----------

const cropTool = new CropTool($('#crop-canvas'));
const brush = new BrushEditor($('#brush-canvas'), {
  onHistoryChange: () => {
    $('#undo-btn').disabled = !brush.canUndo();
    $('#redo-btn').disabled = !brush.canRedo();
  },
  onViewChange: (zoomed) => {
    $('#fit-btn').disabled = !zoomed;
  },
});

function copyCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

/** Writes touch-up edits back into the full image so re-cropping keeps them. */
function commitBrushEdits() {
  if (!brush.dirty || !state.cropRect || !state.edited) return;
  const { x, y, w, h } = state.cropRect;
  const ctx = state.edited.getContext('2d');
  ctx.clearRect(x, y, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(brush.getResult(), x, y, w, h);
  brush.dirty = false;
  cropTool.refresh();
}

function showStep(step) {
  if (state.step === 'brush' && step === 'crop') commitBrushEdits();
  state.step = step;
  stopAnimatedPreview();
  for (const name of ['crop', 'brush', 'save']) $(`#step-${name}`).hidden = name !== step;
  if (step === 'save') {
    const animated = !!state.anim;
    $('#opt-trim-row').hidden = animated;
    fillGroupSelect($('#group-select'), localStorage.getItem(animated ? LAST_GIF_GROUP_KEY : LAST_GROUP_KEY), { allowNew: true, animated });
    renderPreview();
  }
}

function pushStep(step) {
  state.depth += 1;
  history.pushState({ step, depth: state.depth }, '');
  showStep(step);
}

async function openEditor(blob) {
  releaseAnimation(state.anim);
  state.anim = null;
  try {
    await withBusy(async () => {
      state.anim = await decodeAnimation(blob).catch((err) => {
        if (blob.type.startsWith('video/')) throw err;
        return null; // fall back to a still image
      });
      state.source = state.anim ? firstFrameCanvas(state.anim) : await loadImage(blob);
    }, 'Opening…');
  } catch (err) {
    toast(errorMessage(err));
    return;
  }
  if (state.anim) {
    const seconds = state.anim.frames.reduce((t, f) => t + f.duration, 0) / 1000;
    toast(`GIF: ${state.anim.frames.length} frames, ${seconds.toFixed(1)} s. Crop it, then save.`, 3500);
  }
  state.edited = copyCanvas(state.source);
  state.cropKey = null;
  state.cropRect = null;
  state.step = null;
  $('#home').hidden = true;
  $('#editor').hidden = false;
  state.depth = 0;
  pushStep('crop');
  cropTool.setImage(state.edited);
}

function closeEditor(afterHome) {
  state.afterHome = afterHome || null;
  if (state.depth > 0) {
    history.go(-state.depth);
  } else {
    showHome();
  }
}

function showHome() {
  stopAnimatedPreview();
  releaseAnimation(state.anim);
  state.anim = null;
  state.depth = 0;
  state.source = null;
  state.sourceUrl = null;
  state.edited = null;
  state.step = null;
  $('#editor').hidden = true;
  $('#home').hidden = false;
  const after = state.afterHome;
  state.afterHome = null;
  if (after) after();
}

window.addEventListener('popstate', (e) => {
  const step = e.state && e.state.step;
  if (step && state.source) {
    state.depth = e.state.depth;
    showStep(step);
  } else {
    showHome();
  }
});

/** Called by the Android back button. Returns true if the app handled it. */
window.handleBack = () => {
  const open = $$('dialog[open]').pop();
  if (open) {
    open.close();
    return true;
  }
  if (!$('#editor').hidden) {
    history.back();
    return true;
  }
  return false;
};

function goToBrush() {
  const crop = cropTool.getCrop();
  if (state.anim) {
    // Erasing works on single images; GIFs go straight from crop to save.
    state.cropRect = crop;
    pushStep('save');
    return;
  }
  const key = JSON.stringify(crop);
  if (key !== state.cropKey) {
    state.cropKey = key;
    state.cropRect = crop;
    brush.setImage(cropImage(state.source, crop), cropImage(state.edited, crop));
  }
  pushStep('brush');
}

/** Finds pictures in a screenshot and lets the user tap one to crop exactly to it. */
function findImages() {
  const { rects, background } = findPictures(state.source);
  if (!rects.length) {
    toast('No pictures found here. Crop it by hand instead.', 4000);
    return;
  }
  const onPick = (rect) => {
    $$('[data-crop-mode]').forEach((b) => b.classList.toggle('active', b.dataset.cropMode === 'free'));
    cropTool.square = false;
    // In-app images have rounded corners; make those background-coloured corners transparent.
    if (!state.anim && clearRoundedCorners(state.edited, rect, background)) {
      state.cropKey = null;
      cropTool.refresh();
    }
  };
  if (rects.length === 1) {
    cropTool.onPick = onPick;
    cropTool.pick(rects[0]);
    toast('Picture found and selected.', 2500);
  } else {
    cropTool.setCandidates(rects, onPick);
    toast(`Found ${rects.length} pictures. Tap the one you want.`, 4000);
  }
}

/** On-device subject detection (ML Kit) on the cropped area; result can be fine-tuned with the brushes. */
async function magicCutout() {
  const btn = $('#magic-btn');
  btn.disabled = true;
  try {
    const image = brush.original.toDataURL('image/jpeg', 0.92);
    const maskUrl = await withBusy(() => call('segmentSubject', { image }));
    const mask = await createImageBitmap(await (await fetch(maskUrl)).blob());
    brush.applyMask(mask);
    toast('Done. Use Erase / Restore to fine-tune the edges.', 4000);
  } catch (err) {
    toast(errorMessage(err), 6000);
  } finally {
    btn.disabled = false;
  }
}

function previewOptions() {
  return { trim: $('#opt-trim').checked, margin: $('#opt-margin').checked };
}

function stopAnimatedPreview() {
  clearTimeout(state.previewTimer);
  state.previewTimer = null;
}

function renderAnimatedPreview() {
  const ctx = $('#preview-canvas').getContext('2d');
  const crop = state.cropRect;
  const rect = contentRect(crop, { margin: $('#opt-margin').checked });
  const frames = state.anim.frames;
  const seconds = frames.reduce((t, f) => t + f.duration, 0) / 1000;
  $('#size-info').textContent = `GIF sticker · ${frames.length} frames · ${seconds.toFixed(1)} s (WhatsApp allows up to 10 s)`;
  $('#save-btn').disabled = false;
  let i = 0;
  const tick = () => {
    drawStickerFrame(ctx, frames[i], crop, rect);
    state.previewTimer = setTimeout(tick, frames[i].duration);
    i = (i + 1) % frames.length;
  };
  tick();
}

function renderPreview() {
  stopAnimatedPreview();
  if (state.anim) {
    renderAnimatedPreview();
    return;
  }
  const canvas = $('#preview-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  state.stickerCanvas = makeSticker(brush.getResult(), previewOptions());
  const info = $('#size-info');
  const saveBtn = $('#save-btn');
  if (!state.stickerCanvas) {
    info.textContent = 'Nothing left to save — everything was erased.';
    saveBtn.disabled = true;
    return;
  }
  info.textContent = '';
  saveBtn.disabled = false;
  ctx.drawImage(state.stickerCanvas, 0, 0);
}

async function resolveGroupId(select) {
  if (select.value === DEFAULT_GROUP) return (await call('createPack', { name: defaultGroupName(!!state.anim) })).id;
  if (select.value === NEW_GROUP) return newGroup();
  return select.value;
}

async function saveSticker() {
  if (!state.stickerCanvas && !state.anim) return;
  const emojis = parseEmojis($('#emoji-input').value);
  if (!emojis) {
    toast('Add 1 to 3 emojis — WhatsApp requires them.');
    $('#emoji-input').focus();
    return;
  }
  const groupId = await resolveGroupId($('#group-select'));
  if (!groupId) return;
  if (state.anim) {
    await withBusy(async (progress) => {
      const { blob } = await encodeAnimatedSticker(state.anim, state.cropRect, { margin: $('#opt-margin').checked, onProgress: progress });
      const preview = document.createElement('canvas');
      preview.width = preview.height = 512;
      drawStickerFrame(preview.getContext('2d'), state.anim.frames[0], state.cropRect, contentRect(state.cropRect, { margin: $('#opt-margin').checked }));
      progress('Saving…');
      await call('addAnimatedSticker', { packId: groupId, webp: await blobToDataUrl(blob), preview: preview.toDataURL('image/png'), emojis });
    }, 'Making GIF sticker…');
    localStorage.setItem(LAST_GIF_GROUP_KEY, groupId);
  } else {
    const png = state.stickerCanvas.toDataURL('image/png');
    await withBusy(() => call('addSticker', { packId: groupId, png, emojis }));
    localStorage.setItem(LAST_GROUP_KEY, groupId);
  }
  await refresh();
  maybeNudgeBackup().catch(() => {});
  const pack = state.packs.find((p) => p.id === groupId);
  const sourceUrl = state.sourceUrl;
  closeEditor(async () => {
    if (!pack) return;
    const count = pack.stickers.length;
    let message;
    if (pack.inWhatsApp) message = `Saved to “${pack.name}”. It will show up in WhatsApp.`;
    else if (count < state.minStickers) message = `Saved. Add ${state.minStickers - count} more to “${pack.name}” to use it in WhatsApp.`;
    else message = `Saved. Tap “Add to WhatsApp” under “${pack.name}”.`;
    toast(message, 4000);
    if (sourceUrl) {
      const cleaned = await cleanupScreenshot(sourceUrl);
      if (cleaned) toast(`${message} ${cleaned}`, 4500);
    }
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ---------- images shared from other apps / links ----------

async function openFromUrl(url, { shared = false } = {}) {
  const blob = await (await fetch(url)).blob();
  const open = async () => {
    await openEditor(blob);
    state.sourceUrl = shared && state.source ? url : null;
  };
  if (!$('#editor').hidden) closeEditor(open);
  else {
    $$('dialog[open]').forEach((d) => d.close());
    await open();
  }
}

async function fromLink() {
  const link = await askText('Paste a link to a GIF or image', '', { maxLength: 4000, placeholder: 'https://…' });
  if (!link) return;
  try {
    const url = await withBusy(() => call('fetchMedia', { url: link }), 'Downloading…');
    await openFromUrl(url);
  } catch (err) {
    toast(errorMessage(err), 6000);
  }
}

async function receiveShared() {
  const url = await call('takeSharedImage');
  if (url) await openFromUrl(url, { shared: true });
}

// ---------- wiring ----------

function wire() {
  $('#new-sticker-btn').onclick = () => $('#file-input').click();
  $('#file-input').onchange = (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) openEditor(file);
  };
  $('#new-group-btn').onclick = () => newGroup().catch((err) => toast(errorMessage(err)));
  $('#help-btn').onclick = () => { $('#settings-dialog').close(); $('#help-dialog').showModal(); };
  $('#settings-btn').onclick = () => openSettings().catch((err) => toast(errorMessage(err)));
  $('#backup-choose').onclick = () => chooseBackupLocation();
  $$('[data-shot-mode]').forEach((b) => { b.onclick = () => setShotMode(b.dataset.shotMode).catch((err) => toast(errorMessage(err))); });
  $('#shots-grant').onclick = () => grantShotAccess().catch((err) => toast(errorMessage(err)));
  $('#backup-now').onclick = () => backupNow();
  $('#backup-restore').onclick = () => restoreFromBackup();
  $('#update-check').onclick = () => checkForUpdate();
  $('#update-btn').onclick = () => installUpdate();
  $('#nudge-setup').onclick = () => chooseBackupLocation();
  $('#nudge-close').onclick = () => {
    localStorage.setItem('backupNudgeDone', '1');
    $('#backup-nudge').hidden = true;
  };
  $('#link-btn').onclick = () => fromLink();

  // Crop step
  $$('[data-crop-mode]').forEach((btn) => {
    btn.onclick = () => {
      $$('[data-crop-mode]').forEach((b) => b.classList.toggle('active', b === btn));
      cropTool.setSquare(btn.dataset.cropMode === 'square');
    };
  });
  $('#crop-reset').onclick = () => cropTool.reset();
  $('#find-btn').onclick = () => findImages();
  $('#crop-next').onclick = () => goToBrush();
  $$('[data-action="cancel"]').forEach((b) => { b.onclick = () => closeEditor(); });

  // Brush step
  $$('[data-brush-mode]').forEach((btn) => {
    btn.onclick = () => {
      $$('[data-brush-mode]').forEach((b) => b.classList.toggle('active', b === btn));
      brush.setMode(btn.dataset.brushMode);
    };
  });
  const size = $('#brush-size');
  brush.setBrushSize(Number(size.value));
  size.oninput = () => brush.setBrushSize(Number(size.value));
  $('#undo-btn').onclick = () => brush.undo();
  $('#redo-btn').onclick = () => brush.redo();
  $('#fit-btn').onclick = () => brush.fit();
  $('#magic-btn').onclick = () => magicCutout();
  $('#brush-back').onclick = () => history.back();
  $('#brush-next').onclick = () => pushStep('save');

  // Save step
  $('#save-back').onclick = () => history.back();
  $('#opt-trim').onchange = renderPreview;
  $('#opt-margin').onchange = renderPreview;
  $$('[data-preview-bg]').forEach((btn) => {
    btn.onclick = () => {
      $$('[data-preview-bg]').forEach((b) => b.classList.toggle('active', b === btn));
      $('#preview-wrap').className = `preview-wrap bg-${btn.dataset.previewBg}`;
    };
  });
  $('#preview-wrap').className = 'preview-wrap bg-checker';
  $('#group-select').onchange = async (e) => {
    const select = e.target;
    if (select.value !== NEW_GROUP) {
      select.dataset.prev = select.value;
      return;
    }
    const id = await newGroup().catch((err) => { toast(errorMessage(err)); return null; });
    fillGroupSelect(select, id || select.dataset.prev, { allowNew: true });
  };
  $('#save-btn').onclick = () => saveSticker().catch((err) => toast(errorMessage(err)));

  // Sticker dialog
  $('#sticker-emoji').onchange = () => saveOpenEmojis().catch((err) => toast(errorMessage(err)));
  $('#move-select').onchange = (e) => moveOpenSticker(e.target.value);
  $('#delete-sticker-btn').onclick = () => deleteOpenSticker().catch((err) => toast(errorMessage(err)));

  // Generic dialog closing: [data-close] buttons and tapping the backdrop.
  $$('[data-close]').forEach((b) => { b.onclick = () => b.closest('dialog').close(); });
  $$('dialog').forEach((d) => {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  });

  // Coming back from WhatsApp: refresh the "In WhatsApp" badges.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !$('#home').hidden) refresh().catch(() => {});
  });

  window.onSharedImage = () => receiveShared().catch((err) => toast(errorMessage(err)));
}

async function main() {
  wire();
  if (new URLSearchParams(location.search).has('debug')) window.__sm = { cropTool, brush, state };
  try {
    await refresh();
  } catch (err) {
    toast(errorMessage(err), 6000);
  }
  if (!localStorage.getItem('seenHelp')) {
    localStorage.setItem('seenHelp', '1');
    $('#help-dialog').showModal();
  }
  await receiveShared().catch((err) => toast(errorMessage(err)));
  checkForUpdate({ quiet: true });
  maybeNudgeBackup().catch(() => {});
}

main();
