// fingerprint.mjs — deterministic content fingerprint (versioned format contract).
//
// fingerprint(content) = "sha256:" + sha256hex(normalize(content))
// normalize (v1)       = CRLF -> LF, so Windows checkouts fingerprint identically
//                        to unix checkouts (design section 4.5).
// Changing normalize() flips every fingerprint in the wild: it is a MAJOR
// version change of the file-format contract, never a patch.
import { createHash } from 'node:crypto';

export { FINGERPRINT_VERSION } from './errors.mjs';

// v1 normalization: CRLF -> LF. Nothing else — no trim, no NFC, no BOM strip.
export function normalize(content) {
  return content == null ? '' : String(content).replace(/\r\n/g, '\n');
}

export function fingerprint(contentString) {
  return 'sha256:' + createHash('sha256').update(normalize(contentString), 'utf8').digest('hex');
}
