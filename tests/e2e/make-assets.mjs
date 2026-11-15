// Regenerates the static link-preview assets that ship in web/assets/:
//
//   og.png              1200 × 630 still for og:image
//   og-video.mp4        5-second 1200 × 630 loop for og:video (H.264, yuv420p, faststart,
//                       no audio): Messages downloads it and plays it inside the preview
//   apple-touch-icon.png 180 × 180
//   favicon-32.png
//
//   npm run assets            (needs ffmpeg on PATH; the outputs are committed)
//
// The art is tests/e2e/assets-src/og.html, drawn frame by frame from one function of time.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ROOT, WEB, launch } from './lib.mjs';

const ASSETS = path.join(WEB, 'assets');
const SOURCE = path.join(ROOT, 'tests/e2e/assets-src/og.html');
const FPS = 30;
const SECONDS = 5;
const W = 1200;
const H = 630;

fs.mkdirSync(ASSETS, { recursive: true });
const browser = await launch();

// ── og.png + og-video.mp4 ──────────────────────────────────────────────────────────────
{
  const page = await (await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })).newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text()); });
  page.on('pageerror', (e) => { throw e; });
  await page.goto('file://' + SOURCE);
  await page.evaluate(() => Promise.all([document.fonts.ready, document.fonts.load('900 100px Archivo', 'A1')]));

  await page.evaluate(() => window.renderStill());
  await page.screenshot({ path: path.join(ASSETS, 'og.png'), clip: { x: 0, y: 0, width: W, height: H } });
  console.log('og.png', fs.statSync(path.join(ASSETS, 'og.png')).size, 'bytes');

  const out = path.join(ASSETS, 'og-video.mp4');
  const ffmpeg = spawn('ffmpeg', [
    '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
    '-an',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'veryslow', '-crf', '21', '-profile:v', 'high', '-level', '4.0',
    '-g', String(FPS * 2), '-bf', '2',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-movflags', '+faststart',
    out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const frames = FPS * SECONDS; // frame `frames` would equal frame 0, so the loop is seamless
  for (let f = 0; f < frames; f++) {
    await page.evaluate((t) => window.renderFrame(t), f / FPS);
    const png = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
    if (!ffmpeg.stdin.write(png)) await once(ffmpeg.stdin, 'drain');
  }
  ffmpeg.stdin.end();
  const [code] = await once(ffmpeg, 'close');
  if (code !== 0) throw new Error('ffmpeg exited with ' + code);
  console.log('og-video.mp4', fs.statSync(out).size, 'bytes,', frames, 'frames');
  await page.context().close();
}

// ── icons, from the hand-written favicon.svg ───────────────────────────────────────────
{
  const svg = fs.readFileSync(path.join(ASSETS, 'favicon.svg'), 'utf8');
  for (const [name, size, square] of [['apple-touch-icon.png', 180, true], ['favicon-32.png', 32, false]]) {
    const page = await (await browser.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })).newPage();
    // iOS rounds the corners of touch icons itself, so that one is a full square.
    const art = square ? svg.replace('rx="14"', 'rx="0"') : svg;
    await page.setContent(`<body>${art}</body>`);
    await page.addStyleTag({ content: `html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}` });
    await page.screenshot({ path: path.join(ASSETS, name), omitBackground: !square, clip: { x: 0, y: 0, width: size, height: size } });
    console.log(name, fs.statSync(path.join(ASSETS, name)).size, 'bytes');
    await page.context().close();
  }
}

await browser.close();
