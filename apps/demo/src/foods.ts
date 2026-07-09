import type { Classifier, ClassifierResult, Region } from "@ppe/pipeline";

/**
 * The foods in the starter bundle (apps/demo/assets/nutrients.sqlite). Until the
 * on-device classifier (MobileCLIP) is wired — see vision-adapters.ts — the demo
 * lets the user pick which of these the plate is, so the estimate uses REAL USDA
 * nutrition for the REAL measured portion. These strings are the exact bundle
 * descriptions, so the store resolves them by exact match.
 */
export const STARTER_FOODS: string[] = [
  "Rice, white, cooked",
  "Chicken breast, cooked, roasted",
  "Broccoli, cooked, boiled",
  "Egg, whole, cooked, hard-boiled",
  "Salmon, Atlantic, cooked",
  "Pasta, cooked, enriched",
  "Potato, baked, flesh and skin",
  "Ground beef, 85% lean, cooked",
  "Banana, raw",
  "Apple, raw, with skin",
  "Almonds, raw",
  "Bread, white, commercial",
];

/**
 * Terse classifier label → bundle description. A real MobileCLIP head emits short
 * labels ("rice", "chicken"); this is the curated map the NutrientStore uses to
 * resolve them (STATUS.md's "quality-critical data artifact"). Extend it as the
 * food vocabulary grows.
 */
export const FOOD_ALIASES: Record<string, string> = {
  rice: "Rice, white, cooked",
  "white rice": "Rice, white, cooked",
  "white rice, cooked": "Rice, white, cooked",
  chicken: "Chicken breast, cooked, roasted",
  "chicken breast": "Chicken breast, cooked, roasted",
  broccoli: "Broccoli, cooked, boiled",
  egg: "Egg, whole, cooked, hard-boiled",
  eggs: "Egg, whole, cooked, hard-boiled",
  salmon: "Salmon, Atlantic, cooked",
  pasta: "Pasta, cooked, enriched",
  spaghetti: "Pasta, cooked, enriched",
  noodles: "Pasta, cooked, enriched",
  potato: "Potato, baked, flesh and skin",
  "baked potato": "Potato, baked, flesh and skin",
  beef: "Ground beef, 85% lean, cooked",
  "ground beef": "Ground beef, 85% lean, cooked",
  hamburger: "Ground beef, 85% lean, cooked",
  banana: "Banana, raw",
  apple: "Apple, raw, with skin",
  almonds: "Almonds, raw",
  almond: "Almonds, raw",
  bread: "Bread, white, commercial",
  toast: "Bread, white, commercial",
};

/**
 * A `Classifier` whose answer is whatever the UI currently has selected — the
 * interim stand-in for the on-device model. Real geometry + real nutrition; the
 * label is user-confirmed rather than predicted. Swap for `ZeroShotClipClassifier`
 * (vision-adapters.ts) once the MobileCLIP model is bundled.
 */
export class SelectedClassifier implements Classifier {
  constructor(private label: string) {}
  setLabel(label: string): void {
    this.label = label;
  }
  classify(_imageUri: string, _region: Region): Promise<ClassifierResult> {
    return Promise.resolve({ label: this.label, confidence: 1 });
  }
}
