// Metro bundles the prebuilt nutrient DB as an asset (metro.config.js adds
// "sqlite" to assetExts); require("...sqlite") resolves to an asset module id.
declare module "*.sqlite" {
  const asset: number;
  export default asset;
}

// The on-device model weights bundle the same way (metro.config.js adds "onnx").
// require("...onnx") → asset module id, resolved to a file path via expo-asset.
declare module "*.onnx" {
  const asset: number;
  export default asset;
}

// jpeg-js ships no types; we use only decode() → { width, height, data (RGBA) }.
declare module "jpeg-js" {
  export function decode(
    data: ArrayLike<number>,
    opts?: { useTArray?: boolean; formatAsRGBA?: boolean },
  ): { width: number; height: number; data: Uint8Array };
}
