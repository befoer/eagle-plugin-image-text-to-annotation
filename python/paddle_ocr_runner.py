from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_ROOT = Path(os.environ.get("EAGLE_PLUGIN_RUNTIME_ROOT") or (PLUGIN_ROOT / ".runtime")).resolve()
DEPS_DIR = RUNTIME_ROOT / "python_deps"

if DEPS_DIR.exists():
  sys.path.insert(0, str(DEPS_DIR))

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("PADDLE_HOME", str(RUNTIME_ROOT / "paddle_home"))
os.environ.setdefault("PADDLEX_HOME", str(RUNTIME_ROOT / "paddlex_home"))
os.environ.setdefault("XDG_CACHE_HOME", str(RUNTIME_ROOT / "cache"))
os.environ.setdefault("HF_HOME", str(RUNTIME_ROOT / "cache" / "huggingface"))


OCR_CACHE: dict[str, object] = {}


def get_paddle_ocr_class():
  try:
    from paddleocr import PaddleOCR  # type: ignore
  except Exception as error:  # noqa: BLE001
    raise RuntimeError("本地 OCR 依赖尚未安装完成，请先在插件中执行一次依赖下载。") from error

  return PaddleOCR


def build_ocr(language: str):
  PaddleOCR = get_paddle_ocr_class()
  key = "eng" if language == "eng" else "ch"
  if key in OCR_CACHE:
    return OCR_CACHE[key]

  common = {
    "use_doc_orientation_classify": False,
    "use_doc_unwarping": False,
    "use_textline_orientation": False,
    "device": "cpu",
    "enable_hpi": False,
    "enable_mkldnn": False,
    "cpu_threads": 4,
    "text_rec_score_thresh": 0.3,
  }

  if key == "eng":
    common["lang"] = "en"
  else:
    common["text_detection_model_name"] = "PP-OCRv5_mobile_det"
    common["text_recognition_model_name"] = "PP-OCRv5_mobile_rec"

  OCR_CACHE[key] = PaddleOCR(**common)
  return OCR_CACHE[key]


def extract_result_payload(result) -> dict:
  payload = getattr(result, "json", None)
  if callable(payload):
    payload = payload()

  if isinstance(payload, str):
    payload = json.loads(payload)

  if isinstance(payload, dict) and "res" in payload:
    payload = payload["res"]

  if not isinstance(payload, dict):
    return {
      "texts": [],
      "scores": [],
      "boxes": [],
    }

  texts = [str(text).strip() for text in payload.get("rec_texts") or [] if str(text).strip()]
  scores = [float(score) for score in payload.get("rec_scores") or [] if isinstance(score, (int, float))]
  boxes = payload.get("dt_polys") or payload.get("rec_boxes") or []

  return {
    "texts": texts,
    "scores": scores,
    "boxes": boxes,
  }


def process_item(ocr: PaddleOCR, item: dict) -> dict:
  item_id = str(item.get("id") or "")
  source_path = str(item.get("path") or "").strip()

  if not source_path:
    return {
      "id": item_id,
      "ok": False,
      "error": "缺少可用的图片路径",
    }

  predictions = list(ocr.predict(source_path))
  all_texts: list[str] = []
  all_scores: list[float] = []
  all_boxes: list = []

  for prediction in predictions:
    payload = extract_result_payload(prediction)
    all_texts.extend(payload["texts"])
    all_scores.extend(payload["scores"])
    all_boxes.extend(payload["boxes"])

  merged_text = "\n".join(text for text in all_texts if text).strip()
  average_score = round(sum(all_scores) / len(all_scores) * 100) if all_scores else None

  return {
    "id": item_id,
    "ok": True,
    "text": merged_text,
    "texts": all_texts,
    "scores": all_scores,
    "averageScore": average_score,
    "boxes": all_boxes,
  }


def main() -> int:
  parser = argparse.ArgumentParser()
  parser.add_argument("--input", required=True)
  parser.add_argument("--output", required=True)
  args = parser.parse_args()

  try:
    with open(args.input, "r", encoding="utf-8") as fp:
      payload = json.load(fp)

    language = str(payload.get("language") or "chi_sim")
    items = payload.get("items") or []
    ocr = build_ocr(language)
    results = [process_item(ocr, item) for item in items]

    output = {
      "ok": True,
      "language": language,
      "items": results,
    }

    with open(args.output, "w", encoding="utf-8") as fp:
      json.dump(output, fp, ensure_ascii=False)

    return 0
  except Exception as error:
    output = {
      "ok": False,
      "error": str(error),
      "traceback": traceback.format_exc(),
    }
    with open(args.output, "w", encoding="utf-8") as fp:
      json.dump(output, fp, ensure_ascii=False)
    return 1


if __name__ == "__main__":
  raise SystemExit(main())
