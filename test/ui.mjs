/**
 * test/ui.mjs — boots index.html in jsdom and clicks through it
 * ---------------------------------------------------------------------------
 * Catches the failures that a parser test can't: a renamed element id, a
 * listener wired to the wrong button, a screen that renders nothing, a save
 * that uploads the wrong thing. It runs the app's real inline JS, so it breaks
 * when the app breaks.
 *
 *   node test/ui.mjs
 *
 * pdf.js and pdf-lib are stubbed rather than loaded: this harness is about the
 * UI's wiring, and test/parsers.mjs already runs the real thing against real
 * PDFs. Neither Smartsheet nor Supabase is contacted; fetch is stubbed too.
 *
 * "GAP" lines pin behaviour that is known to be wrong, so a fix shows up as a
 * deliberate change to this file rather than slipping in unnoticed. When a
 * gap is fixed, turn its line into an ordinary check of the new behaviour.
 */
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'index.html');

let failures = 0, gaps = 0;
function check(label, actual, expected){
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if(!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + label +
    (ok ? '  (' + JSON.stringify(actual) + ')'
        : '\n         expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)));
}
// Same as check, but the expectation is today's known-wrong behaviour.
function gap(label, actual, expected){
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if(ok) gaps++; else failures++;
  console.log((ok ? '  GAP  ' : '  FAIL ') + label +
    (ok ? '  (' + JSON.stringify(actual) + ')'
        : '\n         behaviour changed: expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) +
          '\n         if this is the fix, turn this GAP into a check of the new behaviour'));
}

/* ------------------------------------------------------------------- setup */
const src = fs.readFileSync(APP, 'utf8');
// jsdom has no network; the CDN tags are replaced by the stubs below.
const html = src.replace(/<script src="https:[^"]*"><\/script>/g, '');
// A real origin, otherwise localStorage throws for an opaque origin.
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://local.test/' });
const w = dom.window;
const d = w.document;

function fakePdf(pages){
  return { numPages: pages, getPage: async () => ({
    rotate: 0,
    getViewport: () => ({ width: 800, height: 600, convertToViewportPoint: (x, y) => [x, y] }),
    getTextContent: async () => ({ items: [] }),
    render: () => ({ promise: Promise.resolve() })
  })};
}
w.pdfjsLib = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve(fakePdf(3)) }) };
w.PDFLib = {};
w.HTMLCanvasElement.prototype.getContext = () => ({});
w.fetch = async () => ({ ok: true, json: async () => ({}), text: async () => '' });

const runtimeErrors = [];
w.addEventListener('error', e => runtimeErrors.push(e.message));
// Button handlers are async, so their errors surface as rejections, not
// window errors.
process.on('unhandledRejection', e => runtimeErrors.push('unhandled rejection: ' + (e && e.message || e)));

// Expose the app's internals so the harness can drive them directly. Keep this
// list in step with the app: a name that disappears here is a rename to notice.
const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]).join('\n');
const expose = '\n;Object.assign(window,{Store,AppState,CONFIG,renderJobList,renderFrameList,showScreen,' +
               'setTabbarVisible,openJob,getWorkOrders,renderSessionList,updateSessionBar});';
try{
  w.eval(code + expose);
}catch(e){
  console.log('BOOT ERROR: ' + e.message);
  process.exit(1);
}
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, ms = 2000){
  const end = Date.now() + ms;
  while(!cond()){ if(Date.now() > end) return false; await tick(); }
  return true;
}
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const $ = id => d.getElementById(id);
const active = id => $(id).classList.contains('active');

/* ------------------------------------------------------------------- boot */
console.log('\nboot');
check('setup screen shown when unconfigured', active('screen-setup'), true);

/* ------------------------------------------------------------ work orders */
console.log('\nwork orders from the Smartsheet report');
const cell = (col, value, displayValue) => ({ virtualColumnId: col, value, displayValue });
w.fetch = async () => ({ ok: true, json: async () => ({
  columns: ['Primary', 'Work Order Type', 'Project & Zone Number', 'Complete', 'F_Profile', 'Designer']
    .map((title, i) => ({ title, virtualId: i + 1 })),
  rows: [
    { id: 1, sheetId: 2, cells: [cell(1, 'W-100'), cell(2, 'FRAMECAD'), cell(3, 'UNIT 5'), cell(4, 'Not Started'),
                                 cell(5, '90mm x 0.75'), cell(6, 'des@austruss.com.au', 'Dee Signer')] },
    { id: 3, sheetId: 2, cells: [cell(1, 'W-101'), cell(2, 'STRUCTURAL'), cell(3, 'ZONE 1'), cell(4, 'Not Started')] },
    { id: 4, sheetId: 2, cells: [cell(1, 'W-102'), cell(2, 'FRAMECAD'), cell(3, 'ZONE 2'), cell(4, 'Complete')] }
  ] }) });
w.eval("Store.setWorkerUrl('https://x.workers.dev'); Store.setAppKey('k');");
const jobs = JSON.parse(await w.eval('getWorkOrders().then(j => JSON.stringify(j))'));
check('only FRAMECAD jobs that are not Complete', jobs.map(j => j.workOrderId), ['W-100']);
check('gauge read from F_Profile, designer by name not email', [jobs[0].gauge, jobs[0].designer], ['90', 'Dee Signer']);

/* --------------------------------------------------------------- job list */
console.log('\njob list');
w.eval(`
  AppState.jobs = [
    {rowId:1, sheetId:2, workOrderId:'W-100', zone:'UNIT 5', complete:'Not Started', gauge:'90'},
    {rowId:5, sheetId:2, workOrderId:'W-103', zone:'ZONE 16', complete:'Partially Complete', sessionCount: 2}
  ];
  setTabbarVisible(true); showScreen('screen-jobs'); renderJobList();
`);
check('both jobs render', d.querySelectorAll('.job-card').length, 2);
check('partial badge on the part-done job', d.querySelectorAll('.job-card .badge.partial').length, 1);
w.eval('AppState.jobs = []; renderJobList();');
check('no jobs shows empty state', !!d.querySelector('#jobListContainer .empty'), true);

/* ------------------------------------------------ opening a job: files */
console.log('\nopening a job: picking the report and drawings');
const REPORT = '26040-LGS-3-600 [1] UNIT 5 - Detailer - Report - 90_LB Walls.pdf';
const DRAWINGS = '26040-LGS-3-201 [3] UNIT 5 - Walls - 90mm - LB.pdf';
const calls = [];
let rowAttachments = [];
function route(url, opts){
  url = String(url);
  calls.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body });
  const json = body => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });
  if(url.includes('/rows/') && url.includes('/attachments')) return json({ data: rowAttachments });
  if(url.includes('/download')) return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  if(url.includes('/upload')) return json({ result: {} });
  if(url.includes('/rest/v1/')) return json([]);
  return json({});
}
w.fetch = async (url, opts) => route(url, opts);
const att = (id, name, day = '01') => ({ id, name, attachmentType: 'FILE', createdAt: '2026-09-' + day + 'T00:00:00Z' });

// The parsers are covered against real PDFs by test/parsers.mjs; here they
// return a small fixed job so the screens have something to show.
w.eval(`
  extractDetailerReport = async () => ({
    header: { client:'X', jobNumber:'26040', title:'UNIT 5', sectionTitle:'90_LB Walls', frameCount:3 },
    frames: [
      {name:'L500', label:'L500', tags:[], totalLength:'20.00 m', fasteners:'40', totalWeight:'30.0 kg', extraColumns:'', page:1, y:600, x:30},
      {name:'L501', label:'L501 (WELD)', tags:['WELD'], totalLength:'10.50 m', fasteners:'20', totalWeight:'15.0 kg', extraColumns:'', page:1, y:590, x:30},
      {name:'N101-1', label:'N101-1', tags:[], totalLength:'5.25 m', fasteners:'12', totalWeight:'8.0 kg', extraColumns:'', page:1, y:580, x:30}
    ]
  });
  buildDrawingIndex = async () => [
    {page:1, drawingNumber:'L500', tags:[]},
    {page:2, drawingNumber:'L501', tags:['WELD ALL']},
    {page:3, drawingNumber:'N101', tags:[]}
  ];
`);

// Report-only job (studs, bridging): one PDF on the row.
rowAttachments = [att(40, '90mm STUDS REPORT.pdf')];
w.eval("openJob({rowId:9, sheetId:2, workOrderId:'W-104', zone:'UNIT 5 STUDS'})");
await waitFor(() => $('modalOverlay').classList.contains('show'));
check('report-only job: asks which file is the report', $('modalTitle').textContent, 'Which file is the detailer report?');
click(d.querySelector('#modalList .pick-row'));
await tick(50);
gap('report-only job: then asks for drawings from an empty list, and never opens',
  [$('modalTitle').textContent, d.querySelectorAll('#modalList .pick-row').length, $('modalOverlay').classList.contains('show')],
  ['Which file has the production drawings?', 0, true]);
w.eval('closeModal()');

// Normal job. The real report names don't match CONFIG.DETAILER_NAME_RE, so
// the operator picks it; the bay has accepted that.
rowAttachments = [att(10, REPORT), att(11, DRAWINGS), att(12, 'IN PROGRESS: 90 - LB WALLS.pdf'), att(13, 'notes.dxf')];
w.eval("openJob({rowId:1, sheetId:2, workOrderId:'W-100', zone:'UNIT 5'})");
await waitFor(() => $('modalOverlay').classList.contains('show'));
check('picker lists only the original PDFs (no IN PROGRESS, no .dxf)',
  [...d.querySelectorAll('#modalList .pick-row .fname')].map(e => e.textContent.trim()), [REPORT, DRAWINGS]);
click(d.querySelectorAll('#modalList .pick-row')[0]);
await waitFor(() => d.querySelectorAll('#frameList .frame-row').length === 3);
const downloads = calls.filter(c => c.url.includes('/download')).map(c => new URL(c.url).searchParams.get('attachmentId'));
check('with one file left, it is taken as the drawings: both downloaded', downloads.slice(-2).sort(), ['10', '11']);
check('report screen shows every frame', d.querySelectorAll('#frameList .frame-row').length, 3);
check('counts', [$('doneCount').textContent, $('totalCount').textContent], ['0', '3']);
await waitFor(() => w.eval('AppState.drawingPages.length') === 3);

/* ------------------------------------------------------ ticking frames */
console.log('\nticking frames');
const rows = () => d.querySelectorAll('#frameList .frame-row');
click(rows()[0]);
check('tapping a frame ticks it', [rows()[0].classList.contains('done'), $('doneCount').textContent], [true, '1']);
check('progress kept on the device per job', w.localStorage.getItem('fc_job_1'), '{"done":["L500"]}');
click(rows()[0]);
check('tapping again unticks it', [rows()[0].classList.contains('done'), $('doneCount').textContent], [false, '0']);
click(rows()[0]);

$('searchInput').value = 'weld';
$('searchInput').dispatchEvent(new w.Event('input'));
check('search matches the label and tags', [...rows()].map(r => r.querySelector('.name').textContent.split('WELD')[0].trim()), ['L501 (']);
check('counts still cover all frames while searching', [$('doneCount').textContent, $('totalCount').textContent], ['1', '3']);
click($('btnClearSearch'));
check('clearing search shows everything again', rows().length, 3);

w.eval("AppState.issuesByFrame = { L501: [{ note: 'bent stud', created_at: '2026-09-01T00:00:00Z' }] }; renderFrameList();");
check('a frame with a noted issue is flagged', d.querySelectorAll('#frameList .btn-note-issue.has-issue').length, 1);

/* -------------------------------------------------------- view drawing */
console.log('\nview drawing (📄)');
click(rows()[1].querySelector('.btn-view-drawing'));
await tick(50);
check('jumps to the frame\'s drawing page', [active('screen-drawings'), w.eval('AppState.drawingsPage')], [true, 2]);
check('page tag chips shown', d.querySelectorAll('#pageTagRow .tag-chip').length, 1);
w.eval("showScreen('screen-report')");
click(rows()[2].querySelector('.btn-view-drawing'));
await tick(50);
gap('a copy (N101-1) does not find its drawing (N101)', $('toast').textContent, 'No drawing found for N101-1');
gap('every frame gets a 📄 button, even with no drawing to go to', d.querySelectorAll('#frameList .btn-view-drawing').length, 3);

/* ------------------------------------------------- start job + save */
console.log('\nstart job and save progress');
check('Start Job shown before a session', $('btnStartJob').style.display, 'block');
click($('btnStartJob'));
check('Start Job swaps to the session status', [$('btnStartJob').style.display, $('sessionStatus').style.display], ['none', 'block']);
check('session start kept on the device with the frames done so far',
  JSON.parse(w.localStorage.getItem('fc_session_1')).doneAtStart, ['L500']);
check('Start Job alone writes nothing', calls.filter(c => c.method === 'POST').length, 0);
click(rows()[1]);   // L501 done during the session

w.eval('annotateDetailerPdf = async () => new Uint8Array([1, 2, 3]);');
rowAttachments = [att(10, REPORT), att(11, DRAWINGS)];   // never saved before
calls.length = 0;
click($('btnSaveProgress'));
await waitFor(() => $('btnSaveProgress').textContent === 'Save Progress' && !$('btnSaveProgress').disabled && calls.length);
let uploads = calls.filter(c => c.url.includes('/upload'));
let up = uploads[0] ? new URL(uploads[0].url).searchParams : new URLSearchParams();
check('one upload', uploads.length, 1);
check('first save: a new IN PROGRESS file named from the report section',
  [up.get('mode'), up.get('rowId'), up.get('filename')], ['new', '1', 'IN PROGRESS: 90 - LB WALLS.pdf']);
const logCall = calls.find(c => c.url.includes('/rest/v1/session_log') && c.method === 'POST');
const logged = logCall ? JSON.parse(logCall.body) : {};
check('session logged to Supabase with only this session\'s frames',
  [logged.frames_completed_this_session, logged.frames_completed_count, logged.linear_metres_this_session],
  [['L501'], 1, 10.5]);
check('and the job totals at this save', [logged.total_frames_done, logged.total_linear_metres_done], [2, 30.5]);
check('session cleared after saving',
  [$('sessionStatus').style.display, w.localStorage.getItem('fc_session_1')], ['none', null]);

// Second save: the IN PROGRESS file now exists, so it gets a new version.
// Two with the same name: the newest is the live one.
rowAttachments.push(att(54, 'IN PROGRESS: 90 - LB WALLS.pdf', '02'), att(55, 'IN PROGRESS: 90 - LB WALLS.pdf', '03'));
calls.length = 0;
click($('btnSaveProgress'));
await waitFor(() => $('btnSaveProgress').textContent === 'Save Progress' && !$('btnSaveProgress').disabled && calls.length);
uploads = calls.filter(c => c.url.includes('/upload'));
up = uploads[0] ? new URL(uploads[0].url).searchParams : new URLSearchParams();
check('later saves: a new version of the latest IN PROGRESS file',
  [up.get('mode'), up.get('attachmentId'), up.get('filename')], ['version', '55', 'IN PROGRESS: 90 - LB WALLS.pdf']);
check('no session running: nothing logged', calls.some(c => c.url.includes('/rest/v1/session_log')), false);

/* ------------------------------------------------------------ sessions */
console.log('\nsessions list');
w.eval(`renderSessionList([
  { session_start:'2026-09-01T07:00:00Z', saved_at:'2026-09-01T09:00:00Z', frames_completed_this_session:['L501'],
    frames_completed_count:1, linear_metres_this_session:10.5, total_frames_done:2, total_linear_metres_done:30.5 }
])`);
check('one card per session', d.querySelectorAll('#modalList .session-card').length, 1);

console.log('\nruntime errors: ' + (runtimeErrors.length ? runtimeErrors.join('; ') : 'none'));
console.log(failures + ' failure(s), ' + gaps + ' known gap(s) pinned.');
process.exit(failures || runtimeErrors.length ? 1 : 0);
