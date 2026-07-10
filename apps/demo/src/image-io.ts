/**
 * React-Native image I/O for the on-device vision adapters. The pure numeric
 * math (tensor packing, coordinate maps) lives in `@ppe/pipeline`; this file owns
 * only the platform pieces: native crop/resize (expo-image-manipulator) and JPEG
 * decode to RGBA (jpeg-js, pure JS — no canvas exists in RN). See docs/REAL_ADAPTERS.md.
 */
import { Image } from "react-native";
import * as ImageManipulator from "expo-image-manipulator";
import { decode as decodeJpeg } from "jpeg-js";
import type { Rgba } from "@ppe/pipeline";

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LUT = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) t[B64_ALPHABET.charCodeAt(i)] = i;
  return t;
})();

/** Decode base64 → bytes without assuming a global `atob`/`Buffer` (Hermes-safe). */
export function base64ToBytes(b64: string): Uint8Array {
  const s = b64.replace(/^data:[^,]+,/, "").replace(/[^A-Za-z0-9+/]/g, "");
  const len = s.length;
  const outLen = (len >> 2) * 3 + (len % 4 ? (len % 4) - 1 : 0);
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i + 4 <= len; i += 4) {
    const a = B64_LUT[s.charCodeAt(i)]!;
    const b = B64_LUT[s.charCodeAt(i + 1)]!;
    const c = B64_LUT[s.charCodeAt(i + 2)]!;
    const d = B64_LUT[s.charCodeAt(i + 3)]!;
    const chunk = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = (chunk >> 16) & 255;
    out[o++] = (chunk >> 8) & 255;
    out[o++] = chunk & 255;
  }
  const rem = len % 4;
  if (rem >= 2) {
    const a = B64_LUT[s.charCodeAt(len - rem)]!;
    const b = B64_LUT[s.charCodeAt(len - rem + 1)]!;
    out[o++] = (a << 2) | (b >> 4);
    if (rem === 3) {
      const c = B64_LUT[s.charCodeAt(len - 1)]!;
      out[o++] = ((b & 15) << 4) | (c >> 2);
    }
  }
  return out;
}

/** Decode a base64 JPEG into an RGBA raster (stride 4). */
export function decodeJpegRgba(base64: string): Rgba {
  const { width, height, data } = decodeJpeg(base64ToBytes(base64), {
    useTArray: true,
    formatAsRGBA: true,
  });
  return { data, width, height };
}

/** Actual pixel dimensions of a stored image URI. */
export function imageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) =>
    Image.getSize(uri, (width, height) => resolve({ width, height }), reject),
  );
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Native crop (optional) then resize to `w`×`h`, returned as a base64 JPEG. */
export async function manipulateToBase64(
  uri: string,
  resize: { width: number; height: number },
  crop?: CropRect,
): Promise<string> {
  const actions: ImageManipulator.Action[] = [];
  if (crop) {
    actions.push({
      crop: { originX: crop.x, originY: crop.y, width: crop.width, height: crop.height },
    });
  }
  actions.push({ resize });
  const result = await ImageManipulator.manipulateAsync(uri, actions, {
    base64: true,
    compress: 1,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  if (!result.base64) throw new Error("expo-image-manipulator returned no base64 data");
  return result.base64;
}
