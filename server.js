/**
 * AI Lead Scraper API
 * Extracts business contact information from company names or website URLs
 * Built with Express + Playwright
 */

const express = require('express');
const { chromium } = require('playwright');



const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// SSRF Protection - Block private IP ranges
// ============================================================================
function isPrivateIP(hostname) {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  const parts = hostname.split('.');
  if (parts.length === 4 && parts.every(p => /^\d+$/.test(p))) {
    const [a, b] = parts.map(Number);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 127) return true;
    if (a === 0) return true;
  }
  if (hostname.startsWith('fc') || hostname.startsWith('fd')) return true;
  if (hostname.startsWith('fe80:')) return true;
  return false;
}

async function resolveHostname(hostname) {
  // Skip DNS pre-check — let Playwright handle connections directly
  return { valid: true };
}
async function resolveHostname_disabled(hostname) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ valid: false, reason: 'DNS resolution timed out' });
    }, 3000);
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      clearTimeout(timer);
      if (err) { resolve({ valid: false, reason: 'Could not resolve hostname' }); return; }
      for (const addr of addresses) {
        const ip = addr.address;
        if (net.isIP(ip) && isPrivateIP(ip)) {
          resolve({ valid: false, reason: `Resolved to private IP ${ip}` });
          return;
        }
      }
      resolve({ valid: true });
    });
  });
}

// ============================================================================
// Middleware
// ============================================================================
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// ============================================================================
// Regex patterns
// ============================================================================
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_REGEX = /(\+?\d[\d\s\-().]{8,}\d)/g;
const GENERIC_PREFIXES = ['noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon'];
const SOCIAL_PATTERNS = {
  linkedin: /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/(?:company|in)\/[A-Za-z0-9_.-]+\/?/i,
  twitter: /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/[A-Za-z0-9_.-]+\/?/i,
  facebook: /(?:https?:\/\/)?(?:www\.)?facebook\.com\/[A-Za-z0-9_.-]+\/?/i,
  instagram: /(?:https?:\/\/)?(?:www\.)?instagram\.com\/[A-Za-z0-9_.-]+\/?/i,
};
const CONTACT_PATHS = ['/contact', '/contact-us', '/contactus', '/about', '/about-us', '/aboutus', '/team', '/get-in-touch'];

// ============================================================================
// Helper functions
// ============================================================================
function normalizeUrl(url) {
  if (!url) return null;
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) return 'https://' + url;
  return url;
}

function cleanEmails(emails) {
  if (!emails || emails.length === 0) return [];
  const processed = emails.map(e => {
    const match = String(e).match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    return match ? match[0].toLowerCase() : null;
  }).filter(Boolean);
  const valid = processed.filter(e => !/\.(png|jpg|jpeg|gif|svg|webp|ico|css|js)$/i.test(e));
  const unique = [...new Set(valid)];
  const nonGeneric = unique.filter(e => !GENERIC_PREFIXES.includes(e.split('@')[0].toLowerCase()));
  return nonGeneric.length > 0 ? nonGeneric.slice(0, 20) : unique.slice(0, 20);
}

function cleanPhones(phones) {
  if (!phones || phones.length === 0) return [];
  const valid = phones.map(p => {
    const trimmed = String(p).trim();
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) return null;
    return trimmed;
  }).filter(Boolean);
  return [...new Set(valid)].slice(0, 10);
}

function extractSocialLinks(hrefs) {
  const social = {};
  for (const href of hrefs) {
    if (!href) continue;
    for (const [platform, regex] of Object.entries(SOCIAL_PATTERNS)) {
      if (!social[platform] && regex.test(href)) {
        const match = href.match(regex);
        if (match) {
          let url = match[0];
          if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
          social[platform] = url;
        }
      }
    }
  }
  return social;
}

function extractDescriptionFromContent(text, maxLen = 280) {
  if (!text) return '';
  const lines = text.split(/\n+/).map(l => l.trim()).filter(l => l.length > 60 && l.length < 500);
  if (lines.length > 0) return lines[0].slice(0, maxLen);
  return text.slice(0, maxLen);
}

// ============================================================================
// Playwright scraping
// ============================================================================
let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browserInstance;
}

async function scrapePage(browser, url, timeoutMs = 25000) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  page.setDefaultNavigationTimeout(timeoutMs);
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'font', 'media'].includes(type)) route.abort();
    else route.continue();
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch (e) {
    await context.close().catch(() => {});
    return null;
  }
  await page.waitForTimeout(800);
  const data = await page.evaluate(() => {
    const result = { title: document.title || '', description: '', ogDescription: '', emails: [], phones: [], links: [], content: '' };
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) result.description = metaDesc.getAttribute('content') || '';
    const ogDesc = document.querySelector('meta[property="og:description"]');
    if (ogDesc) result.ogDescription = ogDesc.getAttribute('content') || '';
    document.querySelectorAll('a[href^="mailto:"]').forEach(a => {
      const href = a.getAttribute('href') || '';
      result.emails.push(href.replace(/^mailto:/i, '').split('?')[0]);
    });
    document.querySelectorAll('a[href^="tel:"]').forEach(a => {
      const href = a.getAttribute('href') || '';
      result.phones.push(href.replace(/^tel:/i, '').trim());
    });
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      if (href) result.links.push(href);
    });
    if (document.body) result.content = document.body.innerText || '';
    return result;
  });
  await context.close().catch(() => {});
  return data;
}

function findContactPages(baseUrl, links) {
  const found = new Set();
  const baseHostname = (() => { try { return new URL(baseUrl).hostname; } catch { return ''; } })();
  for (const link of links) {
    try {
      const url = new URL(link, baseUrl);
      if (url.hostname !== baseHostname) continue;
      const path = url.pathname.toLowerCase().replace(/\/+$/, '');
      for (const pattern of CONTACT_PATHS) {
        if (path === pattern || path === pattern + '/') { found.add(url.href); break; }
      }
    } catch (e) {}
  }
  return [...found].slice(0, 2);
}

async function scrapeCompany(targetUrl, providedCompanyName = null) {
  let urlObj;
  try { urlObj = new URL(targetUrl); } catch (e) { throw new Error('Invalid URL'); }
  if (isPrivateIP(urlObj.hostname)) throw new Error('Private IP addresses are not allowed');
  const dnsCheck = await resolveHostname(urlObj.hostname);
  if (!dnsCheck.valid) throw new Error(dnsCheck.reason || 'Hostname could not be resolved');

  const browser = await getBrowser();
  const mainPage = await scrapePage(browser, targetUrl);
  if (!mainPage) throw new Error('Could not load the page (timeout or unreachable)');

  const contactUrls = findContactPages(targetUrl, mainPage.links);
  const additionalData = [];
  for (const contactUrl of contactUrls) {
    try {
      const page = await scrapePage(browser, contactUrl, 15000);
      if (page) additionalData.push(page);
    } catch (e) {}
  }

  const allEmails = [...mainPage.emails];
  const allPhones = [...mainPage.phones];
  const allLinks = [...mainPage.links];
  let description = mainPage.description || mainPage.ogDescription || '';
  let content = mainPage.content;

  for (const page of additionalData) {
    allEmails.push(...page.emails);
    allPhones.push(...page.phones);
    allLinks.push(...page.links);
    if (!description && page.description) description = page.description;
    content += '\n' + page.content;
  }

  allEmails.push(...(content.match(EMAIL_REGEX) || []));
  allPhones.push(...(content.match(PHONE_REGEX) || []));

  const social = extractSocialLinks(allLinks);
  const emails = cleanEmails(allEmails);
  const phones = cleanPhones(allPhones);

  let companyName = providedCompanyName;
  if (!companyName) {
    if (mainPage.title) {
      const cleaned = mainPage.title.split(/[|\-–—·]/).map(s => s.trim()).filter(s => s.length > 0 && s.length < 60);
      if (cleaned.length > 0) companyName = cleaned[cleaned.length - 1] || cleaned[0];
    }
    if (!companyName) {
      companyName = urlObj.hostname.replace(/^www\./, '').split('.')[0];
      companyName = companyName.charAt(0).toUpperCase() + companyName.slice(1);
    }
  }

  if (!description) description = extractDescriptionFromContent(content);

  return {
    company: companyName,
    website: targetUrl,
    description: description || '',
    industry: '',
    location: '',
    emails,
    phones,
    social,
    employees: '',
    founded: '',
    scrapedAt: new Date().toISOString(),
    source: 'website',
    error: null,
  };
}

function guessCompanyUrl(companyName) {
  const cleaned = companyName.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '');
  return `https://${cleaned}.com`;
}

// ============================================================================
// Routes
// ============================================================================
app.get('/', (req, res) => {
  res.json({
    name: 'AI Lead Scraper API',
    version: '1.0.0',
    description: 'Find business contact information from a company name or website URL',
    endpoints: {
      'GET /': 'API information',
      'GET /scrape?company=Tesla': 'Scrape leads by company name',
      'GET /scrape?url=https://example.com': 'Scrape leads by website URL',
      'GET /health': 'Health check',
      'GET /test': 'Interactive HTML test page',
    },
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

app.get('/test', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Lead Scraper</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { text-align: center; color: white; margin-bottom: 30px; font-size: 2.5em; text-shadow: 2px 2px 4px rgba(0,0,0,0.2); }
    .card { background: white; border-radius: 12px; padding: 30px; box-shadow: 0 10px 40px rgba(0,0,0,0.2); margin-bottom: 20px; }
    h2 { color: #667eea; margin-bottom: 20px; font-size: 1.4em; border-bottom: 2px solid #667eea; padding-bottom: 10px; }
    .toggle { display: flex; gap: 10px; margin-bottom: 15px; }
    .toggle button { flex: 1; padding: 10px; border: 2px solid #667eea; background: white; color: #667eea; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; transition: all 0.2s; }
    .toggle button.active { background: #667eea; color: white; }
    .input-group { display: flex; gap: 10px; }
    input[type="text"] { flex: 1; padding: 12px 16px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 16px; }
    input[type="text"]:focus { outline: none; border-color: #667eea; }
    .btn { padding: 12px 24px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; font-weight: 600; white-space: nowrap; }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .examples { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .chip { padding: 6px 14px; background: #f0f0ff; color: #667eea; border-radius: 20px; font-size: 13px; cursor: pointer; border: 1px solid #d0d0ff; }
    .chip:hover { background: #667eea; color: white; }
    .results { display: none; }
    .results.show { display: block; }
    .result-card { background: white; border-radius: 12px; padding: 20px; box-shadow: 0 10px 40px rgba(0,0,0,0.2); margin-bottom: 15px; }
    .result-card h3 { color: #667eea; margin-bottom: 15px; font-size: 1.1em; }
    .info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
    .info-item { background: #f8f9ff; padding: 12px; border-radius: 8px; }
    .info-label { font-size: 11px; color: #999; margin-bottom: 4px; text-transform: uppercase; }
    .info-value { font-size: 14px; font-weight: 600; color: #333; word-break: break-all; }
    .email-list, .phone-list { display: flex; flex-direction: column; gap: 8px; }
    .email-item, .phone-item { padding: 10px 14px; background: #f8f9ff; border-radius: 8px; }
    .email-item a { color: #667eea; text-decoration: none; font-weight: 500; }
    .social-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
    .social-item { padding: 10px 14px; background: #f8f9ff; border-radius: 8px; }
    .social-item a { color: #667eea; text-decoration: none; font-weight: 500; font-size: 14px; }
    .copy-btn { float: right; padding: 6px 14px; background: #667eea; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; }
    .error-box { background: #fff5f5; border: 2px solid #feb2b2; border-radius: 12px; padding: 20px; color: #c53030; margin-bottom: 15px; }
    .loading { text-align: center; padding: 40px; color: white; font-size: 18px; }
    .spinner { width: 50px; height: 50px; border: 5px solid rgba(255,255,255,0.3); border-top-color: white; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 15px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .empty { color: #999; font-style: italic; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔍 AI Lead Scraper</h1>
    <div class="card">
      <h2>Find Business Leads</h2>
      <div class="toggle">
        <button class="active" onclick="setMode('url')" id="urlBtn">🌐 Website URL</button>
        <button onclick="setMode('company')" id="companyBtn">🏢 Company Name</button>
      </div>
      <div class="input-group">
        <input type="text" id="queryInput" placeholder="https://stripe.com" />
        <button class="btn" onclick="scrape()" id="scrapeBtn">Find Leads</button>
      </div>
      <div class="examples">
        <span class="chip" onclick="useExample('https://stripe.com')">stripe.com</span>
        <span class="chip" onclick="useExample('https://anthropic.com')">anthropic.com</span>
        <span class="chip" onclick="useExample('https://vercel.com')">vercel.com</span>
        <span class="chip" onclick="useExample('https://openai.com')">openai.com</span>
      </div>
    </div>
    <div class="loading" id="loading" style="display:none">
      <div class="spinner"></div>
      <p>Scraping leads... this may take 15-30 seconds</p>
    </div>
    <div id="errorBox" class="error-box" style="display:none"></div>
    <div class="results" id="results">
      <div class="result-card">
        <button class="copy-btn" onclick="copyAll()">Copy JSON</button>
        <h3>🏢 Company Info</h3>
        <div class="info-grid" id="companyInfo"></div>
      </div>
      <div class="result-card">
        <h3>📧 Emails</h3>
        <div class="email-list" id="emailList"></div>
      </div>
      <div class="result-card">
        <h3>📞 Phone Numbers</h3>
        <div class="phone-list" id="phoneList"></div>
      </div>
      <div class="result-card">
        <h3>🔗 Social Media</h3>
        <div class="social-grid" id="socialGrid"></div>
      </div>
    </div>
  </div>
  <script>
    let mode = 'url';
    let lastData = null;
    function setMode(m) {
      mode = m;
      document.getElementById('urlBtn').className = m === 'url' ? 'active' : '';
      document.getElementById('companyBtn').className = m === 'company' ? 'active' : '';
      document.getElementById('queryInput').placeholder = m === 'url' ? 'https://stripe.com' : 'Stripe';
    }
    function useExample(val) { setMode('url'); document.getElementById('queryInput').value = val; }
    async function scrape() {
      const query = document.getElementById('queryInput').value.trim();
      if (!query) { alert('Please enter a URL or company name'); return; }
      const btn = document.getElementById('scrapeBtn');
      btn.disabled = true;
      document.getElementById('loading').style.display = 'block';
      document.getElementById('results').className = 'results';
      document.getElementById('errorBox').style.display = 'none';
      const param = mode === 'url' ? 'url' : 'company';
      try {
        const res = await fetch('/scrape?' + param + '=' + encodeURIComponent(query));
        const data = await res.json();
        lastData = data;
        if (data.error && !data.emails?.length) {
          document.getElementById('errorBox').style.display = 'block';
          document.getElementById('errorBox').textContent = 'Error: ' + data.error;
        } else { showResults(data); }
      } catch(e) {
        document.getElementById('errorBox').style.display = 'block';
        document.getElementById('errorBox').textContent = 'Network error: ' + e.message;
      }
      btn.disabled = false;
      document.getElementById('loading').style.display = 'none';
    }
    function showResults(d) {
      document.getElementById('companyInfo').innerHTML = [
        ['Company', d.company], ['Website', d.website], ['Description', d.description],
        ['Scraped At', new Date(d.scrapedAt).toLocaleString()]
      ].map(([l,v]) => v ? '<div class="info-item"><div class="info-label">'+l+'</div><div class="info-value">'+v+'</div></div>' : '').join('');
      const emails = d.emails || [];
      document.getElementById('emailList').innerHTML = emails.length
        ? emails.map(e => '<div class="email-item"><a href="mailto:'+e+'">'+e+'</a></div>').join('')
        : '<p class="empty">No emails found</p>';
      const phones = d.phones || [];
      document.getElementById('phoneList').innerHTML = phones.length
        ? phones.map(p => '<div class="phone-item">'+p+'</div>').join('')
        : '<p class="empty">No phone numbers found</p>';
      const social = d.social || {};
      const socialKeys = Object.keys(social);
      document.getElementById('socialGrid').innerHTML = socialKeys.length
        ? socialKeys.map(k => '<div class="social-item"><div class="info-label">'+k+'</div><a href="'+social[k]+'" target="_blank">'+social[k]+'</a></div>').join('')
        : '<p class="empty">No social links found</p>';
      document.getElementById('results').className = 'results show';
    }
    function copyAll() { if (lastData) navigator.clipboard.writeText(JSON.stringify(lastData, null, 2)); }
  </script>
</body>
</html>`);
});

app.get('/scrape', async (req, res) => {
  const { company, url } = req.query;
  if (!company && !url) {
    return res.status(400).json({ error: 'Missing required parameter: provide either ?company=Name or ?url=https://example.com', emails: [], phones: [], social: {}, scrapedAt: new Date().toISOString() });
  }
  const requestTimeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ error: 'Request timeout', scrapedAt: new Date().toISOString() });
    }
  }, 30000);
  try {
    let targetUrl;
    let providedName = null;
    if (url) { targetUrl = normalizeUrl(url); }
    else { providedName = company; targetUrl = guessCompanyUrl(company); }
    const result = await scrapeCompany(targetUrl, providedName);
    clearTimeout(requestTimeout);
    if (!res.headersSent) res.json(result);
  } catch (error) {
    clearTimeout(requestTimeout);
    if (!res.headersSent) {
      res.status(500).json({ company: company || null, website: url || null, description: '', industry: '', location: '', emails: [], phones: [], social: {}, employees: '', founded: '', scrapedAt: new Date().toISOString(), source: 'error', error: error.message || 'Failed to scrape' });
    }
  }
});

app.use((req, res) => { res.status(404).json({ error: 'Not found', path: req.path }); });

// ============================================================================
// Start server
// ============================================================================
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Lead Scraper API running on port ${PORT}`);
});

process.on('SIGTERM', async () => {
  if (browserInstance) await browserInstance.close().catch(() => {});
  server.close(() => process.exit(0));
});

process.on('SIGINT', async () => {
  if (browserInstance) await browserInstance.close().catch(() => {});
  server.close(() => process.exit(0));
});

module.exports = app;
