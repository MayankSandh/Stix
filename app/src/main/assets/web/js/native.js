// Promise wrapper around the Android app's `window.Android` bridge (see NativeBridge.kt).
const pending = new Map();
let seq = 0;

window.__nativeResolve = (id, result) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if ('error' in result) p.reject(new Error(result.error));
  else p.resolve(result.ok);
};

export function call(method, args = {}) {
  if (!window.Android) return Promise.reject(new Error('This only works inside the Sticker Maker app.'));
  return new Promise((resolve, reject) => {
    const id = `r${++seq}`;
    pending.set(id, { resolve, reject });
    window.Android.call(id, method, JSON.stringify(args));
  });
}
