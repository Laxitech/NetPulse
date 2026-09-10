import puppeteer from 'puppeteer-core';

const URL = process.env.NETPULSE_URL || 'http://localhost:3000';
const CHROME = '/usr/bin/google-chrome';
const DEST = process.env.NETPULSE_DEST || '8.8.8.8';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 15000 });
await sleep(500);

// 1. Initial render
const statsInit = await page.evaluate(() => !!document.querySelector('#stat-hops'));
console.log('stats initialized:', statsInit);

// 2. Start a trace
await page.type('#destination', DEST);
await page.click('#traceBtn');
await sleep(500);

// 2b. Background image should be applied to <body>
const bg = await page.evaluate(() => {
  const s = window.getComputedStyle(document.body);
  return s.backgroundImage.includes('bg-route-canvas.jpg') ? s.backgroundImage : 'NOT SET';
});
console.log('body background:', bg.slice(0, 80));
const bgOk = bg !== 'NOT SET';

// 3. Wait for at least one hop row
await page.waitForSelector('#hopTableBody tr', { timeout: 20000 }).catch(() => {});
await sleep(3000);
const hopCount = await page.evaluate(() => document.querySelectorAll('#hopTableBody tr').length);
console.log('hops rendered in table:', hopCount);

// 4. Graph canvas should have drawn something (non-transparent pixels would be ideal;
//    simpler: check canvas dimensions are non-zero and node count via internal state)
const canvasState = await page.evaluate(() => {
  const c = document.querySelector('#networkGraph');
  return { w: c ? c.width : 0, h: c ? c.height : 0 };
});
console.log('canvas size:', canvasState.w, 'x', canvasState.h);

// 5. Stats should show hop count
const statHops = await page.evaluate(() => document.querySelector('#stat-hops').textContent.trim());
console.log('stat hops:', statHops);

// 5b. Live "traveler" marker + real map tiles (proves no API-key tile errors)
await page.waitForFunction(
  () => !!document.querySelector('.traveler-marker') && document.querySelectorAll('.leaflet-tile-loaded').length > 0,
  { timeout: 20000 }
).catch(() => {});
const mapLive = await page.evaluate(() => {
  const t = document.querySelector('.traveler-marker');
  return {
    traveler: !!t,
    travelerOpacity: t ? window.getComputedStyle(t).opacity : 'absent',
    loadedTiles: document.querySelectorAll('.leaflet-tile-loaded').length,
  };
});
console.log('traveler + tiles:', mapLive);

// 6. Wait for trace completion
await page.waitForFunction(
  () => {
    const t = document.querySelector('#traceStatus');
    return t && /COMPLETE|STOPPED|ERROR/i.test(t.textContent);
  },
  { timeout: 60000 }
).catch(() => {});
const traceStatus = await page.evaluate(() => document.querySelector('#traceStatus').textContent.trim());
console.log('final trace status:', traceStatus);

// 7. Destination stat
const statDest = await page.evaluate(() => document.querySelector('#stat-dest').textContent.trim());
console.log('destination stat:', statDest);

// 8. Map geometry (Leaflet with preferCanvas:true paints circle markers + route
//    onto an overlay canvas; the destination star is a DOM divIcon in the marker pane)
const mapPanes = await page.evaluate(() => ({
  hasLeaflet: !!document.querySelector('.leaflet-container'),
  destMarker: !!document.querySelector('.dest-marker'),
  overlayCanvas: document.querySelectorAll('.leaflet-overlay-pane canvas').length,
}));
console.log('map panes:', mapPanes);

// 9. Select the last hop row and verify details panel updates
await page.evaluate(() => {
  const rows = document.querySelectorAll('#hopTableBody tr');
  if (rows.length) rows[rows.length - 1].click();
});
await sleep(300);
const detailText = await page.evaluate(() => document.querySelector('#infoCard').textContent.slice(0, 120).replace(/\s+/g, ' ').trim());
console.log('details panel:', detailText);

console.log('JAVASCRIPT ERRORS:', errors.length ? errors : 'none');

// 10. Dark theme toggle
const theme = await page.evaluate(() => {
  const before = document.documentElement.getAttribute('data-theme');
  document.querySelector('#themeToggle').click();
  return {
    before,
    after: document.documentElement.getAttribute('data-theme'),
    stored: localStorage.getItem('netpulse-theme'),
  };
});
console.log('theme toggle:', theme);
const themeOk = theme.before === 'light' && theme.after === 'dark' && theme.stored === 'dark';

const destReached = /REACHED/.test(statDest);
console.log('expectation: reachable =', destReached, '| dest star present =', mapPanes.destMarker);

const ok =
  statsInit && hopCount > 0 && canvasState.w > 0 && statHops === String(hopCount) &&
  /COMPLETE|UNREACHABLE/.test(traceStatus) && mapPanes.hasLeaflet && mapLive.traveler &&
  mapLive.loadedTiles > 0 && mapLive.travelerOpacity !== '0' &&
  mapPanes.destMarker === destReached && // star only when destination reached
  themeOk && errors.length === 0;

await browser.close();
console.log(ok ? 'SMOKE TEST: PASS' : 'SMOKE TEST: FAIL');
process.exit(ok ? 0 : 1);