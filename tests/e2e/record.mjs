// Records the demo story to docs/media/:
//
//   demo-story.mp4    the whole story at its real pace, 780 × 1688 (390 × 844 @2x), H.264
//   demo-story.gif    a looping highlight reel (the reveal of every slide) for a README
//
//   npm run record                 capture + encode (needs ffmpeg on PATH; takes ~8 minutes)
//   npm run record -- --gif-only   rebuild the GIF from the existing mp4
//
// Capture is frame by frame: the player's clock is taken over with WrappedStory.seek(), so
// every frame is rendered exactly, whatever the speed of the machine. That is what a
// screen recording on a fast phone looks like, without dropped frames. Outputs are committed.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { ROOT, startServer, launch, waitForStory } from './lib.mjs';

const OUT = path.join(ROOT, 'docs/media');
const FPS = 30;
const VIEW = { width: 390, height: 844 };
const LAST_SLIDE_MS = 4200;
const gifOnly = process.argv.includes('--gif-only');
fs.mkdirSync(OUT, { recursive: true });

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + args.join(' '));
}

const mp4 = path.join(OUT, 'demo-story.mp4');

if (!gifOnly) {
  const server = await startServer();
  const browser = await launch();
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => { throw e; });
  await page.goto(server.url + '?demo=1');
  await waitForStory(page);

  const slides = await page.evaluate(() => {
    const S = window.WrappedStory;
    const out = [];
    for (let i = 0; i < S.total; i++) { S.goTo(i); out.push({ id: S.slideIds[i], duration: S.duration }); }
    S.goTo(0);
    S.seek(0);
    return out;
  });

  const encoder = spawn('ffmpeg', [
    '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
    '-an',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '25', '-profile:v', 'high', '-level', '4.2',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-movflags', '+faststart',
    mp4,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });

  let total = 0;
  const timelineOut = [];
  const t0 = Date.now();
  for (let i = 0; i < slides.length; i++) {
    const ms = i === slides.length - 1 ? LAST_SLIDE_MS : slides[i].duration;
    const frames = Math.round((ms / 1000) * FPS);
    timelineOut.push({ id: slides[i].id, start: total / FPS, seconds: frames / FPS });
    for (let f = 0; f < frames; f++) {
      await page.evaluate(([index, t]) => {
        const S = window.WrappedStory;
        if (S.index !== index) S.goTo(index);
        S.seek(t);
      }, [i, (f * 1000) / FPS]);
      const png = await page.screenshot();
      if (!encoder.stdin.write(png)) await once(encoder.stdin, 'drain');
      total++;
    }
    console.log(`  ${String(i + 1).padStart(2)} ${slides[i].id.padEnd(8)} ${frames} frames`);
  }
  encoder.stdin.end();
  const [code] = await once(encoder, 'close');
  if (code !== 0) throw new Error('ffmpeg exited with ' + code);
  await browser.close();
  await server.close();
  // Where each slide sits in the video, so the highlight reel can be rebuilt without recapturing.
  fs.writeFileSync(path.join(OUT, 'demo-story.json'), JSON.stringify({ fps: FPS, width: VIEW.width * 2, height: VIEW.height * 2, slides: timelineOut }, null, 2) + '\n');
  console.log(`demo-story.mp4  ${(fs.statSync(mp4).size / 1e6).toFixed(2)} MB, ${total} frames, ${(total / FPS).toFixed(1)} s, captured in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

// ── highlight reel ─────────────────────────────────────────────────────────────────────
// [slide, seconds into the slide where the cut starts, length of the cut]
const CUTS = [
  ['cover', 1.3, 2.3], ['total', 0.2, 2.1], ['clock', 0.4, 2.2], ['persona', 2.1, 2.2], ['late', 0.2, 2.0], ['week', 0.4, 1.9],
  ['year', 0.4, 1.9], ['senders', 0.5, 2.3], ['moty', 0.6, 3.0], ['taps', 0.3, 2.2], ['awards', 0.4, 2.4], ['sum', 0.3, 2.2],
];
const timeline = JSON.parse(fs.readFileSync(path.join(OUT, 'demo-story.json'), 'utf8'));
const parts = CUTS.map(([id, offset, length], k) => {
  const slide = timeline.slides.find((s) => s.id === id);
  if (!slide) throw new Error('no slide ' + id + ' in the recording');
  return `[0:v]trim=start=${(slide.start + offset).toFixed(3)}:duration=${Math.min(length, slide.seconds - offset).toFixed(3)},setpts=PTS-STARTPTS[p${k}]`;
});
const gif = path.join(OUT, 'demo-story.gif');
const chain = parts.join(';') + ';' + parts.map((_, k) => `[p${k}]`).join('')
  + `concat=n=${parts.length}:v=1:a=0,fps=12.5,scale=300:-2:flags=lanczos,split[a][b];`
  + '[a]palettegen=max_colors=176:stats_mode=diff[pal];[b][pal]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle';
ffmpeg(['-i', mp4, '-filter_complex', chain, '-loop', '0', gif]);
console.log(`demo-story.gif  ${(fs.statSync(gif).size / 1e6).toFixed(2)} MB`);
