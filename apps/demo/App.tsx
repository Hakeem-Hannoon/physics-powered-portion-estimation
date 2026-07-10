import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import * as PortionCapture from "expo-portion-capture";
import {
  type EstimateResult,
  estimateMeal,
  relabelItem,
  withEditedItem,
} from "@ppe/pipeline";
import { ExpoSqliteNutrientStore } from "./src/nutrient-store";
import { FOOD_ALIASES, STARTER_FOODS } from "./src/foods";
import { type VisionDeps, loadVisionDeps } from "./src/vision-adapters";

/**
 * End-to-end demo: capture a meal (AR ruler → metric scale) → SlimSAM segments the
 * food → MobileCLIP classifies it → the metric geometry weighs it → real USDA
 * nutrition. Everything on-device. The label is *predicted*, not picked; tap a
 * chip to correct it (propose→confirm), which re-derives nutrition from the same
 * measured volume.
 */
export default function App() {
  const [vision, setVision] = useState<VisionDeps | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [result, setResult] = useState<EstimateResult | null>(null);
  const [status, setStatus] = useState("Loading on-device models…");
  const [busy, setBusy] = useState(false);

  const nutrients = useRef(new ExpoSqliteNutrientStore(FOOD_ALIASES));

  // Load the ~80 MB of ONNX models once on startup.
  useEffect(() => {
    let alive = true;
    loadVisionDeps()
      .then((v) => {
        if (!alive) return;
        setVision(v);
        setStatus("Ready — capture a meal to classify + weigh it");
      })
      .catch((e) => {
        if (!alive) return;
        setLoadError(e instanceof Error ? e.message : String(e));
        setStatus("Model load failed");
      });
    return () => {
      alive = false;
    };
  }, []);

  const deps = useMemo(
    () =>
      vision
        ? { segmenter: vision.segmenter, classifier: vision.classifier, nutrients: nutrients.current }
        : null,
    [vision],
  );

  const capture = async () => {
    if (!deps) return;
    if (!PortionCapture.isSupported()) {
      setStatus("ARKit/ARCore unavailable — use a development build on a real device");
      return;
    }
    setBusy(true);
    setResult(null);
    setStatus("Capturing…");
    try {
      const payload = await PortionCapture.launch({ requireStroke: true });
      if (!payload) {
        setStatus("Cancelled");
        return;
      }
      setStatus("Segmenting → classifying → weighing…");
      const r = await estimateMeal(payload, deps);
      setResult(r);
      const first = r.items[0];
      setStatus(
        first
          ? `Predicted “${first.label}” — ±${Math.round(r.quality.est_relative_error * 100)}%`
          : "No food region found — try again, food centered",
      );
    } catch (error) {
      setStatus(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  // Propose→confirm: correct the predicted label. Re-derives mass + nutrition from
  // the new food applied to the SAME measured volume (tested edit helpers).
  const relabel = async (index: number, label: string) => {
    if (!result) return;
    const record = await nutrients.current.lookup(label);
    setResult(withEditedItem(result, index, relabelItem(result.items[index]!, record, label)));
  };

  const pct = (x: number) => `${Math.round(x * 100)}%`;

  return (
    <View style={styles.container}>
      <StatusBar style="auto" />
      <Text style={styles.title}>Physics-Powered Portion Estimation</Text>
      <Text style={styles.subtitle}>{status}</Text>

      {!vision && !loadError && (
        <View style={styles.loading}>
          <ActivityIndicator />
          <Text style={styles.muted}>Loading MobileCLIP + SlimSAM (~80 MB)…</Text>
        </View>
      )}

      {loadError && (
        <View style={[styles.card, styles.errorCard]}>
          <Text style={styles.label}>Couldn’t load the models</Text>
          <Text style={styles.muted}>{loadError}</Text>
          <Text style={styles.muted}>
            Run `npm run build:models`, then rebuild the dev client
            (`npx expo run:android` / `run:ios`).
          </Text>
        </View>
      )}

      <View style={styles.captureRow}>
        <Pressable
          onPress={capture}
          disabled={!vision || busy}
          style={[styles.button, (!vision || busy) && styles.buttonDisabled]}>
          <Text style={styles.buttonText}>{busy ? "Working…" : "Capture a meal"}</Text>
        </Pressable>
      </View>

      {result && (
        <ScrollView style={styles.results}>
          {result.items.map((item, i) => (
            <View key={i} style={styles.card}>
              <View style={styles.rowBetween}>
                <Text style={styles.label}>{item.label}</Text>
                <Text style={styles.muted}>{pct(item.confidence)} conf</Text>
              </View>
              <Text style={styles.muted}>
                {item.geometry.area_cm2} cm² · {item.geometry.volume_ml} mL · {item.geometry.method}
              </Text>
              <Text style={styles.mass}>
                {item.mass_g ?? "?"} g · {item.kcal ?? "?"} kcal
              </Text>
              <Text style={styles.muted}>
                P {item.protein_g ?? "?"} · C {item.carbs_g ?? "?"} · F {item.fat_g ?? "?"}
              </Text>
              {item.flags.length > 0 && (
                <Text style={styles.flags}>⚑ {item.flags.join(", ")}</Text>
              )}
              <Text style={styles.correct}>Not right? Correct the label:</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {STARTER_FOODS.map((label) => (
                  <Pressable key={label} onPress={() => relabel(i, label)} style={styles.chip}>
                    <Text style={styles.chipText}>{label.split(",")[0]}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ))}

          <View style={styles.card}>
            <Text style={styles.label}>Meal total</Text>
            <Text style={styles.mass}>
              {result.totals.kcal} kcal · P {result.totals.protein_g} · C {result.totals.carbs_g} ·
              F {result.totals.fat_g}
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.label}>Quality</Text>
            <Text style={styles.muted}>scale: {result.quality.scale_source}</Text>
            <Text style={styles.muted}>
              ruler residual: {result.quality.ruler_residual_mm ?? "—"} mm
            </Text>
            <Text style={styles.muted}>
              estimated error: ±{pct(result.quality.est_relative_error)}
            </Text>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 80, paddingHorizontal: 20, gap: 12 },
  title: { fontSize: 20, fontWeight: "600" },
  subtitle: { color: "#666" },
  muted: { color: "#666", fontSize: 13 },
  loading: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  captureRow: { marginTop: 4 },
  button: {
    backgroundColor: "#111",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  buttonDisabled: { backgroundColor: "#bbb" },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 16 },
  results: { marginTop: 8 },
  card: {
    padding: 12,
    borderRadius: 10,
    backgroundColor: "#f2f2f2",
    marginBottom: 10,
    gap: 4,
  },
  errorCard: { backgroundColor: "#fdecec" },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  label: { fontWeight: "700", fontSize: 16 },
  mass: { fontWeight: "600", fontSize: 15 },
  flags: { color: "#a15c00", fontSize: 12 },
  correct: { marginTop: 6, fontSize: 12, color: "#888" },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: "#e2e2e2",
    marginRight: 8,
    marginTop: 4,
  },
  chipText: { color: "#333", fontWeight: "500", fontSize: 13 },
});
