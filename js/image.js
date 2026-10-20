// Image loading and sticker export helpers.
export const STICKER_SIZE = 512;
export const MAX_STICKER_BYTES = 100 * 1024; // WhatsApp limit for static stickers
const MARGIN = 16; // WhatsApp's recommended margin around the artwork
const MAX_SOURCE_SIDE = 2048;
const MAX_EDIT_SIDE = 1024;

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Decodes an image file (respecting photo rotation) into a canvas no larger than 2048px. */
export async function loadImage(blob) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await decodeWithImgTag(blob);
  }
  const ratio = Math.min(1, MAX_SOURCE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = makeCanvas(Math.max(1, Math.round(bitmap.width * ratio)), Math.max(1, Math.round(bitmap.height * ratio)));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (bitmap.close) bitmap.close();
  return canvas;
}

function decodeWithImgTag(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This file is not an image the browser can open.')); };
    img.src = url;
  });
}

/** Copies the crop area into a new canvas (max 1024px per side) for touch-up. */
export function cropImage(image, crop) {
  const ratio = Math.min(1, MAX_EDIT_SIDE / Math.max(crop.w, crop.h));
  const canvas = makeCanvas(Math.max(1, Math.round(crop.w * ratio)), Math.max(1, Math.round(crop.h * ratio)));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Bounding box of pixels that are not (almost) fully transparent, or null if none. */
export function opaqueBounds(canvas) {
  const { width: w, height: h } = canvas;
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Fits the artwork into a 512x512 transparent square.
 * Non-square artwork gets transparent padding on the short sides.
 */
export function makeSticker(source, { trim = true, margin = true } = {}) {
  const bounds = trim ? opaqueBounds(source) : { x: 0, y: 0, w: source.width, h: source.height };
  if (!bounds) return null;
  const inner = STICKER_SIZE - (margin ? MARGIN * 2 : 0);
  const scale = inner / Math.max(bounds.w, bounds.h);
  const w = bounds.w * scale;
  const h = bounds.h * scale;
  const out = makeCanvas(STICKER_SIZE, STICKER_SIZE);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, bounds.x, bounds.y, bounds.w, bounds.h, (STICKER_SIZE - w) / 2, (STICKER_SIZE - h) / 2, w, h);
  return out;
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality);
  });
}

export function encodePng(canvas) {
  return toBlob(canvas, 'image/png');
}

/** Encodes as WebP, lowering quality until it fits WhatsApp's 100 KB limit. */
export async function encodeWebp(canvas) {
  let blob;
  for (const q of [0.92, 0.85, 0.78, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2]) {
    blob = await toBlob(canvas, 'image/webp', q);
    if (blob.type !== 'image/webp') throw new Error('This browser cannot create WebP images. Please use Chrome.');
    if (blob.size <= MAX_STICKER_BYTES) return blob;
  }
  return blob;
}

export async function blobToCanvas(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = makeCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}
