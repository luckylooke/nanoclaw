/**
 * SEC-M8 (feature `sec-m8-package-validation`): package names come from the DB
 * (an agent asks for them through install_packages) and buildAgentGroupImage
 * interpolates them into a generated Dockerfile's RUN lines and builds it, so a
 * name like `curl; rm -rf /` is a shell-injection vector. Names are checked
 * against the apt and npm grammars and the build is refused on the first one
 * that does not fit. Called from buildAgentGroupImage (EXT-SEAM line).
 */
const APT_PKG_RE = /^[a-z0-9][a-z0-9_.+:-]*$/;
const NPM_PKG_RE = /^(?:@[a-z0-9_-]+\/)?[a-z0-9][a-z0-9_.+-]*(?:@[a-z0-9._~^<>=*|-]+)?$/;

export function assertSafePackages(apt: string[], npm: string[]): void {
  for (const p of apt) {
    if (!APT_PKG_RE.test(p)) throw new Error('Invalid apt package name rejected: ' + JSON.stringify(p));
  }
  for (const p of npm) {
    if (!NPM_PKG_RE.test(p)) throw new Error('Invalid npm package name rejected: ' + JSON.stringify(p));
  }
}
