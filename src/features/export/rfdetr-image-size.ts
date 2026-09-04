export const RFDETR_IMGSZ_MIN = 64;
export const RFDETR_IMGSZ_MAX = 8192;

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
