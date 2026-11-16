/**
 * Single source of truth for the JWT signing/verification secret.
 *
 * In production we refuse to fall back to a weak, source-visible default — if
 * JWT_SECRET is missing the app throws on boot rather than silently signing
 * tokens with a guessable key that would let anyone forge an admin session.
 * A configured secret is always used as-is (never rejected) so a running
 * deployment can't be taken down by this check; a short one only warns.
 * In development a fixed 'dev-secret' keeps the local flow friction-free.
 */
export function jwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (s && s.trim().length > 0) {
    if (s.length < 16) {
      // eslint-disable-next-line no-console
      console.warn(
        '[auth] JWT_SECRET is shorter than 16 chars — consider a stronger ' +
          'value (e.g. `openssl rand -hex 48`).',
      );
    }
    return s;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'JWT_SECRET is not set in production. Refusing to start with an ' +
        'insecure default signing key — set a strong JWT_SECRET ' +
        '(e.g. `openssl rand -hex 48`) in the environment.',
    );
  }
  return 'dev-secret';
}
