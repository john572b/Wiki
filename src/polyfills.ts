/**
 * Polyfills pour les API récentes utilisées par pdf.js (navigateurs d'entreprise parfois en retard).
 * Chargé dans la page ET dans le worker pdf.js.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const P: any = Promise;
if (typeof P.withResolvers !== 'function') {
  P.withResolvers = function () {
    let resolve!: (v: unknown) => void, reject!: (e: unknown) => void;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}
if (typeof P.try !== 'function') {
  P.try = function (fn: (...a: unknown[]) => unknown, ...args: unknown[]) {
    return new Promise((res, rej) => { try { res(fn(...args)); } catch (e) { rej(e); } });
  };
}
const M: any = Math;
if (typeof M.sumPrecise !== 'function') {
  M.sumPrecise = function (iterable: Iterable<number>) {
    let s = 0;
    for (const v of iterable) s += v;
    return s;
  };
}
for (const C of [Map, WeakMap] as any[]) {
  const proto = C.prototype;
  if (typeof proto.getOrInsert !== 'function') {
    proto.getOrInsert = function (key: unknown, value: unknown) {
      if (this.has(key)) return this.get(key);
      this.set(key, value);
      return value;
    };
  }
  if (typeof proto.getOrInsertComputed !== 'function') {
    proto.getOrInsertComputed = function (key: unknown, fn: (k: unknown) => unknown) {
      if (this.has(key)) return this.get(key);
      const v = fn(key);
      this.set(key, v);
      return v;
    };
  }
}
const U: any = Uint8Array;
if (typeof U.prototype.toBase64 !== 'function') {
  U.prototype.toBase64 = function () {
    let s = '';
    for (let i = 0; i < this.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(this.subarray(i, i + 0x8000)) as number[]);
    return btoa(s);
  };
}
if (typeof U.fromBase64 !== 'function') {
  U.fromBase64 = function (s: string) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
}
export {};
