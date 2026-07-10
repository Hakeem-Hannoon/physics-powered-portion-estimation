/**
 * onnxruntime-react-native session loading for bundled `.onnx` model assets.
 * Metro bundles the weights as assets (metro.config.js → assetExts includes
 * "onnx"); expo-asset resolves the `require(...)` module id to an on-device file
 * path, which InferenceSession.create() loads. Sessions are cached per model.
 */
import { Asset } from "expo-asset";
import { InferenceSession } from "onnxruntime-react-native";

const sessions = new Map<number, Promise<InferenceSession>>();

/** Resolve a bundled `.onnx` asset (require id) to a local filesystem path. */
async function modelPath(moduleRef: number): Promise<string> {
  const asset = Asset.fromModule(moduleRef);
  await asset.downloadAsync(); // copies the bundled asset into cache; no-op if present
  const uri = asset.localUri ?? asset.uri;
  // InferenceSession.create wants a plain file path, not a file:// URI.
  return uri.startsWith("file://") ? decodeURIComponent(uri.slice("file://".length)) : uri;
}

/** Load (and cache) an InferenceSession for a bundled model asset. */
export function loadSession(moduleRef: number): Promise<InferenceSession> {
  let existing = sessions.get(moduleRef);
  if (!existing) {
    existing = modelPath(moduleRef).then((path) => InferenceSession.create(path));
    sessions.set(moduleRef, existing);
  }
  return existing;
}
