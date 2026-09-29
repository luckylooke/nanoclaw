import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  adopted: false,
  approvalReady: false,
  releaseAdoption: undefined as (() => void) | undefined,
  proxyListening: false,
  routeInbound: vi.fn(),
  startChannels: vi.fn(),
  ready: vi.fn(),
}));
vi.mock('./backfill-container-configs.js', () => ({ backfillContainerConfigs: vi.fn() }));
// Fork: main() also reads the credential-proxy bind address and starts the proxy before the adapters.
vi.mock('./config.js', () => ({
  CENTRAL_DB_PATH: ':memory:',
  DATA_DIR: '/tmp',
  CREDENTIAL_PROXY_PORT: 0,
  CREDENTIAL_PROXY_HOST: '127.0.0.1',
}));
// It must be listening before anything that can spawn a container — the
// adapters and the sweep — or a first message would launch an agent whose
// ANTHROPIC_BASE_URL points at nothing.
vi.mock('./credential-proxy.js', () => ({
  startCredentialProxy: async () => {
    state.proxyListening = true;
    return { close: vi.fn() };
  },
}));
vi.mock('./circuit-breaker.js', () => ({ enforceStartupBackoff: vi.fn(), resetCircuitBreaker: vi.fn() }));
vi.mock('./upgrade-state.js', () => ({ enforceUpgradeTripwire: vi.fn() }));
vi.mock('./db/connection.js', () => ({ initDb: async () => ({ dialect: 'sqlite' }), closeDb: vi.fn() }));
vi.mock('./db/migrations/index.js', () => ({ runMigrations: vi.fn() }));
vi.mock('./drivers/index.js', () => ({ getSessionDriver: () => ({ ensureReady: vi.fn() }) }));
vi.mock('./container-runner.js', () => ({
  adoptRunningSessions: async () => {
    expect(state.approvalReady).toBe(true);
    await new Promise<void>((resolve) => {
      state.releaseAdoption = resolve;
    });
    state.adopted = true;
  },
  abortGatewaySessionObservers: vi.fn(),
  resumeGatewaySessionAdmission: vi.fn(),
  stopGatewaySessionsForUnavailability: vi.fn(),
}));
vi.mock('./host-instance.js', () => ({ startHostInstanceLease: vi.fn(), stopHostInstanceLease: vi.fn() }));
vi.mock('./gateway-providers/index.js', () => ({ getGatewayProvider: () => ({}), resetGatewayProvider: vi.fn() }));
vi.mock('./gateway-availability.js', () => ({
  startGatewayAvailabilityMonitor: async () => {
    expect(state.approvalReady).toBe(true);
  },
}));
vi.mock('./gateway-approval-coordinator.js', () => ({
  startGatewayApprovalCoordinator: async (
    _provider: unknown,
    _delivery: unknown,
    _unavailable: unknown,
    options: { waitUntilReady?: boolean },
  ) => {
    expect(options.waitUntilReady).toBe(true);
    state.approvalReady = true;
  },
  stopGatewayApprovalCoordinator: vi.fn(),
}));
vi.mock('./delivery.js', () => ({
  startActiveDeliveryPoll: vi.fn(),
  startSweepDeliveryPoll: vi.fn(),
  setDeliveryAdapter: vi.fn(),
  stopDeliveryPolls: vi.fn(),
}));
vi.mock('./host-sweep.js', () => ({ startHostSweep: vi.fn(), stopHostSweep: vi.fn() }));
vi.mock('./host-lifecycle.js', () => ({ startHostModules: vi.fn(), stopHostModules: vi.fn() }));
vi.mock('./router.js', () => ({ routeInbound: state.routeInbound }));
vi.mock('./response-registry.js', () => ({ getResponseHandlers: () => [] }));
vi.mock('./channels/index.js', () => ({}));
vi.mock('./modules/index.js', () => ({}));
vi.mock('./cli/commands/index.js', () => ({}));
vi.mock('./cli/delivery-action.js', () => ({}));
vi.mock('./cli/socket-server.js', () => ({ startCliServer: state.ready, stopCliServer: vi.fn() }));
vi.mock('./log.js', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), fatal: vi.fn() } }));
vi.mock('./channels/channel-registry.js', () => ({
  createChannelDeliveryAdapter: () => ({}),
  teardownChannelAdapters: vi.fn(),
  initChannelAdapters: state.startChannels,
}));

afterEach(() => vi.restoreAllMocks());

it('finishes adoption before a channel can route its first inbound message', async () => {
  vi.spyOn(process, 'on').mockReturnValue(process);
  state.routeInbound.mockImplementation(async () => {
    expect(state.adopted).toBe(true);
  });
  state.startChannels.mockImplementation(async (setup) => {
    expect(state.proxyListening).toBe(true);
    setup({ channelType: 'fixture' }).onInbound('chat', null, {
      id: 'message',
      kind: 'text',
      content: 'hello',
      timestamp: new Date().toISOString(),
    });
  });
  await import('./index.js');
  await vi.waitFor(() => expect(state.releaseAdoption).toBeDefined());
  expect(state.routeInbound).not.toHaveBeenCalled();
  state.releaseAdoption!();
  await vi.waitFor(() => expect(state.ready).toHaveBeenCalled());
  expect(state.routeInbound).toHaveBeenCalledOnce();
});
