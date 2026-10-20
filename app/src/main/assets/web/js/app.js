import { call } from './native.js';
import { CropTool } from './crop.js';
import { BrushEditor } from './brush.js';
import { loadImage, cropImage, makeSticker } from './image.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const DEFAULT_GROUP = '__default';
const NEW_GROUP = '__new';
const LAST_GROUP_KEY = 'lastGroupId';

const state = {
  packs: [],
  whatsAppInstalled: true,
  minStickers: 3,
  maxStickers: 30,
  // editor
  source: null,
  cropKey: null,
  stickerCanvas: null,
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

// ---------- home: packs ----------

async function refresh() {
  const data = await call('listPacks');
  state.packs = data.packs;
  state.whatsAppInstalled = data.whatsAppInstalled;
  state.minStickers = data.minStickers;
  state.maxStickers = data.maxStickers;
  renderHome();
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

async function newGroup() {
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

function fillGroupSelect(select, selectedId, { allowNew, currentId = null }) {
  select.replaceChildren();
  if (!state.packs.length) select.append(new Option('My stickers', DEFAULT_GROUP));
  for (const p of state.packs) {
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
  fillGroupSelect($('#move-select'), pack.id, { allowNew: false, currentId: pack.id });
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

function renderPreview() {
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
  if (select.value === DEFAULT_GROUP) return (await call('createPack', { name: 'My stickers' })).id;
  if (select.value === NEW_GROUP) return newGroup();
  return select.value;
}

async function saveSticker() {
  if (!state.stickerCanvas) return;
  const emojis = parseEmojis($('#emoji-input').value);
  if (!emojis) {
    toast('Add 1 to 3 emojis — WhatsApp requires them.');
    $('#emoji-input').focus();
    return;
  }
  const groupId = await resolveGroupId($('#group-select'));
  if (!groupId) return;
  const png = state.stickerCanvas.toDataURL('image/png');
  await withBusy(() => call('addSticker', { packId: groupId, png, emojis }));
  localStorage.setItem(LAST_GROUP_KEY, groupId);
  await refresh();
  const pack = state.packs.find((p) => p.id === groupId);
  closeEditor(() => {
    if (!pack) return;
    const count = pack.stickers.length;
    if (pack.inWhatsApp) toast(`Saved to “${pack.name}”. It will show up in WhatsApp.`, 4000);
    else if (count < state.minStickers) toast(`Saved. Add ${state.minStickers - count} more to “${pack.name}” to use it in WhatsApp.`, 4000);
    else toast(`Saved. Tap “Add to WhatsApp” under “${pack.name}”.`, 4000);
  });
}

// ---------- images shared from other apps ----------

async function receiveShared() {
  const url = await call('takeSharedImage');
  if (!url) return;
  const blob = await (await fetch(url)).blob();
  if (!$('#editor').hidden) closeEditor(() => openEditor(blob));
  else {
    $$('dialog[open]').forEach((d) => d.close());
    await openEditor(blob);
  }
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
}

main();
