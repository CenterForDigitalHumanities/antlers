# Test fixtures

Captured live from the RERUM sandbox on 2026-08-25 for the designated test entity
**Ada Lovelace** `https://devstore.rerum.io/v1/id/6a8deb57603234d1d9742deb`
(created by the antlers 2.0 test bench, tagged `ANTLERS_2_0_TEST_AGENT` on the
entity `creator` and on every annotation).

- `ada-entity.json` — `GET https://devstore.rerum.io/v1/id/6a8deb57603234d1d9742deb`
- `ada-annotations.json` — `POST https://tinydev.rerum.io/app/query?limit=50&skip=0`
  with the targeting-annotation body (`$or` over `target`, `target.@id`, `target.id`,
  `$in` http/https variants, leaf-version filter `__rerum.history.next: {$exists: true, $size: 0}`).
  10 annotations.
- `ada-expanded.json` — `GET https://devstore.rerum.io/v1/id/6a8deb57603234d1d9742deb/expanded`
  (no `generator` filter on the capture request; the server merged all 10 annotations,
  demonstrating that the server applies **no default filter** — which is why
  `rerum.expanded()` makes `generator` a required argument).

## Response headers on the `/expanded` capture

```text
HTTP/1.1 200 OK
Content-Type: application/ld+json; charset=utf-8; profile="http://www.w3.org/ns/anno.jsonld"
Annotations-Gathered: 10
Annotations-Merged: 10
Cache-Control: max-age=86400, must-revalidate
Link: <http://www.w3.org/ns/ldp#Resource>; rel="type"
Location: https://devstore.rerum.io/v1/id/6a8deb57603234d1d9742deb
ETag: W/"47c-UWIXP8x2LXpOMtb30jQXpgu8qt8"
```

Notable in `ada-expanded.json`: the entity's own literal `name`/`creator` merge with
annotation-asserted values into heterogeneous arrays (raw string + `{value}` object),
and **no annotation `@id` appears anywhere** — the server path has no provenance.
