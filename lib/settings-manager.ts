/**
 * Pi settings-manager helpers
 * Zones: pi agent sdk boundary, shared adapters
 * Owns the SDK-free settings-manager contract and the scoped-model-pattern
 * persister. It lives outside `pi.ts` so the daemon composition can persist
 * scoped models without loading the Pi SDK runtime.
 */

export interface PiSettingsManager {
  reload: () => Promise<void>;
  flush: () => Promise<void>;
  getEnabledModels: () => string[] | undefined;
  setEnabledModels: (patterns: string[] | undefined) => void;
}

export function createScopedModelPatternPersister<
  TContext extends { cwd: string },
>(deps: {
  createSettingsManager: (
    cwd: string,
  ) => PiSettingsManager | PromiseLike<PiSettingsManager>;
  clearCachedModelMenuInputs: () => void;
}): (patterns: string[], ctx: TContext) => Promise<void> {
  return async (patterns, ctx) => {
    const settingsManager = await deps.createSettingsManager(ctx.cwd);
    settingsManager.setEnabledModels(
      patterns.length > 0 ? patterns : undefined,
    );
    await settingsManager.flush();
    deps.clearCachedModelMenuInputs();
  };
}
