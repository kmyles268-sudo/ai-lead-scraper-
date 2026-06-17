/**
 * AI Lead Scraper API
 * Extracts business contact information from company names or website URLs
 * Built with Express + Playwright
 */

const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// SSRF Protection - Block private IP ranges
// ============================================================================
function isPrivateIP(hostname) {
  // Loopback
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;

  // Check IPv4
  const parts = hostname.split('.');
  if (parts.length === 4 && parts.every(p => /^\d+$/.test(p))) {
    const [a, b] = parts.map(Number);
    if (a === 10) return true;                                       // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;                 // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                          // 192.168.0.0/16
    if (a === 169 && b === 254) return true;                          // 169.254.0.0/16
    if (a === 127) return true;                                       // 127.0.0.0/8
    if (a === 0) return true;                                         // 0.0.0.0/8
  }

  // IPv6 private ranges
  if (hostname.startsWith('fc') || hostname.startsWith('fd')) return true; // fc00::/7
  if (hostname.startsWith('fe80:')) return true;                            // fe80::/10

  return false;
}

async function resolveHostname(hostname) {
  // Resolve hostname to IP and check if private - with 3s timeout
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ valid: false, reason: 'DNS resolution timed out' });
    }, 3000);

    dns.lookup(hostname, { all: true }, (err, addresses) => {
      clearTimeout(timer);
      if (err) {
        resolve({ valid: false, reason: 'Could not resolve hostname' });
        return;
      }
      for (const addr of addresses) {
        const ip = addr.address;
        if (net.isIP(ip)) {
          if (isPrivateIP(ip)) {
            resolve({ valid: false, reason: `Resolved to private IP ${ip}` });
            return;
          }
        }
      }
      resolve({ valid: true, addresses: addresses.map(a => a.address) });
    });
  });
}

// ============================================================================
// Middleware
// ============================================================================
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Serve the test HTML page
app.get('/test', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'test.html'));
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

const CONTACT_PATHS = ['/contact', '/contact-us', '/contactus', '/about', '/about-us', '/aboutus', '/team', '/get-in-touch', '/reach-us'];

// ============================================================================
// Helper functions
// ============================================================================
function normalizeUrl(url) {
  if (!url) return null;
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) {
    return 'https://' + url;
  }
  return url;
}

function cleanEmails(emails) {
  if (!emails || emails.length === 0) return [];

  // Strip query params, lowercase
  const processed = emails
    .map(e => {
      if (!e) return null;
      // Re-extract just the email part using regex
      const match = String(e).match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      return match ? match[0].toLowerCase() : null;
    })
    .filter(Boolean);

  // Filter out image extensions
  const valid = processed.filter(e => !/\.(png|jpg|jpeg|gif|svg|webp|ico|css|js)$/i.test(e));

  // Dedupe
  const unique = [...new Set(valid)];

  // Filter out generic prefixes if non-generic exist
  const nonGeneric = unique.filter(e => {
    const prefix = e.split('@')[0].toLowerCase();
    return !GENERIC_PREFIXES.includes(prefix);
  });

  return nonGeneric.length > 0 ? nonGeneric.slice(0, 20) : unique.slice(0, 20);
}

function cleanPhones(phones) {
  if (!phones || phones.length === 0) return [];

  const valid = phones
    .map(p => {
      if (!p) return null;
      const trimmed = String(p).trim();
      // Skip if too many non-digit chars
      const digits = trimmed.replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) return null;
      return trimmed;
    })
    .filter(Boolean);

  return [...new Set(valid)].slice(0, 10);
}

function extractSocialLinks(hrefs) {
  const social = {};
  for (const href of hrefs) {
    if (!href) continue;
    const lower = String(href).toLowerCase();
    for (const [platform, regex] of Object.entries(SOCIAL_PATTERNS)) {
      if (!social[platform] && regex.test(href)) {
        const match = href.match(regex);
        if (match) {
          let url = match[0];
          if (!/^https?:\/\//i.test(url)) {
            url = 'https://' + url;
          }
          social[platform] = url;
        }
      }
    }
  }
  return social;
}

function extractDescriptionFromContent(text, maxLen = 280) {
  if (!text) return '';
  // Try to find meaningful paragraph
  const lines = text.split(/\n+/).map(l => l.trim()).filter(l => l.length > 60 && l.length < 500);
  if (lines.length > 0) {
    return lines[0].slice(0, maxLen);
  }
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

  // Block unnecessary resources for speed
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'font', 'media'].includes(type)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch (e) {
    await context.close().catch(() => {});
    return null;
  }

  // Try to wait a bit for dynamic content
  await page.waitForTimeout(800);

  const data = await page.evaluate(() => {
    const result = {
      title: document.title || '',
      description: '',
      ogDescription: '',
      emails: [],
      phones: [],
      links: [],
      content: '',
    };

    // Meta description
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) result.description = metaDesc.getAttribute('content') || '';

    const ogDesc = document.querySelector('meta[property="og:description"]');
    if (ogDesc) result.ogDescription = ogDesc.getAttribute('content') || '';

    // Twitter description
    const twDesc = document.querySelector('meta[name="twitter:description"]');
    if (twDesc && !result.description) result.description = twDesc.getAttribute('content') || '';

    // mailto: links
    document.querySelectorAll('a[href^="mailto:"]').forEach(a => {
      const href = a.getAttribute('href') || '';
      result.emails.push(href.replace(/^mailto:/i, '').split('?')[0]);
    });

    // tel: links
    document.querySelectorAll('a[href^="tel:"]').forEach(a => {
      const href = a.getAttribute('href') || '';
      result.phones.push(href.replace(/^tel:/i, '').trim());
    });

    // All links
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      if (href) result.links.push(href);
    });

    // Body text content
    if (document.body) {
      result.content = document.body.innerText || '';
    }

    return result;
  });

  await context.close().catch(() => {});
  return data;
}

function findContactPages(baseUrl, links) {
  const found = new Set();
  const baseHostname = (() => {
    try { return new URL(baseUrl).hostname; } catch { return ''; }
  })();

  for (const link of links) {
    try {
      const url = new URL(link, baseUrl);
      // Only same origin
      if (url.hostname !== baseHostname) continue;
      const path = url.pathname.toLowerCase().replace(/\/+$/, '');
      for (const pattern of CONTACT_PATHS) {
        if (path === pattern || path === pattern + '/') {
          found.add(url.href);
          break;
        }
      }
    } catch (e) { /* ignore invalid URLs */ }
  }
  return [...found].slice(0, 2); // Limit to 2 contact pages to stay within timeout
}

async function scrapeCompany(targetUrl, providedCompanyName = null) {
  // Resolve hostname first for SSRF protection
  let urlObj;
  try {
    urlObj = new URL(targetUrl);
  } catch (e) {
    throw new Error('Invalid URL');
  }

  if (isPrivateIP(urlObj.hostname)) {
    throw new Error('Private IP addresses are not allowed');
  }

  // DNS resolution check
  const dnsCheck = await resolveHostname(urlObj.hostname);
  if (!dnsCheck.valid) {
    throw new Error(dnsCheck.reason || 'Hostname could not be resolved');
  }

  const browser = await getBrowser();

  // Scrape main page
  const mainPage = await scrapePage(browser, targetUrl);
  if (!mainPage) {
    throw new Error('Could not load the page (timeout or unreachable)');
  }

  // Find and scrape contact pages
  const contactUrls = findContactPages(targetUrl, mainPage.links);

  const additionalData = [];
  for (const contactUrl of contactUrls) {
    try {
      const page = await scrapePage(browser, contactUrl, 15000);
      if (page) additionalData.push(page);
    } catch (e) { /* ignore */ }
  }

  // Combine data from all pages
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
    if (!description && page.ogDescription) description = page.ogDescription;
    content += '\n' + page.content;
  }

  // Extract emails and phones from text using regex
  const emailMatches = content.match(EMAIL_REGEX) || [];
  const phoneMatches = content.match(PHONE_REGEX) || [];

  allEmails.push(...emailMatches);
  allPhones.push(...phoneMatches);

  // Extract social links
  const social = extractSocialLinks(allLinks);

  // Clean and dedupe
  const emails = cleanEmails(allEmails);
  const phones = cleanPhones(allPhones);

  // Infer company name
  let companyName = providedCompanyName;
  if (!companyName) {
    // Try from title first
    if (mainPage.title) {
      const cleaned = mainPage.title
        .split(/[|\-–—·]/)
        .map(s => s.trim())
        .filter(s => s.length > 0 && s.length < 60);
      if (cleaned.length > 0) {
        companyName = cleaned[cleaned.length - 1] || cleaned[0];
      }
    }
    if (!companyName) {
      companyName = urlObj.hostname.replace(/^www\./, '').split('.')[0];
      companyName = companyName.charAt(0).toUpperCase() + companyName.slice(1);
    }
  }

  // Get description from content if missing
  if (!description) {
    description = extractDescriptionFromContent(content);
  }

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

// Heuristic to guess website from company name
function guessCompanyUrl(companyName) {
  const cleaned = companyName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '');

  // Try .com first
  return `https://${cleaned}.com`;
}

// ============================================================================
// Routes
// ============================================================================

// Root - API info
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
    example: '/scrape?url=https://example.com',
    timestamp: new Date().toISOString(),
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Scrape endpoint
app.get('/scrape', async (req, res) => {
  const { company, url } = req.query;

  if (!company && !url) {
    return res.status(400).json({
      error: 'Missing required parameter: provide either ?company=Name or ?url=https://example.com',
      company: null,
      website: null,
      description: '',
      industry: '',
      location: '',
      emails: [],
      phones: [],
      social: {},
      employees: '',
      founded: '',
      scrapedAt: new Date().toISOString(),
      source: 'none',
    });
  }

  // Set 30 second timeout
  const requestTimeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({
        error: 'Request timeout - scraping took too long',
        company: company || null,
        website: url || null,
        scrapedAt: new Date().toISOString(),
      });
    }
  }, 30000);

  try {
    let targetUrl;
    let providedName = null;

    if (url) {
      targetUrl = normalizeUrl(url);
    } else {
      providedName = company;
      targetUrl = guessCompanyUrl(company);
    }

    const result = await scrapeCompany(targetUrl, providedName);
    clearTimeout(requestTimeout);
    if (!res.headersSent) res.json(result);
  } catch (error) {
    clearTimeout(requestTimeout);
    console.error('Scrape error:', error.message);
    if (!res.headersSent) {
      const errorResponse = {
        company: company || null,
        website: url || null,
        description: '',
        industry: '',
        location: '',
        emails: [],
        phones: [],
        social: {},
        employees: '',
        founded: '',
        scrapedAt: new Date().toISOString(),
        source: 'error',
        error: error.message || 'Failed to scrape',
      };
      res.status(error.message && error.message.includes('not allowed') ? 403 : 500).json(errorResponse);
    }
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// Start server
// ============================================================================
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Lead Scraper API running on port ${PORT}`);
  console.log(`Test page: http://localhost:${PORT}/test`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
  }
  server.close(() => process.exit(0));
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down...');
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
  }
  server.close(() => process.exit(0));
});

module.exports = app;
