import test from 'node:test'
import assert from 'node:assert/strict'
import config from '../../js/core/config.js'
import * as rerum from '../../js/core/rerum.js'
import { stubFetch, jsonResponse, withConfig, ADA } from './helpers.js'

const DEFAULT_GENERATOR = "https://devstore.rerum.io/v1/id/5afeebf3e4b0b0d588705d90"

test('expanded() appends /expanded and always carries the generator', async () => {
    const stub = stubFetch(() => ({}))
    await withConfig({ fetch: stub }, () => rerum.expanded(ADA))
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0].url, `${ADA}/expanded?generator=${encodeURIComponent(DEFAULT_GENERATOR)}`)
})

test('expanded() throws without a generator anywhere', async () => {
    const stub = stubFetch(() => ({}))
    await withConfig({ fetch: stub, GENERATOR: undefined }, () => {
        assert.throws(() => rerum.expanded(ADA), /requires a generator/)
    })
    assert.equal(stub.calls.length, 0)
})

test('expanded() lets an explicit generator override config', async () => {
    const stub = stubFetch(() => ({}))
    await withConfig({ fetch: stub }, () => rerum.expanded(ADA, { generator: "https://example.org/myAgent" }))
    assert.ok(stub.calls[0].url.endsWith(`?generator=${encodeURIComponent("https://example.org/myAgent")}`))
})

test('resolve() normalizes to https and honors fresh (cache reload)', async () => {
    const stub = stubFetch(() => ({}))
    await withConfig({ fetch: stub }, async () => {
        await rerum.resolve(ADA.replace("https:", "http:"))
        await rerum.resolve(ADA, { fresh: true })
    })
    assert.equal(stub.calls[0].url, ADA)
    assert.equal(stub.calls[0].options.cache, undefined)
    assert.equal(stub.calls[1].options.cache, "reload")
})

test('query() POSTs to the configured endpoint with paging defaults', async () => {
    const stub = stubFetch(() => ([]))
    await withConfig({ fetch: stub }, () => rerum.query({ targetCollection: "AntlersTestPeople" }))
    const call = stub.calls[0]
    assert.equal(call.url, `${config.URLS.QUERY}?limit=50&skip=0`)
    assert.equal(call.options.method, "POST")
    assert.deepEqual(JSON.parse(call.options.body), { targetCollection: "AntlersTestPeople" })
})

test('query() appends paging to a QUERY URL that already has parameters', async () => {
    const stub = stubFetch(() => ([]))
    await withConfig({ fetch: stub, URLS: { QUERY: "https://tiny.example.com/query?foo=1" } }, () =>
        rerum.query({}, { limit: 10, skip: 5 }))
    assert.equal(stub.calls[0].url, "https://tiny.example.com/query?foo=1&limit=10&skip=5")
})

test('findByTargetId() matches every target style in both protocol forms, leaf versions only', async () => {
    const stub = stubFetch(() => ([]))
    await withConfig({ fetch: stub }, () => rerum.findByTargetId(ADA))
    const body = JSON.parse(stub.calls[0].options.body)
    const uris = { $in: [ADA, ADA.replace("https:", "http:")] }
    assert.deepEqual(body, {
        "$or": [{ "target": uris }, { "target.@id": uris }, { "target.id": uris }],
        "__rerum.history.next": { "$exists": true, "$size": 0 }
    })
})

test('create POSTs, update and overwrite PUT, all unwrap new_obj_state', async () => {
    const stub = stubFetch(() => ({ new_obj_state: { "@id": "https://devstore.rerum.io/v1/id/abc123" } }))
    await withConfig({ fetch: stub }, async () => {
        const created = await rerum.create({ name: "Test" })
        const updated = await rerum.update({ "@id": "x", name: "Test2" })
        const overwritten = await rerum.overwrite({ "@id": "x", name: "Test3" })
        for (const result of [created, updated, overwritten]) {
            assert.deepEqual(result, { "@id": "https://devstore.rerum.io/v1/id/abc123" })
        }
    })
    assert.equal(stub.calls[0].url, config.URLS.CREATE)
    assert.equal(stub.calls[0].options.method, "POST")
    assert.equal(stub.calls[1].url, config.URLS.UPDATE)
    assert.equal(stub.calls[1].options.method, "PUT")
    assert.equal(stub.calls[2].url, config.URLS.OVERWRITE)
    assert.equal(stub.calls[2].options.method, "PUT")
})

test('non-OK responses reject', async () => {
    const stub = stubFetch(() => jsonResponse({}, { ok: false, status: 500, statusText: "Internal Server Error" }))
    await withConfig({ fetch: stub }, async () => {
        await assert.rejects(() => rerum.resolve(ADA), /HTTP 500/)
    })
})

test('isRerumId() recognizes configured id bases only', () => {
    assert.equal(rerum.isRerumId(ADA), true)
    assert.equal(rerum.isRerumId(ADA.replace("https:", "http:")), true)
    assert.equal(rerum.isRerumId("https://store.rerum.io/v1/id/abc"), true)
    assert.equal(rerum.isRerumId("https://example.org/thing/1"), false)
    assert.equal(rerum.isRerumId(undefined), false)
})

test('a proprietary TinyNode deployment reconfigures endpoints and agent end-to-end', async () => {
    const stub = stubFetch(() => ({ new_obj_state: {} }))
    await withConfig({
        fetch: stub,
        URLS: {
            CREATE: "https://tiny.myapp.com/app/create",
            UPDATE: "https://tiny.myapp.com/app/update",
            OVERWRITE: "https://tiny.myapp.com/app/overwrite",
            QUERY: "https://tiny.myapp.com/app/query"
        },
        GENERATOR: "https://store.rerum.io/v1/id/myProprietaryAgent"
    }, async () => {
        await rerum.create({ name: "Mine" })
        await rerum.query({})
        await rerum.expanded(ADA)
    })
    assert.equal(stub.calls[0].url, "https://tiny.myapp.com/app/create")
    assert.equal(stub.calls[1].url, "https://tiny.myapp.com/app/query?limit=50&skip=0")
    assert.equal(stub.calls[2].url, `${ADA}/expanded?generator=${encodeURIComponent("https://store.rerum.io/v1/id/myProprietaryAgent")}`)
})
