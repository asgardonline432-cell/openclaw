import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  isConfiguredAwsSdkAuthProfileForProvider,
  resolveAuthProfileOrder,
} from "../auth-profiles/order.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  hasAnyAuthProfileStoreSource,
} from "../auth-profiles/store.js";
import { isProfileInCooldown } from "../auth-profiles/usage.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";

const sessionStoreRuntimeLoader = createLazyImportLoader(
  () => import("../../config/sessions/store.runtime.js"),
);

export type ResolvedSessionAuthProfileOverride = {
  authProfileId?: string;
  authProfileOrder?: string[];
  authStore?: ReturnType<typeof ensureAuthProfileStore>;
};

function loadSessionStoreRuntime() {
  return sessionStoreRuntimeLoader.load();
}

function isProfileForProvider(params: {
  cfg: OpenClawConfig;
  providers: readonly string[];
  profileId: string;
  store: ReturnType<typeof ensureAuthProfileStore>;
}): boolean {
  const providerKeys = params.providers.map((provider) =>
    resolveProviderIdForAuth(provider, { config: params.cfg }),
  );
  const entry = params.store.profiles[params.profileId];
  if (entry) {
    if (!entry.provider) {
      return false;
    }
    const profileProviderKey = resolveProviderIdForAuth(entry.provider, { config: params.cfg });
    return providerKeys.includes(profileProviderKey);
  }
  return params.providers.some((provider) =>
    isConfiguredAwsSdkAuthProfileForProvider({
      cfg: params.cfg,
      provider,
      profileId: params.profileId,
    }),
  );
}

function uniqueProviders(provider: string, acceptedProviderIds?: readonly string[]): string[] {
  const providers = new Set<string>();
  const push = (value: string | undefined) => {
    const normalized = value?.trim();
    if (normalized) {
      providers.add(normalized);
    }
  };
  const candidates =
    acceptedProviderIds && acceptedProviderIds.length > 0 ? acceptedProviderIds : [provider];
  candidates.forEach(push);
  return [...providers];
}

export async function clearSessionAuthProfileOverride(params: {
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
}) {
  const { sessionEntry, sessionStore, sessionKey, storePath } = params;
  delete sessionEntry.authProfileOverride;
  delete sessionEntry.authProfileOverrideSource;
  delete sessionEntry.authProfileOverrideCompactionCount;
  sessionEntry.updatedAt = Date.now();
  sessionStore[sessionKey] = sessionEntry;
  if (storePath) {
    await (
      await loadSessionStoreRuntime()
    ).updateSessionStore(storePath, (store) => {
      store[sessionKey] = sessionEntry;
    });
  }
}

export async function resolveSessionAuthProfileOverrideState(params: {
  cfg: OpenClawConfig;
  provider: string;
  agentDir: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  isNewSession: boolean;
  acceptedProviderIds?: string[];
}): Promise<ResolvedSessionAuthProfileOverride> {
  const {
    cfg,
    provider,
    agentDir,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    isNewSession,
  } = params;
  if (!sessionEntry || !sessionStore || !sessionKey) {
    return { authProfileId: sessionEntry?.authProfileOverride };
  }

  const hasConfiguredAuthProfiles =
    Boolean(params.cfg.auth?.profiles && Object.keys(params.cfg.auth.profiles).length > 0) ||
    Boolean(params.cfg.auth?.order && Object.keys(params.cfg.auth.order).length > 0);
  if (
    !sessionEntry.authProfileOverride?.trim() &&
    !hasConfiguredAuthProfiles &&
    !hasAnyAuthProfileStoreSource(agentDir)
  ) {
    return {};
  }

  const providers = uniqueProviders(provider, params.acceptedProviderIds);
  const baseStore = ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
    allowKeychainPrompt: false,
  });
  let store = baseStore;
  const order = [
    ...new Set(
      providers.flatMap((candidateProvider) =>
        resolveAuthProfileOrder({ cfg, store, provider: candidateProvider }),
      ),
    ),
  ];
  let resolvedOrder = order;
  let current = sessionEntry.authProfileOverride?.trim();
  if ((current && !store.profiles[current]) || resolvedOrder.length === 0) {
    const externalStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
    const externalOrder = [
      ...new Set(
        providers.flatMap((candidateProvider) =>
          resolveAuthProfileOrder({ cfg, store: externalStore, provider: candidateProvider }),
        ),
      ),
    ];
    if ((current && externalStore.profiles[current]) || externalOrder.length > 0) {
      store = externalStore;
      resolvedOrder = externalOrder;
    }
  }
  const source =
    sessionEntry.authProfileOverrideSource ??
    (typeof sessionEntry.authProfileOverrideCompactionCount === "number"
      ? "auto"
      : current
        ? "user"
        : undefined);

  const currentProfileId = current;
  if (
    currentProfileId &&
    !store.profiles[currentProfileId] &&
    !providers.some((candidateProvider) =>
      isConfiguredAwsSdkAuthProfileForProvider({
        cfg,
        provider: candidateProvider,
        profileId: currentProfileId,
      }),
    )
  ) {
    await clearSessionAuthProfileOverride({ sessionEntry, sessionStore, sessionKey, storePath });
    current = undefined;
  }

  if (current && !isProfileForProvider({ cfg, providers, profileId: current, store })) {
    await clearSessionAuthProfileOverride({ sessionEntry, sessionStore, sessionKey, storePath });
    current = undefined;
  }

  // Explicit user picks should survive provider rotation order changes.
  if (current && resolvedOrder.length > 0 && !resolvedOrder.includes(current) && source !== "user") {
    await clearSessionAuthProfileOverride({ sessionEntry, sessionStore, sessionKey, storePath });
    current = undefined;
  }

  if (resolvedOrder.length === 0) {
    return { authProfileOrder: [], authStore: store };
  }

  const pickFirstAvailable = () =>
    resolvedOrder.find((profileId) => !isProfileInCooldown(store, profileId)) ?? resolvedOrder[0];
  const pickNextAvailable = (active: string) => {
    const startIndex = resolvedOrder.indexOf(active);
    if (startIndex < 0) {
      return pickFirstAvailable();
    }
    for (let offset = 1; offset <= resolvedOrder.length; offset += 1) {
      const candidate = resolvedOrder[(startIndex + offset) % resolvedOrder.length];
      if (!isProfileInCooldown(store, candidate)) {
        return candidate;
      }
    }
    return resolvedOrder[startIndex] ?? resolvedOrder[0];
  };

  const compactionCount = sessionEntry.compactionCount ?? 0;
  const storedCompaction =
    typeof sessionEntry.authProfileOverrideCompactionCount === "number"
      ? sessionEntry.authProfileOverrideCompactionCount
      : compactionCount;
  const replacementForUnusableCurrent =
    current && isProfileInCooldown(store, current)
      ? resolvedOrder.find(
          (profileId) => profileId !== current && !isProfileInCooldown(store, profileId),
        )
      : undefined;
  if (replacementForUnusableCurrent) {
    current = undefined;
  }
  if (source === "user" && current && !isNewSession) {
    return { authProfileId: current, authProfileOrder: resolvedOrder, authStore: store };
  }

  let next = current;
  if (replacementForUnusableCurrent) {
    next = replacementForUnusableCurrent;
  } else if (isNewSession) {
    next = current ? pickNextAvailable(current) : pickFirstAvailable();
  } else if (current && compactionCount > storedCompaction) {
    next = pickNextAvailable(current);
  } else if (!current || isProfileInCooldown(store, current)) {
    next = pickFirstAvailable();
  }

  if (!next) {
    return { authProfileId: current, authProfileOrder: resolvedOrder, authStore: store };
  }
  const shouldPersist =
    next !== sessionEntry.authProfileOverride ||
    sessionEntry.authProfileOverrideSource !== "auto" ||
    sessionEntry.authProfileOverrideCompactionCount !== compactionCount;
  if (shouldPersist) {
    sessionEntry.authProfileOverride = next;
    sessionEntry.authProfileOverrideSource = "auto";
    sessionEntry.authProfileOverrideCompactionCount = compactionCount;
    sessionEntry.updatedAt = Date.now();
    sessionStore[sessionKey] = sessionEntry;
    if (storePath) {
      await (
        await loadSessionStoreRuntime()
      ).updateSessionStore(storePath, (store) => {
        store[sessionKey] = sessionEntry;
      });
    }
  }

  return { authProfileId: next, authProfileOrder: resolvedOrder, authStore: store };
}

export async function resolveSessionAuthProfileOverride(params: {
  cfg: OpenClawConfig;
  provider: string;
  agentDir: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  isNewSession: boolean;
}): Promise<string | undefined> {
  return (await resolveSessionAuthProfileOverrideState(params)).authProfileId;
}
