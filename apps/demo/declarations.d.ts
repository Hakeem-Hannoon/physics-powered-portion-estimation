// Metro bundles the prebuilt nutrient DB as an asset (metro.config.js adds
// "sqlite" to assetExts); require("...sqlite") resolves to an asset module id.
declare module "*.sqlite" {
  const asset: number;
  export default asset;
}
