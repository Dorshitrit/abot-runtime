/** Host-side observed-text protection before delivery, projection and transport.
 * Command capture may temporarily retain unchecked bytes in private local files.
 * Version 1 covers text and metadata; images are withheld when their associated
 * text is suspect. It does not assert OCR or pixel-content inspection.
 */
export const HOST_SECRET_PROTECTION_CAPABILITY = "host_secret_protection_v1";
