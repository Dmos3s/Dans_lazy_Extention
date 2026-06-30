/**
 * Strip control characters from untrusted text and clamp its length.
 *
 * The control-character regex is the security-sensitive part: keeping it in a
 * single shared place means a hardening change can't leave a second copy
 * exploitable. Callers that need single-line output (e.g. classifier fields)
 * pass `collapseWhitespace: true`; callers that preserve formatting (e.g. the
 * planner's multi-line notes) use the default.
 */
export function sanitizeText(value, max = 500, { collapseWhitespace = false } = {}) {
  if (value == null) return '';
  let out = String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, ' ');
  if (collapseWhitespace) {
    out = out.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ');
  }
  return out.trim().slice(0, max);
}
