// Animated stickers: decode GIF / animated WebP / short videos into frames, then encode a
// WhatsApp-ready animated WebP (512x512, <= 500 KB, <= 10 s).
import { frameChunks, muxAnimatedWebp } from './webpmux.js';
import { STICKER_SIZE } from './image.js';

const BUDGET = 490 * 1024; // WhatsApp's limit is 500 KB; keep a little headroom
const MAX_DURATION = 10_000;
const MAX_FRAMES = 240;
const MAX_SIDE = 1024;
const VIDEO_FPS = 12;
const MARGIN = 16;

function once(target, ok, fail) {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const error = () => { cleanup(); reject(new Error('Could not read this video.')); };
    const cleanup = () => { target.removeEventListener(ok, done); target.removeEventListener(fail, error); };
    target.addEventListener(ok, done);
    target.addEventListener(fail, error);
  });
}

function bitmapOptions(width, height) {
  const ratio = Math.min(1, MAX_SIDE / Math.max(width, height));
  if (ratio === 1) return undefined;
  return { resizeWidth: Math.round(width * ratio), resizeHeight: Math.round(height * ratio), resizeQuality: 'high' };
}

/**
 * @returns {Promise<{frames: {image: ImageBitmap, duration: number}[], width: number, height: number} | null>}
 *   null when the file is a still image (or a single-frame GIF).
 */
export async function decodeAnimation(blob) {
  if (blob.type.startsWith('video/')) return decodeVideo(blob);
  if (!/^image\/(gif|webp|png|apng)$/.test(blob.type) || !('ImageDecoder' in window)) return null;
  const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: blob.type });
  try {
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    if (!track || !track.animated) return null;
    await decoder.completed;
    const frames = [];
    let total = 0;
    for (let i = 0; i < track.frameCount && frames.length < MAX_FRAMES && total < MAX_DURATION; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      let duration = (image.duration || 0) / 1000;
      if (!(duration >= 20)) duration = 100; // browsers show tiny GIF delays as 100 ms
      duration = Math.min(duration, MAX_DURATION - total);
      frames.push({ image: await createImageBitmap(image, bitmapOptions(image.displayWidth, image.displayHeight)), duration });
      image.close();
      total += duration;
    }
    return frames.length > 1 ? { frames, width: frames[0].image.width, height: frames[0].image.height } : null;
  } finally {
    decoder.close();
  }
}

async function decodeVideo(blob) {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await once(video, 'loadeddata', 'error');
    const length = Math.min(video.duration || 0, MAX_DURATION / 1000);
    if (!(length > 0)) throw new Error('Could not read this video.');
    const frames = [];
    const opts = bitmapOptions(video.videoWidth, video.videoHeight);
    for (let t = 0.001; t < length && frames.length < MAX_FRAMES; t += 1 / VIDEO_FPS) {
      video.currentTime = t;
      await once(video, 'seeked', 'error');
      frames.push({ image: await createImageBitmap(video, opts), duration: 1000 / VIDEO_FPS });
    }
    return frames.length > 1 ? { frames, width: frames[0].image.width, height: frames[0].image.height } : null;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

export function releaseAnimation(anim) {
  anim?.frames.forEach((f) => f.image.close());
}

/** First frame as a canvas (what the crop tool shows). */
export function firstFrameCanvas(anim) {
  const c = document.createElement('canvas');
  c.width = anim.width;
  c.height = anim.height;
  c.getContext('2d').drawImage(anim.frames[0].image, 0, 0);
  return c;
}

/** Where the artwork sits inside the 512x512 sticker (x/y even, as WebP animation requires). */
export function contentRect(crop, { margin = true, scale = 1 } = {}) {
  const inner = (STICKER_SIZE - (margin ? MARGIN * 2 : 0)) * scale;
  const k = inner / Math.max(crop.w, crop.h);
  const w = Math.max(2, Math.round(crop.w * k));
  const h = Math.max(2, Math.round(crop.h * k));
  const x = Math.min(STICKER_SIZE - w, Math.round((STICKER_SIZE - w) / 4) * 2);
  const y = Math.min(STICKER_SIZE - h, Math.round((STICKER_SIZE - h) / 4) * 2);
  return { x, y, w, h };
}

/** Draws one frame as it will appear in the sticker (full 512x512). */
export function drawStickerFrame(ctx, frame, crop, rect) {
  ctx.clearRect(0, 0, STICKER_SIZE, STICKER_SIZE);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(frame.image, crop.x, crop.y, crop.w, crop.h, rect.x, rect.y, rect.w, rect.h);
}

function mergeFrames(frames, skip) {
  const out = [];
  for (let i = 0; i < frames.length; i += skip) {
    let duration = 0;
    for (let j = i; j < Math.min(i + skip, frames.length); j++) duration += frames[j].duration;
    out.push({ image: frames[i].image, duration });
  }
  return out;
}

function sampleIndices(count, n) {
  if (count <= n) return [...Array(count).keys()];
  return [...Array(n).keys()].map((i) => Math.round((i * (count - 1)) / (n - 1)));
}

/**
 * Encodes the animation, lowering quality / dropping frames / shrinking until it fits 500 KB.
 * @returns {Promise<{blob: Blob, frames: number, duration: number}>}
 */
export async function encodeAnimatedSticker(anim, crop, { margin = true, onProgress = () => {} } = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  const encodeFrame = async (frame, rect, quality) => {
    canvas.width = rect.w;
    canvas.height = rect.h;
    ctx.clearRect(0, 0, rect.w, rect.h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(frame.image, crop.x, crop.y, crop.w, crop.h, 0, 0, rect.w, rect.h);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode frame'))), 'image/webp', quality);
    });
    if (blob.type !== 'image/webp') throw new Error('This phone’s browser engine cannot create WebP images.');
    return frameChunks(await blob.arrayBuffer());
  };

  for (const scale of [1, 0.8, 0.65]) {
    const rect = contentRect(crop, { margin, scale });
    for (const skip of [1, 2, 3, 4]) {
      const frames = mergeFrames(anim.frames, skip);
      if (frames.length < 2) break;
      for (const quality of [0.8, 0.65, 0.5, 0.38, 0.28]) {
        onProgress(`Compressing… (${frames.length} frames, quality ${Math.round(quality * 100)})`);
        const sample = sampleIndices(frames.length, 6);
        let sampleBytes = 0;
        for (const i of sample) sampleBytes += (await encodeFrame(frames[i], rect, quality)).length;
        if ((sampleBytes / sample.length) * frames.length > BUDGET * 0.95) continue;

        const parts = [];
        for (let i = 0; i < frames.length; i++) {
          onProgress(`Encoding frame ${i + 1} of ${frames.length}…`);
          parts.push(await encodeFrame(frames[i], rect, quality));
        }
        const durations = frames.map((f) => Math.max(20, Math.round(f.duration)));
        const blob = muxAnimatedWebp(parts, durations, { width: STICKER_SIZE, height: STICKER_SIZE, rect });
        if (blob.size <= BUDGET) {
          return { blob, frames: frames.length, duration: durations.reduce((a, b) => a + b, 0) };
        }
      }
    }
  }
  throw new Error('This animation is too big for WhatsApp even after compressing. Try a shorter clip or a tighter crop.');
}
