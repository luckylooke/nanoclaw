/**
 * The barrel overlays append their gateway provider's registration to — one
 * appended `import './x.js';` and one `registerGatewayProvider(...)` call in the
 * imported file, the same shape as the driver barrel (`drivers/installed.ts`)
 * and the provider container-config barrel. Nothing outside this directory is
 * rewritten to install a gateway.
 *
 * This fork installs the native credential proxy and NOT upstream's OneCLI
 * provider. That is the reason the fork exists: OneCLI is a third party on the
 * credential path. See spec/fork-features.yaml, feature `credential-proxy`,
 * whose invariant fails the build if upstream's OneCLI provider is ever
 * re-registered anywhere in the tree.
 */
import './credential-proxy.js';
