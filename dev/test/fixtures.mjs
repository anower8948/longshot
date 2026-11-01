/**
 * Local HTTP server with pages engineered for pixel-exact verification.
 *
 * "Stripe" pages are built from 10-CSS-px bands whose colour encodes the band
 * index (R = i & 255, G = i >> 8, B = 200 or 100 by parity). Reading any column
 * of the stitched image back must yield indices increasing by exactly one,
 * each band exactly 10 × scale rows tall — any duplicated, missing or shifted
 * row breaks that sequence.
 */

import http from 'node:http';
import { PNG } from 'pngjs';

export const STRIPE = 10;

function stripeColor(i) {
  return `rgb(${i & 255},${(i >> 8) & 255},${i % 2 ? 100 : 200})`;
}

function stripes(height, { from = 0 } = {}) {
  const count = Math.ceil(height / STRIPE);
  let html = '';
  for (let k = 0; k < count; k += 1) {
    const i = from + k;
    const h = k === count - 1 ? height - STRIPE * k : STRIPE;
    html += `<div style="height:${h}px;background:${stripeColor(i)}"></div>`;
  }
  return html;
}

const BASE_CSS = `
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; }
`;

function page(title, body, { css = '', script = '' } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>${BASE_CSS}${css}</style></head><body>${body}<script>${script}</script></body></html>`;
}

const pages = {
  stripes(params) {
    const height = Number(params.get('h') || 12345);
    // Smooth scrolling and scroll snapping would break exact positioning if not neutralised.
    return page('Stripes', stripes(height), {
      css: 'html { scroll-behavior: smooth; scroll-snap-type: y proximity; } body > div:nth-child(37n) { scroll-snap-align: start; }',
    });
  },

  sticky() {
    return page(
      'Sticky',
      `<div style="display:flex">
        <aside style="width:200px;flex:none">
          <nav id="sticky-nav" style="position:sticky;top:0;height:300px;background:#ff00ff"></nav>
        </aside>
        <main style="flex:1">${stripes(8000)}</main>
      </div>`,
    );
  },

  fixed() {
    return page(
      'Fixed',
      `<header id="fixed-header" style="position:fixed;top:0;left:0;right:0;height:64px;background:#ff00ff;z-index:10"></header>
       <main style="padding-top:64px">${stripes(9000)}</main>
       <div id="bubble" style="position:fixed;right:24px;bottom:24px;width:64px;height:64px;border-radius:0;background:#00ff00;z-index:10"></div>
       <button id="to-top" style="position:fixed;left:24px;bottom:24px;width:80px;height:40px;background:#ff8800;border:0;display:none;z-index:10"></button>`,
      {
        script: `addEventListener('scroll', () => {
          document.getElementById('to-top').style.display = scrollY > 1500 ? 'block' : 'none';
        });`,
      },
    );
  },

  lazy() {
    const colors = ['ff0000', '00aa00', '0000ff', 'ffaa00', 'aa00ff', '00aaaa', 'aaaa00', 'ff0088', '008888', '884400', '004488', '448800'];
    const blocks = colors
      .map((color, index) => {
        const native = index % 2 === 0;
        const src = `/img/${color}.png?delay=500`;
        return `<section style="height:900px;padding-top:100px;background:#fff">
          <img class="${native ? '' : 'js-lazy'}" data-color="${color}" width="600" height="400"
            ${native ? `loading="lazy" src="${src}"` : `data-src="${src}"`}
            style="display:block;margin:0 auto;background:#ddd">
        </section>`;
      })
      .join('');
    return page('Lazy', blocks, {
      script: `const io = new IntersectionObserver((entries) => {
        for (const entry of entries) if (entry.isIntersecting) { entry.target.src = entry.target.dataset.src; io.unobserve(entry.target); }
      });
      document.querySelectorAll('.js-lazy').forEach((img) => io.observe(img));`,
    });
  },

  inner() {
    return page(
      'Inner scroller',
      `<header style="position:fixed;top:0;left:0;right:0;height:60px;background:#ff00ff"></header>
       <nav style="position:fixed;top:60px;left:0;bottom:0;width:240px;background:#222"></nav>
       <main id="scroller" style="position:fixed;top:60px;left:240px;right:0;bottom:0;overflow:auto">${stripes(7000)}</main>`,
      { css: 'html, body { overflow: hidden; height: 100%; }' },
    );
  },

  infinite() {
    return page('Infinite', `<div id="feed">${stripes(3000)}</div>`, {
      script: `let loaded = 1; let next = 300;
      addEventListener('scroll', () => {
        if (loaded >= 4) return;
        if (scrollY + innerHeight > document.documentElement.scrollHeight - 300) {
          loaded += 1;
          const feed = document.getElementById('feed');
          let chunk = '';
          for (let k = 0; k < 200; k += 1) {
            const i = next + k;
            chunk += '<div style="height:10px;background:rgb(' + (i & 255) + ',' + ((i >> 8) & 255) + ',' + (i % 2 ? 100 : 200) + ')"></div>';
          }
          next += 200;
          setTimeout(() => feed.insertAdjacentHTML('beforeend', chunk), 150);
        }
      });`,
    });
  },

  text() {
    const words = 'LongShot captures sharp full page screenshots that stay crisp when inserted into documents and reports for everyone'.split(' ');
    let body = '';
    for (let p = 0; p < 90; p += 1) {
      let sentence = '';
      for (let w = 0; w < 60; w += 1) sentence += `${words[(p * 7 + w * 3) % words.length]} `;
      body += `<p>${sentence}</p>`;
    }
    return page('Text article', `<article>${body}</article>`, {
      css: 'article { width: 860px; margin: 0 auto; padding: 40px 0; font-size: 18px; line-height: 1.6; color: #111; } p { margin: 0 0 22px; }',
    });
  },
};

function solidPng(hex, width = 600, height = 400) {
  const png = new PNG({ width, height });
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  for (let i = 0; i < width * height; i += 1) {
    png.data[i * 4] = r;
    png.data[i * 4 + 1] = g;
    png.data[i * 4 + 2] = b;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

export function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const imgMatch = url.pathname.match(/^\/img\/([0-9a-f]{6})\.png$/);
    if (imgMatch) {
      const delay = Number(url.searchParams.get('delay') || 0);
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        res.end(solidPng(imgMatch[1]));
      }, delay);
      return;
    }
    const name = url.pathname.replace(/^\/|\.html$/g, '');
    if (pages[name]) {
      const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
      // ?tt=1 enforces Trusted Types, like Gmail and Google Docs do.
      if (url.searchParams.get('tt')) headers['content-security-policy'] = "require-trusted-types-for 'script'";
      res.writeHead(200, headers);
      res.end(pages[name](url.searchParams));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

/** Decode stripe bands down one column of a decoded PNG. */
export function stripeRuns(png, x, y0 = 0, y1 = png.height) {
  const runs = [];
  let current = null;
  let junk = 0;
  for (let y = y0; y < y1; y += 1) {
    const i = (y * png.width + x) * 4;
    const r = png.data[i];
    const g = png.data[i + 1];
    const b = png.data[i + 2];
    const index = r + g * 256;
    const valid = b === (index % 2 ? 100 : 200);
    if (!valid) {
      current = null;
      junk += 1;
      continue;
    }
    if (current && current.index === index) {
      current.length += 1;
    } else {
      current = { index, start: y, length: 1, junkBefore: junk };
      runs.push(current);
    }
    junk = 0;
  }
  return runs;
}

/**
 * Assert stripe runs are a perfect continuous sequence.
 * @returns {string|null} error message
 */
export function checkContinuity(runs, rowsPerStripe, { tolerance = 0, label = '' } = {}) {
  if (runs.length < 2) return `${label}: only ${runs.length} stripe runs found`;
  for (let k = 1; k < runs.length; k += 1) {
    const prev = runs[k - 1];
    const run = runs[k];
    if (run.index !== prev.index + 1) {
      return `${label}: stripe ${prev.index} (row ${prev.start}) is followed by ${run.index} at row ${run.start} — ${run.index <= prev.index ? 'duplicated' : 'missing'} content`;
    }
    if (run.junkBefore > tolerance) return `${label}: ${run.junkBefore} unexpected rows before row ${run.start}`;
    const isEdge = k === runs.length - 1;
    if (!isEdge && Math.abs(prev.length - rowsPerStripe) > tolerance && k - 1 !== 0) {
      return `${label}: stripe ${prev.index} at row ${prev.start} is ${prev.length} rows tall, expected ${rowsPerStripe}`;
    }
  }
  return null;
}
