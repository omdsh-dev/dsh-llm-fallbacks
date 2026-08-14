/**
 * release-version.ts — shared release-version constants for the release
 * scripts (prepare-release.ts and validate-release-version.ts). Single home
 * for the semver contract so the two scripts cannot drift apart.
 */

/** Architect-approved loose semver: numeric core, optional prerelease suffix. */
export const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
