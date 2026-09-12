# Debug scan contract v1

This file mirrors the source-facing part of the parent application's Contract
C/J/O v1. The parent documents are authoritative:

- `specs/004-minimal-scan-kernel/contracts/observation-v1.md`
- `specs/004-minimal-scan-kernel/contracts/source-scan-v1.md`
- `specs/004-minimal-scan-kernel/contracts/transport-boundary.md`
- `specs/005-tracking-reconnect/contracts/comparability-v1.md` (Contract C)
- `specs/005-tracking-reconnect/contracts/judgment-v1.md` (Contract J)

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
    fieldSource: {
      updatedAt: "updated_at@instant",
    },
    load: async (comicId, request) => ({
      observation: {update: {updatedAt: "2026-01-01"}},
    }),
  },
  collection: {
    fieldSource: {
      latestChapterId: "last_chapter.id",
      sourceUnread: "is_new|full_is_new",
    },
    load: async (collectionKey, cursor, request) => ({items: [], next: null}),
  },
};
```

## The `fieldSource` declaration

Every branch that declares `load` **must** also declare `fieldSource`. A branch
with a `load` but no usable declaration makes the whole `scan` capability
`invalid`; the source itself still loads, so ordinary source features are
unaffected.

The declaration is the machine-readable form of the "output ← source" mapping
table in this document: keys are standard observation field names, values are
free-text descriptions of where the value comes from. **The host never parses
or evaluates a value.** It trims and lowercases values, sorts by key, and uses
the result as the branch's *comparable label*. The label decides whether two
observations may be compared at all, so a declaration change makes the host
rebuild the comparison baseline and deliberately report **no** update.

Rules (Contract C2/C4/C5/C6):

| Rule | Outcome |
| --- | --- |
| Keys limited to the five standard fields | any other key (including a misspelling) makes the **whole declaration invalid** |
| Values must be non-empty strings | a non-string value makes the declaration invalid |
| Empty declaration object | invalid — declare at least the fields you actually produce |
| `@day` / `@instant` suffix | allowed **only** on `updatedAt`; anywhere else it is invalid |
| Separator folding | **not** performed: `last_chapter.id` and `last-chapter.id` are different labels, on purpose |

Source-side verification asserts that the declaration matches what the branch
actually produces (Contract C6.1): a declared but never-produced field, a
produced but undeclared field, or a granularity that does not match the real
value format all fail the test suite.

## Mapping table (mirrored from the parent's S1.3)

| Branch | Standard field | Source field | Granularity |
| --- | --- | --- | --- |
| `manwa.collection` | `latestChapterId` | `last_chapter.id` | — |
| `manwa.collection` | `sourceUnread` | `is_new` \| `full_is_new` | — |
| `picacg.comic` | `updatedAt` | `updated_at` | `@day` (weakest real representation) |

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

Only the standard facts `updatedAt`, `latestChapterId`, `chapterCount`,
`recentChapterIds`, and `sourceUnread` are accepted. Do not return markers,
baselines, metadata, `isUpdated`, `hasNewUpdate`, credentials, response bodies,
or a business failure classification. Manwa's implementation is a weak
snapshot: it uses the fixed favorite-time ordering and verifies only the
ordered first-page IDs; a stable head does not promise an absolute member
snapshot.

Identifiers (`comicId`, `latestChapterId`, and every `recentChapterIds` entry)
must not contain U+0000: the host joins identities with that character, so an
identifier carrying it would be ambiguous.

## The retired list-level `favorites.updateCheck` channel

`favorites.updateCheck` is **retained for compatibility only**. Sources
published before this contract may still declare it, because sources are
distributed to devices running older application versions that read it; removing
it from a source would take list-level observations away from those users.
Its rules are still guarded by `test/favorite_update_contract_test.js` and
`test/manwa_update_check_test.js`.

**New sources MUST NOT declare it.** The current application no longer reads
the channel; it obtains observations from `scan` and judges them itself. The
parent's decision is recorded in `specs/005-tracking-reconnect/` (FR-044,
FR-045); deleting the channel from the existing sources is a separate change.

The declaration is part of the existing source file. It is not a new
downloaded `scan.js` and must remain compatible with older application hosts
that simply ignore the optional property.

