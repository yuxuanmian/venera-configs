# Debug scan contract v1

This file mirrors the source-facing part of the parent application's Contract
J/O v1. The parent documents are authoritative:

- `specs/004-minimal-scan-kernel/contracts/observation-v1.md`
- `specs/004-minimal-scan-kernel/contracts/source-scan-v1.md`
- `specs/004-minimal-scan-kernel/contracts/transport-boundary.md`

`ComicSource.scan` is optional. A missing or `null` declaration is `absent`;
an object with a malformed branch is `invalid`, and the ordinary source still
loads. One valid branch selects itself. When both `comic` and `collection`
branches exist, `primary` is required and must select an existing branch. The
host never falls back from one producer to the other.

The host app appends a request function to the loader call:

```js
scan = {
  primary: "comic",
  comic: {
    load: async (comicId, request) => ({
      observation: {update: {updatedAt: "2026-01-01"}},
    }),
  },
  collection: {
    load: async (collectionKey, cursor, request) => ({items: [], next: null}),
  },
};
```

The callback accepts only a JSON request with `GET` or `POST`, an HTTP(S) URL,
string headers, and an optional string body. It is the Host-owned path for
cancellation, cookies, proxy/TLS, safe logging, and bypassing the application
response cache. It is not a source-provided `extra`, token, context, database,
or cancel-token object. Declarations must not touch UI, the favorite database,
or the retired update-check implementation during construction or scanning.

Comic results contain exactly one `observation` or `failure`. Collection pages
must own both `items` and `next`; `next: null` alone is natural termination.
`false`, `0`, and `""` are valid opaque cursors and do not terminate. The host
does not interpret `total`, `totalPage`, or `maxPage`; page and cursor limits
are enforced independently. A collection page is fully validated before its
first item is emitted, then valid items are committed one by one.

Only the Feature 1 facts `updatedAt`, `latestChapterId`, `chapterCount`,
`recentChapterIds`, and `sourceUnread` are accepted. Do not return markers,
baselines, metadata, `isUpdated`, `hasNewUpdate`, credentials, response bodies,
or a business failure classification. Manwa's implementation is a weak
snapshot: it uses the fixed favorite-time ordering and verifies only the
ordered first-page IDs; a stable head does not promise an absolute member
snapshot.

The declaration is part of the existing source file. It is not a new
downloaded `scan.js` and must remain compatible with older application hosts
that simply ignore the optional property.
