"""Export trained models to ONNX for `onnxruntime-react-native` — the demo
app's runtime (docs/REAL_ADAPTERS.md). One cross-platform artifact per model,
same as the MobileCLIP/SlimSAM weights the app already ships.

Handles the two artifacts this repo trains:

  regressor — train/mass_regressor_nutrition5k.py checkpoint (.pt) →
      inputs   crop     float32 [1, 3, S, S]   RGB in [0, 1] (S from the checkpoint)
               physics  float32 [1, 8]         [log(area_m2), height_m (or −1),
                                                has_height, one-hot(scale_source)[5]]
      output   log_mass_kcal float32 [1, 2]    [log(mass_g), log(kcal)]

  segformer — train/segformer_foodseg103.py checkpoint (HF directory) →
      input    image  float32 [1, 3, 512, 512] RGB in [0, 1]
      output   logits float32 [1, 104, 128, 128]

Both graphs carry their own preprocessing (pixel normalization, conditioning
standardization) — the app feeds plain [0, 1] pixels and raw physical units,
so the JS side can never drift out of sync with how the weights were trained.

    python export/export_onnx.py regressor --checkpoint out/mass-regressor.pt --out out/mass-regressor.onnx
    python export/export_onnx.py segformer --checkpoint out/segformer-b0-food --out out/foodseg.onnx
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import torch

sys.path.append(str(Path(__file__).resolve().parent.parent / "train"))

IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


def export_regressor(checkpoint: str, out: str, size: int | None) -> None:
    from mass_regressor_nutrition5k import COND_DIM, load_checkpoint

    # Reconstruct from the checkpoint's own config — never from this script's
    # defaults, which could silently diverge from how the weights were trained.
    model, saved = load_checkpoint(checkpoint)
    size = size or int(saved.get("image_size", 256))
    torch.onnx.export(
        model,
        (torch.rand(1, 3, size, size), torch.rand(1, COND_DIM)),
        out,
        input_names=["crop", "physics"],
        output_names=["log_mass_kcal"],
        opset_version=17,
    )


def export_segformer(checkpoint: str, out: str, size: int | None) -> None:
    from transformers import SegformerConfig, SegformerForSemanticSegmentation

    size = size or 512
    config = SegformerConfig.from_pretrained(checkpoint)
    config.torchscript = True
    inner = SegformerForSemanticSegmentation.from_pretrained(checkpoint, config=config)
    inner.eval()
    # Bake the processor's normalization into the graph so the app-side
    # contract is the same "[0, 1] pixels" as every other shipped model.
    try:
        from transformers import SegformerImageProcessor

        proc = SegformerImageProcessor.from_pretrained(checkpoint)
        mean, std = tuple(proc.image_mean), tuple(proc.image_std)
    except Exception:
        mean, std = IMAGENET_MEAN, IMAGENET_STD

    class Wrapper(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.inner = inner
            self.register_buffer("mean", torch.tensor(mean).view(1, 3, 1, 1))
            self.register_buffer("std", torch.tensor(std).view(1, 3, 1, 1))

        def forward(self, image: torch.Tensor) -> torch.Tensor:
            return self.inner(pixel_values=(image - self.mean) / self.std)[0]

    torch.onnx.export(
        Wrapper(),
        torch.rand(1, 3, size, size),
        out,
        input_names=["image"],
        output_names=["logits"],
        opset_version=17,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=["segformer", "regressor"])
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--size", type=int, default=None)
    args = parser.parse_args()

    if args.kind == "segformer":
        export_segformer(args.checkpoint, args.out, args.size)
    else:
        export_regressor(args.checkpoint, args.out, args.size)
    print(f"saved {args.out}")


if __name__ == "__main__":
    main()
