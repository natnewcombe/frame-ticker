/**
 * test/parsers.mjs — runs the app's REAL parsers against every PDF in samples/
 * ---------------------------------------------------------------------------
 * The point of this harness is that it doesn't reimplement anything. It pulls
 * the parser functions straight out of index.html and runs them in Node
 * against the same pdf.js version the tablet loads from the CDN, so a pass
 * here means the tablet will behave the same way.
 *
 *   node test/parsers.mjs                  # every job in the SAMPLES table
 *   node test/parsers.mjs 26018            # only jobs with a file name containing "26018"
 *   node test/parsers.mjs --annotate       # also write marked-up reports to test/out/
 *
 * Add every report or drawing set that misparses to samples/ (and to the
 * SAMPLES table below) and leave it there permanently. That's what stops a
 * fix for one layout quietly breaking the others.
 */
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// pdf.js prints font and canvas warnings that don't matter in Node. Drop them
// so the report below stays readable.
const log = console.log;
console.log = (...a) => { if(typeof a[0] === 'string' && a[0].startsWith('Warning:')) return; log(...a); };
console.warn = () => {};

const require = createRequire(import.meta.url);
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const PDFLib = require('pdf-lib');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'index.html');
const SAMPLES_DIR = path.join(ROOT, 'samples');
const OUT = path.join(ROOT, 'test', 'out');

/* ---------------------------------------------------------------------------
   What each sample is. The app can't be trusted to tell a report from its
   drawings by file name (the operator picks by hand on most jobs), so the
   pairing is written down here, as confirmed by the bay.
   drawings: null means a report-only job: studs, bridging and other plain
   sticks have no production drawings.
   ------------------------------------------------------------------------- */
const SAMPLES = [
  { report: '150 Bulkhead Frames Z1 - Report.pdf',
    drawings: '150 Bulkhead Frames Z1 - Production Drawing.pdf' },
  { report: '150mm - PANELS - Report.pdf',
    drawings: '25363-LGS-A3-200 [A] ZONE A3 - PRODUCTION - 150 - PANELS.pdf' },
  { report: '90 Gable Frames.pdf',
    drawings: '22095-LGS-B1-250 [A] Unit 183 - Gable Frames - 90 mm.pdf' },
  { report: '24477-LGS-C2-600 [1] ZONE C2 - Detailer - Report - 150mm Walls.pdf',
    drawings: '24477-LGS-C2-200 [A] ZONE C2 - PRODUCTION - 150mm WALLS.pdf' },
  { report: '26018-LGS-H-600 [A] BUILDING H - Detailer - Report_204_150 WALLS_H5.pdf',
    drawings: '26018-LGS-H-204 [E] BUILDING H - Walls - 150_H5.pdf' },
  { report: '26040-LGS-3-600 [1] UNIT 5 - Detailer - Report - 90_LB Walls.pdf',
    drawings: '26040-LGS-3-201 [3] UNIT 5 - Walls - 90mm - LB.pdf' },
  { report: 'Report_75_Trusses_Zone 16.pdf',
    drawings: '26110-LGS-16-220 [C] ZONE 16 - Trusses.pdf' },
  { report: '90mm STUDS REPORT.pdf', drawings: null }
];
// Kept in samples/ for later work, but the app doesn't open them yet.
const IGNORED = {
  '24477-LGS-C1-621 [A] ZONE C2 - Pack lists - 150mm Walls.pdf': 'pack list: not used by the app yet'
};

const args = process.argv.slice(2);
const wantAnnotate = args.includes('--annotate');
const filter = (args.filter(a => !a.startsWith('--'))[0] || '').toLowerCase();

/* ---------------------------------------------------------------------------
   Extract the parser half of the app's inline JS.
   Everything before the "APP STATE" banner is pure logic with no DOM in it;
   everything after touches document/localStorage and belongs to test/ui.mjs.
   If that banner is ever renamed, this is the one line to update.
   ------------------------------------------------------------------------- */
function loadParsers(){
  const src = fs.readFileSync(APP, 'utf8');
  const firstScript = src.split('<script>')[1];
  if(!firstScript) throw new Error('No inline <script> found in ' + APP);
  const marker = '/* =========================================================================\n   APP STATE';
  const idx = firstScript.indexOf(marker);
  if(idx === -1) throw new Error('APP STATE banner not found: update the marker in test/parsers.mjs');
  let code = firstScript.slice(0, idx);
  // The worker path is a browser-only concern and would 404 here.
  code = code.replace(/pdfjsLib\.GlobalWorkerOptions[\s\S]*?;\n/, '');

  const ctx = {
    pdfjsLib, PDFLib,
    localStorage: { getItem(){ return null; }, setItem(){}, removeItem(){} },
    document: { getElementById(){ return {}; } },
    navigator: {}, fetch
  };
  const fn = new Function(...Object.keys(ctx), code + `
    return { CONFIG, loadPdf, extractDetailerReport, buildDrawingIndex,
             annotateDetailerPdf, extractTags, markupKeywords, parseMarkupKeywords };`);
  return fn(...Object.values(ctx));
}

const api = loadParsers();
const bytes = f => new Uint8Array(fs.readFileSync(path.join(SAMPLES_DIR, f)));

/* ------------------------------------------------------------------ report */
let failures = 0;
function fail(msg){ failures++; console.log('  FAIL: ' + msg); }
const list = (xs, n = 8) => xs.slice(0, n).join(', ') + (xs.length > n ? ' … (+' + (xs.length - n) + ' more)' : '');

async function checkReport(file){
  console.log('\n--- report: ' + file);
  const { header, frames } = await api.extractDetailerReport(await api.loadPdf(bytes(file)));
  console.log('  header:', JSON.stringify(header));
  if(frames.length){
    console.table(frames.map(f => ({
      name: f.name, label: f.label, tags: f.tags.join(', '), total: f.totalLength,
      fasteners: f.fasteners, weight: f.totalWeight, extra: f.extraColumns, page: f.page
    })));
  }
  // The report states its own frame count, so it can check itself: every
  // frame it lists should be a row the operator can tick.
  if(header.frameCount === null) fail('no "Frame Count :" line found');
  else if(frames.length !== header.frameCount){
    fail('report says ' + header.frameCount + ' frames, the app lists ' + frames.length +
         ' (the rest can\'t be ticked off)');
  } else console.log('  ' + frames.length + ' of ' + header.frameCount + ' frames');
  const names = frames.map(f => f.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if(dupes.length) fail('duplicate frame names, ticking one ticks both: ' + list([...new Set(dupes)]));

  if(wantAnnotate && frames.length){
    const done = new Set(frames.filter((f, i) => i % 2 === 0).map(f => f.name));
    const out = path.join(OUT, path.basename(file, '.pdf') + '.annotated.pdf');
    fs.writeFileSync(out, await api.annotateDetailerPdf(bytes(file), frames, done));
    console.log('  wrote ' + path.relative(ROOT, out) + ' (every other frame ticked)');
  }
  return frames;
}

async function checkDrawings(file){
  console.log('\n--- drawings: ' + file);
  const pdf = await api.loadPdf(bytes(file));
  const pages = await api.buildDrawingIndex(pdf);
  console.table(pages.map(p => ({ page: p.page, drawing: p.drawingNumber, tags: p.tags.join(', ') })));
  const unidentified = pages.filter(p => !p.drawingNumber).map(p => p.page);
  console.log('  ' + (pages.length - unidentified.length) + ' of ' + pages.length + ' pages identified');
  if(unidentified.length){
    // Say whether the page has any text at all: a flattened or scanned page
    // can't be read by any rule, which is a different problem from a layout
    // the rules don't know yet.
    const noText = [];
    for(const n of unidentified){
      const c = await (await pdf.getPage(n)).getTextContent();
      if(!c.items.some(i => i.str.trim())) noText.push(n);
    }
    fail(unidentified.length + ' page(s) with no drawing number: ' + list(unidentified) +
         (noText.length === unidentified.length ? ' (no text layer at all: flattened or scanned)'
          : noText.length ? ' (' + noText.length + ' of them have no text layer)' : ''));
  }
  const nums = pages.map(p => p.drawingNumber).filter(Boolean);
  const dupes = nums.filter((n, i) => nums.indexOf(n) !== i);
  if(dupes.length) console.log('  note: drawing number on more than one page: ' + list([...new Set(dupes)]));
  return pages;
}

// Can the 📄 button on each frame find its drawing? This mirrors the match in
// jumpToFrameDrawing (exact, upper-cased). That function lives below the APP
// STATE banner, so it can't be called from here; if the match moves into a
// helper above the banner, call that helper here instead.
function checkPair(frames, pages){
  const nums = new Set(pages.map(p => p.drawingNumber).filter(Boolean));
  const missing = frames.filter(f => !nums.has(f.name.toUpperCase())).map(f => f.name);
  console.log('  view drawing: ' + (frames.length - missing.length) + ' of ' + frames.length + ' frames find their page');
  if(missing.length) fail(missing.length + ' frame(s) whose 📄 button finds no drawing: ' + list(missing));
}

/* -------------------------------------------------------------------- main */
if(!fs.existsSync(SAMPLES_DIR)){
  console.error('No samples/ folder. Put real production PDFs in samples/ first.');
  process.exit(1);
}
if(wantAnnotate) fs.mkdirSync(OUT, { recursive: true });

// Every PDF in samples/ must be accounted for, so a new sample can't sit
// there untested.
const onDisk = fs.readdirSync(SAMPLES_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));
const listed = new Set(SAMPLES.flatMap(s => [s.report, s.drawings]).filter(Boolean).concat(Object.keys(IGNORED)));
onDisk.filter(f => !listed.has(f)).forEach(f => fail('samples/' + f + ' is not in the SAMPLES table in test/parsers.mjs'));
[...listed].filter(f => !onDisk.includes(f)).forEach(f => fail('SAMPLES table names ' + f + ' but it is not in samples/'));

const jobs = SAMPLES.filter(s => !filter ||
  [s.report, s.drawings].some(f => f && f.toLowerCase().includes(filter)));
if(!jobs.length){
  console.error('No jobs in the SAMPLES table match "' + filter + '"');
  process.exit(1);
}

for(const job of jobs){
  console.log('\n=== ' + job.report + (job.drawings ? '' : '  [report only, no drawings]'));
  try{
    const frames = await checkReport(job.report);
    if(job.drawings){
      const pages = await checkDrawings(job.drawings);
      checkPair(frames, pages);
    }
  }catch(e){
    fail('threw: ' + e.message);
  }
}
Object.entries(IGNORED).forEach(([f, why]) => {
  if(!filter || f.toLowerCase().includes(filter)) console.log('\n=== ' + f + '  [skipped: ' + why + ']');
});

// Save Progress versions the original report, and the next open finds its
// way back to the clean report through PDF keywords. Check that note survives
// a real pdf-lib write and pdf.js read on a real marked-up report. Also check
// that a markup still parses to every frame, as a second line of defence if
// the app ever did read one (its marks would still stack on the next save).
if(!filter){
  const f = SAMPLES[SAMPLES.length - 1].report;
  console.log('\n=== markup note round-trip  [' + f + ']');
  try{
    const { frames } = await api.extractDetailerReport(await api.loadPdf(bytes(f)));
    const done = new Set(frames.slice(0, 3).map(fr => fr.name));
    const doc = await PDFLib.PDFDocument.load(await api.annotateDetailerPdf(bytes(f), frames, done));
    doc.setKeywords(api.markupKeywords({ sourceId: '123456', skipId: '789' }));
    const markup = await doc.save();
    const meta = await (await api.loadPdf(markup.slice())).getMetadata();
    const note = api.parseMarkupKeywords(meta.info && meta.info.Keywords);
    console.log('  read back: ' + JSON.stringify(note));
    if(!note || note.sourceId !== '123456' || note.skipId !== '789') fail('markup note did not survive pdf-lib -> pdf.js');
    const plain = await (await api.loadPdf(bytes(f))).getMetadata();
    if(api.parseMarkupKeywords(plain.info && plain.info.Keywords)) fail('an untouched report reads as a markup');
    const reread = (await api.extractDetailerReport(await api.loadPdf(markup.slice()))).frames.length;
    console.log('  parsing the markup lists ' + reread + ' of ' + frames.length + ' frames');
    if(reread !== frames.length) fail('reading a marked-up report loses frames');
  }catch(e){ fail('markup round-trip threw: ' + e.message); }
}

console.log('\n' + jobs.length + ' job(s) checked, ' + failures + ' problem(s).');
process.exit(failures ? 1 : 0);
