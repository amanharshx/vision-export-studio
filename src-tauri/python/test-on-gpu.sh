#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# test-on-gpu.sh — validate RF-DETR ONNX / TensorRT export on a
# rented NVIDIA Linux box, using the app's own export helper.
#
# WHAT IT DOES
#   1. Prints environment (OS, python, trtexec, GPU).
#   2. Creates an isolated Python 3.12 venv and installs rfdetr[onnx].
#   3. Runs the helper's inspect + ONNX + TensorRT(engine) routes
#      against your checkpoint and reports EXIT codes + produced artifacts.
#
# USAGE (on the GPU box)
#   chmod +x test-on-gpu.sh
#   ./test-on-gpu.sh /path/to/checkpoint_best_regular.pth 512 2>&1 | tee report.txt
#   # then paste report.txt back
#
# REQUIREMENTS ON THE BOX
#   - Python 3.12 on PATH as `python3.12` (or export PYTHON=/path/to/python3.12)
#   - For the TensorRT route: NVIDIA GPU + TensorRT with `trtexec` on PATH.
#     Easiest: run inside an NVIDIA TensorRT container
#     (e.g. nvcr.io/nvidia/tensorrt:<tag>) which already ships trtexec.
#   - rfdetr_export_helper.py must sit in the SAME directory as this script.
#
# NOTES
#   - A produced .engine is GPU-family-specific; this validates the pipeline,
#     not artifact portability.
# ---------------------------------------------------------------------------
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$SCRIPT_DIR/rfdetr_export_helper.py"

CKPT="${1:-}"
IMGSZ="${2:-512}"
PYTHON="${PYTHON:-python3.12}"
VENV="${VENV:-/tmp/rfdetr-gpu-test-venv}"
OUT_BASE="${OUT_BASE:-/tmp/rfdetr-gpu-test-out}"

line(){ printf '\n========== %s ==========\n' "$1"; }

# --- preflight ---
[ -n "$CKPT" ]   || { echo "ERROR: pass the checkpoint path as argument 1"; exit 2; }
[ -f "$CKPT" ]   || { echo "ERROR: checkpoint not found: $CKPT"; exit 2; }
[ -f "$HELPER" ] || { echo "ERROR: rfdetr_export_helper.py not found next to this script ($HELPER)"; exit 2; }
command -v "$PYTHON" >/dev/null 2>&1 || { echo "ERROR: '$PYTHON' not found. Install Python 3.12 or set PYTHON=/path/to/python3.12"; exit 2; }

line "ENVIRONMENT"
uname -a
"$PYTHON" --version
echo "trtexec : $(command -v trtexec || echo 'NOT FOUND -> TensorRT route will be SKIPPED')"
if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi -L; else echo "nvidia-smi: NOT FOUND (no NVIDIA GPU?)"; fi

# --- venv + deps ---
line "CREATE VENV @ $VENV"
rm -rf "$VENV"
"$PYTHON" -m venv "$VENV"
"$VENV/bin/pip" install --upgrade pip setuptools wheel -q
PY="$VENV/bin/python"

line "INSTALL rfdetr[onnx]>=1.7.1 (required)"
"$VENV/bin/pip" install "rfdetr[onnx]>=1.7.1" -q || { echo "FATAL: rfdetr[onnx] install failed"; exit 1; }

echo "--- key versions ---"
"$VENV/bin/pip" freeze | grep -iE '^(rfdetr|torch|torchvision|onnx|numpy|protobuf)([=<>@ ]|$)' || true

run_route(){
  local route="$1" sub="$2" out="$OUT_BASE/$2"
  rm -rf "$out"; mkdir -p "$out"
  line "ROUTE $route (imgsz=$IMGSZ)"
  "$PY" "$HELPER" export --checkpoint "$CKPT" --route-id "$route" \
        --output-dir "$out" --variant-mode auto --imgsz "$IMGSZ" --batch 1
  local rc=$?
  echo "RESULT: $route -> EXIT $rc $( [ $rc -eq 0 ] && echo '(ok)' || echo '(FAILED)')"
  echo "--- artifacts in $out ---"
  ls -la "$out"
}

# --- inspect ---
line "INSPECT (expect class + recommended_imgsz)"
"$PY" "$HELPER" inspect --checkpoint "$CKPT"

# --- ONNX (baseline) ---
run_route "rfdetr.pth.onnx" onnx

# --- TensorRT engine ---
if command -v trtexec >/dev/null 2>&1; then
  run_route "rfdetr.pth.engine" engine
else
  line "ROUTE rfdetr.pth.engine -> SKIPPED (no trtexec on PATH)"
fi

line "DONE — copy this entire output (report.txt) back"
