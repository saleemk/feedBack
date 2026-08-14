const CACHE_PREFIX = 'feedback-pwa-offline-';
const CACHE_NAME = `${CACHE_PREFIX}v7`;
const OFFLINE_URL = '/static/v3/offline.html';
const RECOVERY_ASSET_URLS = new Set([
  OFFLINE_URL,
  '/static/v3/offline-catalog.js',
  '/static/js/practice-package-store.js',
]);
const SHELL_CACHE_PREFIX = 'feedback-pwa-shell-';
const SHELL_CACHE_VERSION = 'v4';
const SHELL_CACHE_NAME = `${SHELL_CACHE_PREFIX}${SHELL_CACHE_VERSION}`;
const SHELL_MANIFEST_URL = '/static/v3/pwa-shell-assets.json';
const PLUGINS_URL = '/api/plugins';
const SHELL_COMPLETE_URL = '/__feedback-pwa-shell-complete__';
const APP_ENTRY_PATHS = new Set(['/', '/v3', '/v3/']);
const TRANSIENT_UNAVAILABLE_STATUSES = new Set([502, 503, 504]);

async function offlineResponse() {
  const cache = await caches.open(CACHE_NAME);
  return (await cache.match(OFFLINE_URL)) || Response.error();
}

async function populateRecoveryCache() {
  await caches.delete(CACHE_NAME);
  const cache = await caches.open(CACHE_NAME);
  const requests = Array.from(
    RECOVERY_ASSET_URLS,
    (url) => new Request(url, { cache: 'reload' })
  );
  try {
    await cache.addAll(requests);
  } catch (error) {
    await caches.delete(CACHE_NAME);
    throw error;
  }
}

function requireOk(response, label) {
  if (!response || !response.ok) throw new Error(`Failed to fetch ${label}`);
  return response;
}

function validateCoreAssets(manifest) {
  if (!manifest || manifest.schema !== 'feedback.pwa-shell-assets.v1'
      || !Array.isArray(manifest.assets)) {
    throw new Error('Invalid PWA shell manifest');
  }

  const assets = new Set();
  for (const path of manifest.assets) {
    if (typeof path !== 'string' || !path.startsWith('/static/') || path.includes('\\')) {
      throw new Error('Invalid core shell asset path');
    }
    const url = new URL(path, self.location.origin);
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch (_) {
      throw new Error('Invalid core shell asset encoding');
    }
    if (url.origin !== self.location.origin || url.pathname !== path
        || url.search || url.hash || !decodedPath.startsWith('/static/')
        || decodedPath.split('/').some((part) => part === '.' || part === '..')
        || assets.has(path)) {
      throw new Error('Invalid core shell asset path');
    }
    assets.add(path);
  }
  return assets;
}

function pluginAssetUrls(rows) {
  if (!Array.isArray(rows)) throw new Error('Invalid plugin discovery response');

  const urls = new Set();
  for (const plugin of rows) {
    if (!plugin || typeof plugin !== 'object'
        || plugin.status !== 'ready' || plugin.enabled === false) {
      continue;
    }
    const declared = plugin.offline_assets;
    if (declared == null || (Array.isArray(declared) && declared.length === 0)) continue;
    if (!Array.isArray(declared) || typeof plugin.id !== 'string' || !plugin.id.trim()) {
      throw new Error('Invalid eligible plugin metadata');
    }

    const encodedId = encodeURIComponent(plugin.id);
    for (const path of declared) {
      if (typeof path !== 'string' || !path.trim() || path !== path.trim()
          || /^[A-Za-z]:/.test(path)
          || path.includes('\\') || path.includes('?') || path.includes('#')) {
        throw new Error('Invalid plugin offline asset path');
      }
      const segments = path.split('/');
      if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new Error('Invalid plugin offline asset path');
      }
      urls.add(`/api/plugins/${encodedId}/${segments.map(encodeURIComponent).join('/')}`);
    }
  }
  return urls;
}

function offlinePluginRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((plugin) => {
    if (!plugin || typeof plugin !== 'object'
        || plugin.status !== 'ready' || plugin.enabled === false
        || !Array.isArray(plugin.offline_assets) || plugin.offline_assets.length === 0) {
      return false;
    }
    const declared = new Set(plugin.offline_assets);
    if (plugin.has_script && !declared.has('screen.js')) return false;
    if (plugin.has_screen && !declared.has('screen.html')) return false;
    if (plugin.has_settings && !declared.has('settings.html')) return false;
    if (plugin.has_styles && plugin.styles && !declared.has(plugin.styles)) return false;
    return true;
  });
}

async function populateShellCache() {
  const existingKeys = await caches.keys();
  if (existingKeys.includes(SHELL_CACHE_NAME)) {
    const existing = await caches.open(SHELL_CACHE_NAME);
    if (await existing.match(SHELL_COMPLETE_URL)) return;
  }

  await caches.delete(SHELL_CACHE_NAME);
  const cache = await caches.open(SHELL_CACHE_NAME);
  try {
    const manifestRequest = new Request(SHELL_MANIFEST_URL, { cache: 'no-store' });
    const manifestResponse = requireOk(
      await fetch(manifestRequest),
      'PWA shell manifest'
    );
    const manifest = await manifestResponse.clone().json();
    const coreAssets = validateCoreAssets(manifest);

    const pluginsRequest = new Request(PLUGINS_URL, { cache: 'no-store' });
    const pluginsResponse = requireOk(await fetch(pluginsRequest), 'plugin discovery');
    const plugins = await pluginsResponse.clone().json();
    const pluginAssets = pluginAssetUrls(plugins);

    await cache.put(manifestRequest, manifestResponse.clone());
    await cache.put(pluginsRequest, pluginsResponse.clone());

    const requiredUrls = new Set([...coreAssets, ...pluginAssets]);
    for (const url of requiredUrls) {
      const request = new Request(url, { cache: 'reload' });
      const response = requireOk(await fetch(request), url);
      await cache.put(request, response);
    }

    await cache.put(
      new Request(SHELL_COMPLETE_URL),
      new Response('complete', { headers: { 'Content-Type': 'text/plain' } })
    );
  } catch (error) {
    await caches.delete(SHELL_CACHE_NAME);
    throw error;
  }
}

async function cleanupShellCaches() {
  const keys = await caches.keys();
  if (!keys.includes(SHELL_CACHE_NAME)) return;
  const current = await caches.open(SHELL_CACHE_NAME);
  if (!(await current.match(SHELL_COMPLETE_URL))) return;
  await Promise.all(
    keys
      .filter((key) => key.startsWith(SHELL_CACHE_PREFIX) && key !== SHELL_CACHE_NAME)
      .map((key) => caches.delete(key))
  );
}

async function resolveCompleteShellCache() {
  const keys = await caches.keys();
  const olderNames = keys
    .filter((key) => key.startsWith(SHELL_CACHE_PREFIX) && key !== SHELL_CACHE_NAME)
    .reverse();
  const candidateNames = keys.includes(SHELL_CACHE_NAME)
    ? [SHELL_CACHE_NAME, ...olderNames]
    : olderNames;

  // CacheStorage keys are creation-ordered, so preserved candidates are checked newest first.
  for (const name of candidateNames) {
    const cache = await caches.open(name);
    if (await cache.match(SHELL_COMPLETE_URL)) return cache;
  }
  return null;
}

function shellCacheKey(request) {
  const url = new URL(request.url);
  const pluginAsset = url.pathname.match(/^\/api\/plugins\/[^/]+\/(.+)$/);
  const queryKeys = Array.from(url.searchParams.keys());
  if (pluginAsset && !pluginAsset[1].startsWith('g/')
      && queryKeys.length === 1 && queryKeys[0] === 'v') {
    url.search = '';
  }
  return url.href;
}

async function shellResourceResponse(request) {
  const cache = await resolveCompleteShellCache();
  const cached = cache ? await cache.match(shellCacheKey(request)) : null;
  if (!cached) return fetch(request);

  try {
    const response = await fetch(request);
    return TRANSIENT_UNAVAILABLE_STATUSES.has(response.status) ? cached : response;
  } catch (_) {
    return cached;
  }
}

async function offlineShellResourceResponse(request) {
  const cache = await resolveCompleteShellCache();
  if (!cache) return Response.error();
  const cached = await cache.match(shellCacheKey(request));
  if (!cached) return Response.error();

  const url = new URL(request.url);
  if (url.pathname !== PLUGINS_URL) return cached;
  try {
    const plugins = offlinePluginRows(await cached.json());
    return new Response(JSON.stringify(plugins), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (_) {
    return Response.error();
  }
}

function isExplicitOfflineAppUrl(value) {
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin
      && APP_ENTRY_PATHS.has(url.pathname)
      && url.searchParams.get('offline') === '1';
  } catch (_) {
    return false;
  }
}

async function requestUsesOfflineApp(event) {
  if (!event.clientId || typeof self.clients.get !== 'function') return false;
  const client = await self.clients.get(event.clientId);
  return Boolean(client && isExplicitOfflineAppUrl(client.url));
}

async function offlineAppNavigationResponse() {
  const cache = await resolveCompleteShellCache();
  const shell = cache ? await cache.match('/static/v3/index.html') : null;
  return shell || offlineResponse();
}

async function recoveryResourceResponse(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (!cached) return fetch(request);

  try {
    const response = await fetch(request);
    return TRANSIENT_UNAVAILABLE_STATUSES.has(response.status) ? cached : response;
  } catch (_) {
    return cached;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    populateRecoveryCache()
      .then(() => populateShellCache().catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys()
        .then((keys) => Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )),
      cleanupShellCaches(),
    ])
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode !== 'navigate') {
    if (RECOVERY_ASSET_URLS.has(url.pathname)) {
      event.respondWith(recoveryResourceResponse(event.request));
      return;
    }
    const isShellResource = url.pathname.startsWith('/static/')
      || url.pathname === PLUGINS_URL
      || url.pathname.startsWith(`${PLUGINS_URL}/`);
    if (isShellResource) {
      event.respondWith(
        requestUsesOfflineApp(event).then((offline) => (
          offline
            ? offlineShellResourceResponse(event.request)
            : shellResourceResponse(event.request)
        ))
      );
    }
    return;
  }

  if (url.pathname === OFFLINE_URL) {
    event.respondWith(offlineResponse());
    return;
  }

  if (!APP_ENTRY_PATHS.has(url.pathname)) return;

  if (isExplicitOfflineAppUrl(url.href)) {
    event.respondWith(offlineAppNavigationResponse());
    return;
  }

  const networkRequest = new Request(event.request, { cache: 'no-store' });
  event.respondWith(
    fetch(networkRequest)
      .then((response) => (
        TRANSIENT_UNAVAILABLE_STATUSES.has(response.status)
          ? offlineResponse()
          : response
      ))
      .catch(() => offlineResponse())
  );
});
