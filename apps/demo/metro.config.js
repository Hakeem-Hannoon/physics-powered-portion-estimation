const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

// Monorepo: let Metro see the workspace packages and the native module.
config.watchFolders = [path.resolve(__dirname, "../..")];

// Bundle the prebuilt nutrient SQLite database as an asset (require(....sqlite)).
config.resolver.assetExts.push("sqlite");

module.exports = config;
