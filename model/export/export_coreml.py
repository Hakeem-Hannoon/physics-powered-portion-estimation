"""Export a trained model to Core ML (.mlpackage, fp16) for the iOS app.

Handles the two artifacts this repo trains:
  segformer  — train/segformer_foodseg103.py checkpoints (HF directory)
  regressor  — train/mass_regressor_nutrition5k.py checkpoints (.pt)

Already-converted models this project uses as-is need no export here:
apple/coreml-mobileclip, apple/coreml-sam2.1-tiny,
apple/coreml-depth-anything-v2-small (see docs/MODELS.md).

    python export/export_coreml.py segformer --checkpoint out/segformer-b0-food --out out/FoodSeg.mlpackage
    python export/export_coreml.py regressor --checkpoint out/mass-regressor.pt --out out/MassRegressor.mlpackage
"""

from __future__ import annotations

import argparse

import coremltools as ct
import torch


def export_segformer(checkpoint: str, out: str, size: int) -> None:
    from transformers import SegformerConfig, SegformerForSemanticSegmentation

    # torchscript=True makes the model traceable (tuple outputs, no attention
    # dicts). Current transformers no longer accepts it as a from_pretrained
    # kwarg — it forwards unknown kwargs to __init__, which rejects it — so set
    # it on the config instead.
    config = SegformerConfig.from_pretrained(checkpoint)
    config.torchscript = True
    model = SegformerForSemanticSegmentation.from_pretrained(checkpoint, config=config)
    model.eval()

    class Wrapper(torch.nn.Module):
        def __init__(self, inner):
            super().__init__()
            self.inner = inner

        def forward(self, pixel_values):
            return self.inner(pixel_values=pixel_values)[0]

    traced = torch.jit.trace(Wrapper(model), torch.rand(1, 3, size, size))
    ml = ct.convert(
        traced,
        inputs=[ct.ImageType(name="image", shape=(1, 3, size, size), scale=1 / 255.0)],
        minimum_deployment_target=ct.target.iOS16,
        compute_precision=ct.precision.FLOAT16,
        convert_to="mlprogram",
    )
    ml.save(out)


def export_regressor(checkpoint: str, out: str, size: int | None) -> None:
    import sys
    from pathlib import Path

    sys.path.append(str(Path(__file__).resolve().parent.parent / "train"))
    from mass_regressor_nutrition5k import COND_DIM, load_checkpoint

    # Reconstruct from the checkpoint's own config (backbone, anchor,
    # normalization mode) — never from this script's defaults, which could
    # silently diverge from how the weights were trained.
    model, saved = load_checkpoint(checkpoint)
    size = size or int(saved.get("image_size", 256))

    traced = torch.jit.trace(
        model, (torch.rand(1, 3, size, size), torch.rand(1, COND_DIM))
    )
    ml = ct.convert(
        traced,
        inputs=[
            ct.ImageType(name="crop", shape=(1, 3, size, size), scale=1 / 255.0),
            ct.TensorType(name="physics", shape=(1, COND_DIM)),
        ],
        minimum_deployment_target=ct.target.iOS16,
        compute_precision=ct.precision.FLOAT16,
        convert_to="mlprogram",
    )
    ml.save(out)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=["segformer", "regressor"])
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--size", type=int, default=None)
    args = parser.parse_args()

    if args.kind == "segformer":
        export_segformer(args.checkpoint, args.out, args.size or 512)
    else:
        export_regressor(args.checkpoint, args.out, args.size)
    print(f"saved {args.out}")


if __name__ == "__main__":
    main()
