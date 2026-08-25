/**
 * Shared test plumbing: fixture loading, a stubbed fetch that records calls,
 * and config snapshot/restore so tests never touch the network or leak state.
 */

import { readFile } from 'node:fs/promises'
import config, { configure } from '../../js/core/config.js'

/** Load a JSON fixture from test/fixtures by basename. */
export async function fixture(name) {
    return JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'))
}

/** A minimal Response-alike for the stubbed fetch. */
export function jsonResponse(body, init = {}) {
    return {
        ok: init.ok ?? true,
        status: init.status ?? 200,
        statusText: init.statusText ?? "OK",
        json: async () => structuredClone(body)
    }
}

/**
 * Build a fetch stub.  `router(url, options)` returns a body (wrapped in a
 * jsonResponse), a jsonResponse directly, or undefined to fail the test with
 * an unexpected-fetch error.  Calls are recorded on `stub.calls`.
 */
export function stubFetch(router) {
    const calls = []
    const stub = async (url, options = {}) => {
        calls.push({ url: String(url), options })
        const result = router(String(url), options)
        if (result === undefined) { throw new Error(`Unexpected fetch: ${url}`) }
        return (typeof result?.json === "function") ? result : jsonResponse(result)
    }
    stub.calls = calls
    return stub
}

/**
 * Run `fn` with config overrides applied (including `fetch` stubs), then
 * restore the previous config no matter what.
 */
export async function withConfig(overrides, fn) {
    const snapshot = {
        URLS: { ...config.URLS },
        ID_BASES: [...config.ID_BASES],
        GENERATOR: config.GENERATOR,
        LIMIT: config.LIMIT,
        SKIP: config.SKIP,
        fetch: config.fetch
    }
    configure(overrides)
    try {
        return await fn()
    } finally {
        configure(snapshot)
    }
}

export const ADA = "https://devstore.rerum.io/v1/id/6a8deb57603234d1d9742deb"
