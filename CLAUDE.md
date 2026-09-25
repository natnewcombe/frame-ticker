# Frame Checklist (Austruss LGS bay)

Single-file HTML tablet app for the Austruss LGS (light gauge steel) bay. It
runs on Samsung tablets in Chrome, installed via Add to Home Screen so it's
full-screen with no address bar. No build step, no framework, no bundler: the
app is `index.html` with its CSS and JS inline, edited in place and served
as-is by GitHub Pages from `main`. **`index.html` on `main` is the only source
of truth**; ignore copies from anywhere else.

The operator opens a job, ticks off frames from the FRAMECAD detailer report
as they're built, taps 📄 to see a frame's production drawing, and hits Save
Progress to put a marked-up report back on the Smartsheet row.

Users are production staff, not developers. Explain changes in plain steps,
ask before big decisions, and get approval before creating new files.

## Sibling app: Structural-Checklist

`natnewcombe/Structural-Checklist` (`structural-checklist.html`) is the
structural steel bay's app. The two were built together and share the design
system, the Smartsheet proxy plumbing (the Cloudflare Worker,
`smartsheet-proxy-worker.js`, lives in that repo) and the pinch/pan/swipe
gesture code. **They are separate files on purpose: never merge them.**

Changes are ported between them by reading the other repo's pull requests
directly, e.g. "port Structural-Checklist PR #2". Read that repo's `CLAUDE.md`
too; its hard-won constraints apply here. Port the idea, not the letter: the
structural app counts quantities per page and parses cut length sheets, which
this app doesn't. Don't port:

- hiding `Detailer - Report` attachments (this app works *from* the report);
- structural mark formats (`P102-106`, `B9215(RHS)`, `RHS-…X…X…_BP`), Job
  Info File routing, or the slash marks on cut lists.

The structural app is the newer one; where they differ in shared plumbing,
look there first for the fix.

## Hard-won constraints. Do not rediscover these.

- **Smartsheet sends no CORS headers.** The browser can never call
  `api.smartsheet.com` directly. Everything goes through the Cloudflare Worker,
  which holds the Smartsheet token as a secret. A separate `APP_KEY` guards the
  Worker, so leaking its URL alone doesn't hand out Smartsheet access.
- **Attachment uploads are raw bytes** with exact `Content-Type`,
  `Content-Length` and `Content-Disposition` headers. Not multipart, not JSON,
  not base64. The Worker sets these; don't reshape the body.
- **Attachment downloads go through the Worker's `/download`**, which resolves
  the pre-signed URL and fetches the bytes in the same request. That URL
  expires in 60 seconds and the client must never see it. Don't send an
  Authorization header when fetching a pre-signed URL; it can break it.
- **Re-resolve an attachment's live ID immediately before writing to it.** A
  version bump changes the ID, so one fetched earlier is already stale. See
  `resolveLiveAttachment`.
- **Read cell `value`, not `displayValue`**, except contact-list columns
  (Designer), where `displayValue` is the person's name and `value` their email.
- **Match Smartsheet columns by title, never by hardcoded column ID.**
- **Supabase does send proper CORS headers**, so session logging and issue
  notes go direct from the browser. Only Smartsheet needs the Worker.
- **Never use localStorage as the source of truth for anything that matters.**
  It holds connection details, per-job ticks and the active session only.
  Real state goes to Smartsheet or Supabase.
- Smartsheet's API caps uploads at 30MB (`CONFIG.UPLOAD_CAP_BYTES`).

## Smartsheet specifics

- The job list has three buttons (`JOB_LISTS`), all over the Work Order sheet
  `8417646009601924`, jobs in the report's own row order, only rows whose
  Work Order Type is `FRAMECAD`:
  - **Scheduled** (default): `FRAMECAD - Work Orders Schedule`, ID
    `7888733526249348` (`CONFIG.REPORT_ID`), minus rows marked Complete.
  - **Not completed** / **Completed**: `FRAMECAD - Work Orders`, ID
    `672067532836740` (`CONFIG.ALL_REPORT_ID`), every work order (892 rows in
    Sept 2026), split on Complete. Fetched once for both buttons.
  Reports come a page at a time; `getReportData` keeps fetching until
  `totalRowCount`. Job search matches work order number and zone/project only
  (the bay's choice), every word in any order.
- Columns read, by title: Primary, Work Order Type, Project & Zone Number,
  Complete, Scheduled Start Date, Scheduled End Date, Work Record URL,
  F_Profile (the leading number is shown as the gauge chip), Designer.
- Attachments: PDFs only, minus the app's own `IN PROGRESS:` uploads. The
  report is recognised by `CONFIG.DETAILER_NAME_RE` and the drawings by
  `CONFIG.DRAWINGS_NAME_RE`; when either is missing the operator picks from a
  list. Real report names (`26040-LGS-3-600 [1] UNIT 5 - Detailer - Report -
  90_LB Walls.pdf`) don't match `DETAILER_NAME_RE`, so in practice the picker
  shows on every job. The bay has accepted that: the files always sit together
  on one row.

## Supabase

Project is shared with the structural app; tables are separate.

| Table | Used by |
|---|---|
| `session_log`, `frame_issues` | This app. |
| `ss_session_log`, `ss_issues` | Structural app. Leave alone. |

RLS restricts the anon (publishable) key to select and insert. The publishable
key is hardcoded in the HTML by design; that's what it's for. The Worker's
`APP_KEY` is **not** in the repo and must never be committed: it's entered on
the tablet's Settings screen and lives in localStorage.

localStorage keys are prefixed `fc_` here and `ssc_` in the structural app, so
both can be installed on one tablet without collision.

## How the bay's files work

Facts from the bay, not visible in the code:

- A job is one **detailer report** ("Plan Material Summary", FRAMECAD
  Detailer) plus, usually, one **production drawings** PDF.
- **Some jobs have no drawings.** Studs, bridging and other plain sticks come
  as a report only. The app must work with just a report, and 📄 should only
  show on frames that have a drawing.
- **`N101-1`, `N101-2` … are copies.** One drawing (`Mark as N101`) covers
  several identical frames, and the report lists each copy with a `-1`, `-2`
  suffix. Sometimes a single frame carries `-1` anyway. Nested labels like
  `GI100-2 (GI100-1 (WELD))` are the same idea.
- **Split frames:** `N504.A` / `N504.B` (26018) and `NB2047-A` / `-B` / `-C`
  (24477) are parts of one frame, all built from the one drawing (`N504`,
  `NB2047`).
- Pack lists (e.g. `24477-LGS-C1-621 … Pack lists`) will be used later; the
  app ignores them for now.

## PDF parsing

Uses pdf.js 3.11.174 (loaded from cdnjs) to read the text layer, and pdf-lib
1.17.1 to write the marked-up report.

- Coordinates are **raw** `transform[4]/[5]` (PDF space, y increases upward),
  not viewport coordinates. `getPageRows` groups items by exactly rounded y.
  The structural app learned to cluster rows with a tolerance and to work in
  viewport coordinates; see its `getPageItems` before changing this.
- **Some reports are drawn sideways.** `90 Gable Frames.pdf` is a portrait
  report placed on a landscape page: `page.rotate` is 0 (so viewport
  coordinates wouldn't help) but every text item is turned to run down the
  page. `getPageRows` detects that from the items' direction and maps them
  back to the portrait layout, and flags the frames `turned` so
  `annotateDetailerPdf` draws its band and OK sideways to match.
- `extractDetailerReport` matches each row against one regex (`rowRe`). The
  frame name may carry `(...)` suffixes (`BE3000 (WELD) (CHECK)`): the full
  text is kept as `label`, the stripped name as `name`, which is what ticks are
  stored under so a suffix changing between revisions keeps its tick. The
  report's own `Frame Count :` line lets the tests check nothing was dropped.
- Drawing identity is a **strategy list, first match wins**
  (`extractDrawingNumberFromTokens`). Add to it; don't rewrite the existing
  entries, each is tuned to a real export:
  1. `extractDrawingNumber_PhoneAnchor`: FRAMECAD Detailer panels/beams, the
     number sits next to the office phone number (`02 4860 14xx`), either side.
  2. `extractDrawingNumber_MarkAs`: FRAMECAD Structure, `Mark as N237`.
- `extractTags` reads WELD ALL/PART/STP/SHS, GUSSET, STP, SHS, DOUBLE SCREW
  and GIRDER off each drawing page.

## Save Progress

An inline listener on `#btnSaveProgress`. It marks up only the report
(`annotateDetailerPdf`: green band + OK on each ticked row) and uploads it as a
**new version of the original report attachment**, same name, never a fresh
duplicate. (It used to upload a separate `IN PROGRESS: <num> - <NAME>.pdf`;
those older uploads stay hidden by `IN_PROGRESS_ATTACHMENT_RE`.) If Start Job
was pressed, it then writes one `session_log` row with the frames ticked since
then and their metres, and clears the session. Start Job on its own writes
nothing. Ported from Structural-Checklist PR #2.

**Never work from the app's own markup**, or each save stacks new marks on old
ones. So opening a job always goes back to a clean report version
(`loadWorkingDetailer`):

- App saves always come from the Worker token's Smartsheet account
  (`/users/me`); designers upload revisions from their own logins. That's how
  `pickWorkingVersion` tells the two apart in the version history
  (`/sheets/{id}/attachments/{id}/versions`, via the Worker's `/api`
  passthrough, so the Worker needs no extra route).
- Each markup carries PDF keywords: `austruss-fc-markup fc-source:<id>
  [fc-skip:<id>]`, naming the clean version it was drawn from and any newer
  revision the bay chose not to switch to. The tag is deliberately different
  from the structural app's `austruss-ssc-markup`. `cleanOf` follows the note
  as a safety net whenever the history can't be trusted.
- A designer version newer than the last save gets a NEW REVISION badge in the
  "Which file is the detailer report?" picker, and opening the report asks:
  keep working on the version you started, or switch. Ticks are kept by frame
  name, so they carry over either way.
- Drawings are never written by the app, so they always open at their latest
  version.

## Known gaps

Measured by the tests against `samples/`; each is pinned so a fix is a
deliberate change to the test.

- **📄 can't find the drawing** for copies (`N101-1` vs drawing `N101`, all 163
  truss frames in Zone 16) and parts (`NB2047-A`, 19 frames in 24477). The
  match in `jumpToFrameDrawing` is exact.
- **📄 shows on every frame**, even when there's nothing to go to.
- **A report-only job can't open.** After picking the report, the app asks for
  drawings from an empty list.
- **Drawings with no text layer** (`150 Bulkhead Frames Z1 - Production
  Drawing.pdf`, flattened) can't be identified by any rule. The structural app
  shows a hint on such pages; not ported yet.
- Uploads show as authored by whoever owns the Worker's token, not the operator.
- If whoever owns the Worker's Smartsheet token also uploads reports from that
  same login, the app will take those uploads for its own saves and skip them
  as working versions. Designers must upload from their own accounts.

## Testing

Run both before and after any change. They take seconds.

```bash
npm install                      # pdfjs-dist@3.11.174, pdf-lib@1.17.1, jsdom
node test/parsers.mjs            # real parsers against every job in samples/
node test/parsers.mjs 26018      # only jobs with a file name containing "26018"
node test/parsers.mjs --annotate # also write marked-up reports to test/out/
node test/ui.mjs                 # boots the app in jsdom and clicks through it
```

`test/parsers.mjs` pulls the parser functions straight out of `index.html`
rather than reimplementing them, so it can't drift from the app. It splits the
inline script at the `APP STATE` banner comment: everything above is DOM-free
logic. **If you rename that banner, update the marker in the harness.** It
checks each report against its own Frame Count, each drawings page for a
number, and each frame for a drawing its 📄 button can reach. The `SAMPLES`
table at its top says which file is a report, which is drawings, and which go
together; every PDF in `samples/` must be in it.

`test/ui.mjs` runs the app's real inline JS in jsdom with pdf.js, pdf-lib and
fetch stubbed, and asserts on wiring: element ids, listeners, what gets
uploaded and logged. It exposes internals via an `Object.assign(window, {...})`
list; if you rename an exported name, update that list too. `GAP` lines pin
known-wrong behaviour; when you fix one, turn it into a normal check.

**`samples/` is the most valuable thing in this repo.** Real production PDFs
from the bay, including ones that misparse. Adding a file there (and to the
`SAMPLES` table) is how a new layout gets supported without silently breaking
the layouts that already work. Never delete from it. The repo is public, so
check with the bay before adding a file.

## Testing on a tablet before merging

Every change goes on a branch with a pull request; never push to `main`. To try
a branch on the real tablet setup:

`https://raw.githack.com/natnewcombe/frame-ticker/<branch>/index.html`

Saves from there are real Smartsheet and Supabase writes, so use a test job.
localStorage is per address, so the Worker URL and APP_KEY need entering once
on that address.

## Conventions

- One file, CSS and JS inline. Don't extract to separate files, don't
  introduce a build step, don't add a framework.
- Comments explain **why**, especially where the code looks odd but is
  deliberate (the pinch anchoring, the rAF batching, raw vs viewport
  coordinates). Keep them when editing nearby code.
- Touch targets are large. This is used in a workshop, sometimes with gloves.
- The design system is the Austruss palette already in the `:root` block.
  Orange `#F26B22`, charcoal `#262524`. Don't restyle.
- Commit before any large edit so there's a clean diff to review and revert to.
