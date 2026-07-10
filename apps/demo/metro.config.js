const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

// Monorepo: let Metro see the workspace packages and the native module.
config.watchFolders = [path.resolve(__dirname, "../..")];

// Bundle the prebuilt nutrient SQLite database and the on-device ONNX model
// weights as assets (require("....sqlite") / require("....onnx")).
config.resolver.assetExts.push("sqlite", "onnx", "ort");

module.exports = config;
