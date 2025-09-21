// server.js
import express from 'express';
import fetch from 'node-fetch';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname)); // serves index.html

// Env vars:
// OPENAI_API_KEY=sk-... (or compatible provider key)
// OPENAI_BASE_URL=https://api.openai.com/v1 (override for compatible hosts)
// OPENAI_MODEL=gpt-4o-mini (or any compatible small model)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Basic URL validation
function isValidHttpUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function sanitizeFilename(name) {
  return (name || 'document').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 120) || 'document';
}

async function suggestTitleFromText(text, url) {
  if (!OPENAI_API_KEY) return null;
  const sys = 'You create concise, descriptive document titles (max 8 words), no punctuation except hyphens.';
  const user = `Suggest a PDF filename title for the following web page. Avoid emojis, quotes, or trailing periods.
URL: ${url}
Content (truncated): ${text.slice(0, 6000)}`;
  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user }
      ],
      temperature: 0.2,
      max_tokens: 24
    })
  });
  if (!res.ok) throw new Error(`LLM error: ${await res.text()}`);
  const data = await res.json();
  const title = data.choices?.[0]?.message?.content?.trim();
  return title || null;
}

app.post('/api/suggest-title', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!isValidHttpUrl(url)) return res.status(400).json({ error: 'Invalid URL' });
    const html = await (await fetch(url, { redirect: 'follow' })).text();
    const title = await suggestTitleFromText(html, url);
    res.json({ title: title ? sanitizeFilename(title) : 'document' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/print-pdf', async (req, res) => {
  const { url, format = 'A4', scale = 1, landscape = false, printBackground = true, useLLM = false } = req.body || {};
  if (!isValidHttpUrl(url)) return res.status(400).send('Invalid URL');

  let browser;
  try {
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: 'new'
    });
    const page = await browser.newPage();

    // Improve print-friendly output
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.goto(url, { waitUntil: ['load', 'domcontentloaded', 'networkidle2'], timeout: 60000 });

    // Remove sticky elements that often clutter PDFs
    await page.addStyleTag({ content: `
      * { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      header, nav, aside, iframe, video { page-break-inside: avoid; }
      [role="banner"], [role="navigation"], [role="dialog"], [role="alert"], .cookie, .consent, .subscribe, .signup {
        display: none !important;
      }
      a[href^="#"]::after, a[href^="javascript:"]::after { content: ""; }
    `});

    // Try to extract a clean title
    const pageTitle = await page.title();
    const mainText = await page.evaluate(() => {
      function textFrom(selector) {
        const el = document.querySelector(selector);
        return el ? el.innerText : '';
      }
      const candidates = [
        'article', 'main', 'section', 'div[role="main"]', '#content', '.content', '.post', '.article'
      ];
      let txt = '';
      for (const c of candidates) {
        const t = textFrom(c);
        if (t && t.length > txt.length) txt = t;
      }
      if (!txt) txt = document.body.innerText || '';
      return txt.slice(0, 12000);
    });

    let filenameBase = pageTitle || 'document';
    if (useLLM) {
      try {
        const llmTitle = await suggestTitleFromText(mainText || pageTitle, url);
        if (llmTitle) filenameBase = llmTitle;
      } catch (e) {
        // If LLM fails, fall back silently
      }
    }
    const filename = sanitizeFilename(filenameBase) + '.pdf';

    const pdfBuffer = await page.pdf({
      format,
      landscape,
      printBackground,
      scale: Math.max(0.1, Math.min(2, Number(scale) || 1)),
      margin: { top: '12mm', right: '12mm', bottom: '16mm', left: '12mm' }
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).send('Failed to generate PDF: ' + err.message);
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server listening on http://localhost:' + PORT));
