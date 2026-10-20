import * as db from './db.js';
import { CropTool } from './crop.js';
import { BrushEditor } from './brush.js';
import { loadImage, cropImage, makeSticker, encodePng, encodeWebp, blobToCanvas } from './image.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const DEFAULT_GROUP = '__default';
const NEW_GROUP = '__new';
const LAST_GROUP_KEY = 'lastGroupId';

const state = {
  groups: [],
  stickers: [],
  thumbUrls: [],
  // editor
  source: null,
  cropKey: null,
  stickerCanvas: null,
  depth: 0,
  afterHome: null,
  // sticker dialog
  openSticker: null,
  openStickerUrl: null,
  openStickerWebp: null,
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

async function withBusy(fn) {
  $('#busy').hidden = false;
  try {
    return await fn();
  } finally {
    $('#busy').hidden = true;
  }
}

function askText(title, initial = '') {
  const dialog = $('#prompt-dialog');
  const input = $('#prompt-input');
  $('#prompt-title').textContent = title;
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

function confirmDelete(text) {
  const dialog = $('#confirm-dialog');
  $('#confirm-text').textContent = text;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function errorMessage(err) {
  return (err && err.message) || String(err);
}

// ---------- home: groups and stickers ----------

async function refresh() {
  [state.groups, state.stickers] = await Promise.all([db.listGroups(), db.listStickers()]);
  renderHome();
}

function renderHome() {
  state.thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  state.thumbUrls = [];

  const root = $('#groups');
  root.replaceChildren();
  $('#empty').hidden = state.groups.length > 0;

  for (const group of state.groups) {
    const stickers = state.stickers.filter((s) => s.groupId === group.id);
    const section = document.createElement('section');
    section.className = 'group';

    const head = document.createElement('div');
    head.className = 'group-head';
    const title = document.createElement('h3');
    title.textContent = group.name + ' ';
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `${stickers.length}`;
    title.append(count);
    const rename = document.createElement('button');
    rename.className = 'icon-btn';
    rename.setAttribute('aria-label', `Rename ${group.name}`);
    rename.textContent = '✎';
    rename.onclick = () => renameGroup(group);
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.setAttribute('aria-label', `Delete ${group.name}`);
    del.textContent = '🗑';
    del.onclick = () => deleteGroup(group, stickers.length);
    head.append(title, rename, del);
    section.append(head);

    if (stickers.length) {
      const grid = document.createElement('div');
      grid.className = 'grid';
      for (const sticker of stickers) {
        const tile = document.createElement('button');
        tile.className = 'tile';
        tile.setAttribute('aria-label', 'Open sticker');
        const img = document.createElement('img');
        const url = URL.createObjectURL(sticker.png);
        state.thumbUrls.push(url);
        img.src = url;
        img.alt = '';
        tile.append(img);
        tile.onclick = () => openStickerDialog(sticker);
        grid.append(tile);
      }
      section.append(grid);
    } else {
      const p = document.createElement('p');
      p.className = 'group-empty';
      p.textContent = 'No stickers in this group yet.';
      section.append(p);
    }
    root.append(section);
  }
}

async function newGroup() {
  const name = await askText('New group name');
  if (!name) return null;
  const group = await db.createGroup(name);
  await refresh();
  return group;
}

async function renameGroup(group) {
  const name = await askText('Rename group', group.name);
  if (!name) return;
  await db.renameGroup(group.id, name);
  await refresh();
}

async function deleteGroup(group, count) {
  const text = count
    ? `Delete “${group.name}” and its ${count} sticker${count === 1 ? '' : 's'}?`
    : `Delete “${group.name}”?`;
  if (!(await confirmDelete(text))) return;
  await db.deleteGroup(group.id);
  await refresh();
}

// ---------- sticker dialog ----------

function fillGroupSelect(select, selectedId, { allowNew }) {
  select.replaceChildren();
  if (!state.groups.length) {
    select.append(new Option('My stickers', DEFAULT_GROUP));
  }
  for (const g of state.groups) select.append(new Option(g.name, g.id));
  if (allowNew) select.append(new Option('+ New group…', NEW_GROUP));
  const ids = [...select.options].map((o) => o.value);
  select.value = ids.includes(selectedId) ? selectedId : ids[0];
  select.dataset.prev = select.value;
}

function openStickerDialog(sticker) {
  closeStickerDialogResources();
  state.openSticker = sticker;
  state.openStickerUrl = URL.createObjectURL(sticker.png);
  // Encode ahead of time so the Share tap can call navigator.share() right away.
  state.openStickerWebp = blobToCanvas(sticker.png).then(encodeWebp);
  state.openStickerWebp.catch(() => {});
  $('#sticker-img').src = state.openStickerUrl;
  fillGroupSelect($('#move-select'), sticker.groupId, { allowNew: false });
  $('#sticker-dialog').showModal();
}

function closeStickerDialogResources() {
  if (state.openStickerUrl) URL.revokeObjectURL(state.openStickerUrl);
  state.openStickerUrl = null;
  state.openSticker = null;
  state.openStickerWebp = null;
}

async function shareSticker() {
  const sticker = state.openSticker;
  if (!sticker) return;
  let webp;
  try {
    webp = await state.openStickerWebp;
  } catch (err) {
    toast(errorMessage(err));
    return;
  }
  const file = new File([webp], `sticker-${sticker.id.slice(0, 8)}.webp`, { type: 'image/webp' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      if (err.name !== 'AbortError') toast(`Sharing failed: ${errorMessage(err)}`);
    }
  } else {
    downloadBlob(file, file.name);
    toast('Sharing isn’t supported here, so the sticker was downloaded instead.');
  }
}

function downloadSticker() {
  const sticker = state.openSticker;
  if (!sticker) return;
  downloadBlob(sticker.png, `sticker-${sticker.id.slice(0, 8)}.png`);
  toast('Saved to your Downloads.');
}

async function moveOpenSticker(groupId) {
  const sticker = state.openSticker;
  if (!sticker) return;
  await db.moveSticker(sticker.id, groupId);
  sticker.groupId = groupId;
  await refresh();
  toast('Moved.');
}

async function deleteOpenSticker() {
  const sticker = state.openSticker;
  if (!sticker) return;
  $('#sticker-dialog').close();
  if (!(await confirmDelete('Delete this sticker?'))) {
    openStickerDialog(sticker);
    return;
  }
  await db.deleteSticker(sticker.id);
  await refresh();
}

// ---------- editor ----------

const cropTool = new CropTool($('#crop-canvas'));
const brush = new BrushEditor($('#brush-canvas'), {
  onHistoryChange: () => {
    $('#undo-btn').disabled = !brush.canUndo();
    $('#redo-btn').disabled = !brush.canRedo();
  },
});

function showStep(step) {
  for (const name of ['crop', 'brush', 'save']) $(`#step-${name}`).hidden = name !== step;
  if (step === 'save') {
    fillGroupSelect($('#group-select'), localStorage.getItem(LAST_GROUP_KEY), { allowNew: true });
    renderPreview();
  }
}

function pushStep(step) {
  state.depth += 1;
  history.pushState({ step }, '');
  showStep(step);
}

async function openEditor(blob) {
  if (!blob || !blob.type.startsWith('image/')) {
    toast('That doesn’t look like an image.');
    return;
  }
  try {
    state.source = await withBusy(() => loadImage(blob));
  } catch (err) {
    toast(errorMessage(err));
    return;
  }
  state.cropKey = null;
  $('#home').hidden = true;
  $('#editor').hidden = false;
  state.depth = 0;
  pushStep('crop');
  cropTool.setImage(state.source);
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
  state.depth = 0;
  state.source = null;
  $('#editor').hidden = true;
  $('#home').hidden = false;
  const after = state.afterHome;
  state.afterHome = null;
  if (after) after();
}

window.addEventListener('popstate', (e) => {
  const step = e.state && e.state.step;
  if (step && state.source) {
    state.depth = ['crop', 'brush', 'save'].indexOf(step) + 1;
    showStep(step);
  } else {
    showHome();
  }
});

function goToBrush() {
  const crop = cropTool.getCrop();
  const key = JSON.stringify(crop);
  if (key !== state.cropKey) {
    state.cropKey = key;
    brush.setImage(cropImage(state.source, crop));
  }
  pushStep('brush');
}

function previewOptions() {
  return { trim: $('#opt-trim').checked, margin: $('#opt-margin').checked };
}

let previewToken = 0;
async function renderPreview() {
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
  saveBtn.disabled = false;
  ctx.drawImage(state.stickerCanvas, 0, 0);

  const token = ++previewToken;
  info.textContent = '512 × 512';
  try {
    const webp = await encodeWebp(state.stickerCanvas);
    if (token === previewToken) {
      info.textContent = `512 × 512 · ${Math.ceil(webp.size / 1024)} KB as a WhatsApp sticker (limit 100 KB)`;
    }
  } catch (err) {
    if (token === previewToken) info.textContent = errorMessage(err);
  }
}

async function resolveGroupId(select) {
  if (select.value === DEFAULT_GROUP) {
    const group = await db.createGroup('My stickers');
    return group.id;
  }
  return select.value;
}

async function saveSticker() {
  if (!state.stickerCanvas) return;
  const select = $('#group-select');
  const saved = await withBusy(async () => {
    const groupId = await resolveGroupId(select);
    const png = await encodePng(state.stickerCanvas);
    const sticker = await db.addSticker(groupId, png);
    localStorage.setItem(LAST_GROUP_KEY, groupId);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    return sticker;
  });
  await refresh();
  closeEditor(() => {
    openStickerDialog(saved);
    toast('Sticker saved.');
  });
}

// ---------- incoming images: picker, share target, paste, drop ----------

async function takeSharedImage() {
  const params = new URLSearchParams(location.search);
  const status = params.get('share-target');
  if (status === null) return;
  history.replaceState(null, '', location.pathname);
  if (status !== 'ok') {
    toast('No image came through. In the other app, long-press the image and choose “Share image”.', 6000);
    return;
  }
  const cache = await caches.open('share-inbox');
  const key = new URL('shared-file', location.href).href;
  const response = await cache.match(key);
  await cache.delete(key);
  if (!response) return;
  const blob = await response.blob();
  await openEditor(blob);
}

function firstImage(files) {
  return [...(files || [])].find((f) => f.type.startsWith('image/'));
}

// ---------- wiring ----------

function wire() {
  $('#new-sticker-btn').onclick = () => $('#file-input').click();
  $('#file-input').onchange = (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) openEditor(file);
  };
  $('#new-group-btn').onclick = () => newGroup();
  $('#help-btn').onclick = () => $('#help-dialog').showModal();

  // Crop step
  $$('[data-crop-mode]').forEach((btn) => {
    btn.onclick = () => {
      $$('[data-crop-mode]').forEach((b) => b.classList.toggle('active', b === btn));
      cropTool.setSquare(btn.dataset.cropMode === 'square');
    };
  });
  $('#crop-reset').onclick = () => cropTool.reset();
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
    const group = await newGroup();
    fillGroupSelect(select, group ? group.id : select.dataset.prev, { allowNew: true });
  };
  $('#save-btn').onclick = () => saveSticker().catch((err) => toast(errorMessage(err)));

  // Sticker dialog
  $('#share-btn').onclick = () => shareSticker();
  $('#download-btn').onclick = () => downloadSticker();
  $('#move-select').onchange = (e) => moveOpenSticker(e.target.value);
  $('#delete-sticker-btn').onclick = () => deleteOpenSticker();
  $('#sticker-dialog').addEventListener('close', closeStickerDialogResources);

  // Generic dialog closing: [data-close] buttons and tapping the backdrop.
  $$('[data-close]').forEach((b) => { b.onclick = () => b.closest('dialog').close(); });
  $$('dialog').forEach((d) => {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  });

  // Paste (Ctrl/Cmd+V) and drag-and-drop, handy on a computer.
  document.addEventListener('paste', (e) => {
    if ($('#home').hidden) return;
    const file = firstImage([...e.clipboardData.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()));
    if (file) openEditor(file);
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if ($('#home').hidden) return;
    const file = firstImage(e.dataTransfer.files);
    if (file) openEditor(file);
  });
}

async function main() {
  wire();
  if (new URLSearchParams(location.search).has('debug')) window.__sm = { cropTool, brush, state, db };
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker failed', err));
  }
  await refresh();
  if (!localStorage.getItem('seenHelp')) {
    localStorage.setItem('seenHelp', '1');
    $('#help-dialog').showModal();
  }
  await takeSharedImage().catch((err) => toast(errorMessage(err)));
}

main();
