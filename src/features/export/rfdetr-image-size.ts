export const RFDETR_IMGSZ_MIN = 64;
export const RFDETR_IMGSZ_MAX = 8192;

/** Standard presets offered as an explicit fallback when native size is unknown. */
export const RFDETR_FALLBACK_PRESETS = [384, 512, 560, 576, 640, 704, 768];

/**
 * Synchronous RF-DETR image-size validation. Returns an error string when
 * invalid, else null. No async probe; callers disable export on error and
 * never substitute a different size.
 */
export function validateRfDetrImgsz(
  imgsz: number,
  requiredMultiple?: number | null,
): string | null {
  if (!Number.isInteger(imgsz)) return "Image size must be an integer.";
  if (imgsz < RFDETR_IMGSZ_MIN || imgsz > RFDETR_IMGSZ_MAX) {
    return `Image size must be between ${RFDETR_IMGSZ_MIN} and ${RFDETR_IMGSZ_MAX}.`;
  }
  if (
    requiredMultiple != null &&
    requiredMultiple > 0 &&
    imgsz % requiredMultiple !== 0
  ) {
    return `Image size must be divisible by ${requiredMultiple}.`;
  }
  return null;
}

/**
 * Pick a standard preset divisible by the known block size to offer as an
 * explicit fallback. Returns null when constraints are unknown or no preset
 * fits; callers must label it as a fallback, never as a detected native size.
 */
export function getRfDetrFallbackImgsz(
  requiredMultiple?: number | null,
): number | null {
  if (requiredMultiple == null || requiredMultiple <= 0) return null;
  for (const preset of RFDETR_FALLBACK_PRESETS) {
    if (preset % requiredMultiple === 0) return preset;
  }
  return null;
}
