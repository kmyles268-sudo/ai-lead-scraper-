const express = require('express');
const { chromium } = require('playwright');
const app = express();
const PORT = process.env.PORT || 3000;

const BLOCKED_HOSTS = [/^localhost$/i, /^ip6-localhost$/i, /^ip6-loopback$/i];
const BLOCKED_IP_RANGES = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2[0-9]|3[01])\./, /^192\.168\./, /^192\.0\.2\./, /^198\.51\.100\./, /^203\.0\.113\./, /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, /^::1$/, /^::$/, /^fe80:/i, /^fc/i, /^fd/i, /^ff/i];

function isBlockedHost(h) {
  return BLOCKED_HOSTS.some(r => r.test(h)) || BLOCKED_IP_RANGES.some(r => r.test(h));
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ name: 'Fresh Browser Proxy API', usage: 'GET /fetch?url=https://example.com' });
});

app.get('/test', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fresh Browser Proxy Tester</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
      color: #333;
    }
    .container { max-width: 800px; margin: 0 auto; }
    h1 {
      text-align: center;
      color: white;
      margin-bottom: 30px;
      font-size: 2.5em;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.2);
    }
    .card {
      background: white;
      border-radius: 12px;
      padding: 30px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
      margin-bottom: 20px;
    }
    h2 {
      color: #667eea;
      margin-bottom: 20px;
      font-size: 1.5em;
      border-bottom: 2px solid #667eea;
      padding-bottom: 10px;
    }
    .input-group {
      display: flex;
      gap: 10px;
      margin-bottom: 15px;
    }
    input[type="text"] {
      flex: 1;
      padding: 12px 16px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 16px;
      transition: border-color 0.3s;
    }
    input[type="text"]:focus {
      outline: none;
      border-color: #667eea;
    }
    button {
      padding: 12px 24px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
      font-weight: 600;
    }
    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 5px 20px rgba(102, 126, 234, 0.4);
    }
    button:active { transform: translateY(0); }
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    #result {
      margin-top: 20px;
      padding: 20px;
      background: #f8f9fa;
      border-radius: 8px;
      border-left: 4px solid #667eea;
      display: none;
    }
    #result.show { display: block; }
    .meta {
      font-size: 14px;
      color: #666;
      margin-bottom: 15px;
      display: flex;
      flex-wrap: wrap;
      gap: 15px;
    }
    .meta span {
      background: #e9ecef;
      padding: 4px 12px;
      border-radius: 20px;
    }
    #content {
      background: white;
      padding: 15px;
      border-radius: 8px;
      max-height: 400px;
      overflow-y: auto;
      white-space: pre-wrap;
      font-family: 'Courier New', monospace;
      font-size: 14px;
      line-height: 1.6;
      border: 1px solid #e0e0e0;
    }
    .error {
      background: #fff5f5;
      border-left-color: #e53e3e;
      color: #c53030;
    }
    .loading {
      text-align: center;
      padding: 40px;
      color: #666;
    }
    .spinner {
      width: 40px;
      height: 40px;
      border: 4px solid #e0e0e0;
      border-top-color: #667eea;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 15px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <h1>Fresh Browser Proxy Tester</h1>
    <div class="card">
      <h2>Fetch Page Content</h2>
      <div class="input-group">
        <input type="text" id="urlInput" placeholder="Enter URL (e.g., https://example.com)" value="https://example.com">
        <button id="fetchBtn" onclick="fetchContent()">Fetch</button>
      </div>
      <div id="result">
        <div class="meta" id="meta"></div>
        <div id="content"></div>
      </div>
    </div>
  </div>
  <script>
    async function fetchContent() {
      const url = document.getElementById('urlInput').value;
      const btn = document.getElementById('fetchBtn');
      const result = document.getElementById('result');
      const meta = document.getElementById('meta');
      const content = document.getElementById('content');
      
      if (!url) { alert('Please enter a URL'); return; }
      
      btn.disabled = true;
      result.className = 'show';
      meta.innerHTML = '<div class="loading"><div class="spinner"></div>Fetching...</div>';
      content.textContent = '';
      
      try {
        const res = await fetch('/fetch?url=' + encodeURIComponent(url));
        const data = await res.json();
        
        if (data.error) {
          result.className = 'show error';
          meta.innerHTML = '<span style="color:#c53030">Error</span>';
          content.textContent = data.error;
        } else {
          meta.innerHTML = \`
            <span><strong>Title:</strong> \${data.title || 'N/A'}</span>
            <span><strong>Status:</strong> \${data.statusCode || 'N/A'}</span>
            <span><strong>Fetched:</strong> \${new Date(data.fetchedAt).toLocaleString()}</span>
            <span><a href="\${data.finalUrl}" target="_blank" style="color:#667eea;">Final URL</a></span>
          \`;
          content.textContent = data.content || 'No content extracted';
        }
      } catch (err) {
        result.className = 'show error';
        meta.innerHTML = '<span style="color:#c53030">Network Error</span>';
        content.textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>
  `);
});

app.get('/fetch', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (isBlockedHost(parsedUrl.hostname)) return res.status(403).json({ error: 'Blocked host' });
  
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const context = await browser.newContext({
      bypassCSP: true,
      extraHTTPHeaders: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
    });
    const page = await context.newPage();
    await page.route('**/*', route => {
      route.continue({ headers: { ...route.request().headers(), 'cache-control': 'no-cache', 'pragma': 'no-cache' } });
    });
    
    const response = await Promise.race([
      page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout after 30s')), 30000))
    ]);
    
    const finalUrl = page.url();
    const title = await page.title();
    const statusCode = response ? response.status() : null;
    const content = await page.evaluate(() => {
      const el = document.querySelector('main') || document.querySelector('article') || document.body;
      return el ? el.innerText : '';
    });
    
    await browser.close();
    res.json({
      content: content.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\n{3,}/g, '\n\n').trim(),
      title, finalUrl, fetchedAt: new Date().toISOString(), statusCode, error: null
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ content: null, title: null, finalUrl: null, fetchedAt: new Date().toISOString(), statusCode: null, error: err.message });
  }
});

app.get('/screenshot', async (req, res) => {
  const { url, fullPage, width, height, format } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }
  
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  
  if (isBlockedHost(parsedUrl.hostname)) {
    return res.status(403).json({ error: 'Blocked host' });
  }
  
  const viewportWidth = parseInt(width) || 1280;
  const viewportHeight = parseInt(height) || 800;
  const takeFullPage = fullPage === 'true';
  
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const context = await browser.newContext({
      viewport: { width: viewportWidth, height: viewportHeight },
      bypassCSP: true
    });
    const page = await context.newPage();
    
    await Promise.race([
      page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout after 30s')), 30000))
    ]);
    
    const finalUrl = page.url();
    const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: takeFullPage });
    const takenAt = new Date().toISOString();
    
    await browser.close();
    
    if (format === 'base64') {
      const base64Image = screenshotBuffer.toString('base64');
      return res.json({
        image: base64Image,
        url: finalUrl,
        takenAt: takenAt,
        width: viewportWidth,
        height: viewportHeight,
        fullPage: takeFullPage
      });
    } else {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', `inline; filename="screenshot-${Date.now()}.png"`);
      res.setHeader('X-Final-URL', finalUrl);
      res.setHeader('X-Taken-At', takenAt);
      return res.send(screenshotBuffer);
    }
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ error: err.message, url: null, takenAt: new Date().toISOString() });
  }
});

app.get('/screenshot/test', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Screenshot Tester - Fresh Browser Proxy</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
      min-height: 100vh;
      padding: 20px;
      color: #333;
    }
    .container { max-width: 1000px; margin: 0 auto; }
    h1 {
      text-align: center;
      color: white;
      margin-bottom: 30px;
      font-size: 2.5em;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.2);
    }
    .card {
      background: white;
      border-radius: 12px;
      padding: 30px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
      margin-bottom: 20px;
    }
    h2 {
      color: #11998e;
      margin-bottom: 20px;
      font-size: 1.5em;
      border-bottom: 2px solid #11998e;
      padding-bottom: 10px;
    }
    .input-group {
      display: flex;
      gap: 10px;
      margin-bottom: 15px;
      flex-wrap: wrap;
    }
    .input-row {
      display: flex;
      gap: 15px;
      margin-bottom: 15px;
      flex-wrap: wrap;
      align-items: center;
    }
    .input-field {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .input-field label {
      font-size: 12px;
      color: #666;
      font-weight: 600;
    }
    input[type="text"], input[type="number"] {
      padding: 10px 14px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 14px;
      transition: border-color 0.3s;
    }
    input[type="text"]:focus, input[type="number"]:focus {
      outline: none;
      border-color: #11998e;
    }
    input[type="number"] { width: 100px; }
    .checkbox-field {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 0;
    }
    input[type="checkbox"] {
      width: 20px;
      height: 20px;
      cursor: pointer;
    }
    button {
      padding: 12px 24px;
      background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
      font-weight: 600;
    }
    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 5px 20px rgba(17, 153, 142, 0.4);
    }
    button:active { transform: translateY(0); }
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    #screenshotPreview {
      margin-top: 20px;
      text-align: center;
      display: none;
    }
    #screenshotPreview.show { display: block; }
    #screenshotImage {
      max-width: 100%;
      border-radius: 8px;
      box-shadow: 0 5px 20px rgba(0,0,0,0.1);
      border: 2px solid #e0e0e0;
    }
    .meta {
      font-size: 14px;
      color: #666;
      margin: 15px 0;
      display: flex;
      flex-wrap: wrap;
      gap: 15px;
      justify-content: center;
    }
    .meta span {
      background: #f0f9f7;
      padding: 6px 14px;
      border-radius: 20px;
      color: #11998e;
      font-weight: 500;
    }
    .meta a {
      color: #11998e;
      text-decoration: none;
      font-weight: 600;
    }
    .meta a:hover { text-decoration: underline; }
    .error {
      background: #fff5f5;
      border: 2px solid #e53e3e;
      color: #c53030;
      padding: 20px;
      border-radius: 8px;
      text-align: center;
      margin-top: 20px;
    }
    .loading {
      text-align: center;
      padding: 60px;
      color: #666;
    }
    .spinner {
      width: 50px;
      height: 50px;
      border: 5px solid #e0e0e0;
      border-top-color: #11998e;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 20px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .format-note {
      font-size: 12px;
      color: #888;
      margin-top: 10px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Screenshot Tester</h1>
    <div class="card">
      <h2>Capture Screenshot</h2>
      <div class="input-row">
        <div class="input-field" style="flex:1;">
          <label>URL</label>
          <input type="text" id="urlInput" placeholder="Enter URL (e.g., https://example.com)" value="https://example.com">
        </div>
        <button id="captureBtn" onclick="captureScreenshot()" style="align-self:flex-end;">Capture Screenshot</button>
      </div>
      <div class="input-row">
        <div class="input-field">
          <label>Width</label>
          <input type="number" id="widthInput" value="1280" min="320" max="3840">
        </div>
        <div class="input-field">
          <label>Height</label>
          <input type="number" id="heightInput" value="800" min="240" max="2160">
        </div>
        <div class="checkbox-field">
          <input type="checkbox" id="fullPageInput">
          <label for="fullPageInput">Full Page</label>
        </div>
      </div>
      <p class="format-note">Screenshot will be captured at the specified viewport dimensions</p>
    </div>
    
    <div id="screenshotPreview">
      <div class="meta" id="meta"></div>
      <img id="screenshotImage" alt="Screenshot">
    </div>
    <div id="errorMessage" class="error" style="display:none;"></div>
    <div id="loadingState" class="loading" style="display:none;">
      <div class="spinner"></div>
      <p>Capturing screenshot...</p>
    </div>
  </div>
  
  <script>
    async function captureScreenshot() {
      const url = document.getElementById('urlInput').value;
      const width = document.getElementById('widthInput').value;
      const height = document.getElementById('heightInput').value;
      const fullPage = document.getElementById('fullPageInput').checked;
      
      const preview = document.getElementById('screenshotPreview');
      const image = document.getElementById('screenshotImage');
      const meta = document.getElementById('meta');
      const errorDiv = document.getElementById('errorMessage');
      const loading = document.getElementById('loadingState');
      const btn = document.getElementById('captureBtn');
      
      if (!url) {
        alert('Please enter a URL');
        return;
      }
      
      btn.disabled = true;
      preview.className = '';
      errorDiv.style.display = 'none';
      loading.style.display = 'block';
      image.src = '';
      meta.innerHTML = '';
      
      try {
        const params = new URLSearchParams({ url: url, width: width, height: height });
        if (fullPage) params.append('fullPage', 'true');
        
        const res = await fetch('/screenshot?' + params.toString());
        
        if (!res.ok) {
          const errorData = await res.json();
          throw new Error(errorData.error || 'Failed to capture screenshot');
        }
        
        const contentType = res.headers.get('content-type');
        const blob = await res.blob();
        const imageUrl = URL.createObjectURL(blob);
        
        const finalUrl = res.headers.get('x-final-url') || url;
        const takenAt = res.headers.get('x-taken-at') || new Date().toISOString();
        
        image.src = imageUrl;
        meta.innerHTML = \`
          <span><strong>URL:</strong> <a href="\${finalUrl}" target="_blank">View Page</a></span>
          <span><strong>Dimensions:</strong> \${width}x\${height}</span>
          <span><strong>Full Page:</strong> \${fullPage ? 'Yes' : 'No'}</span>
          <span><strong>Captured:</strong> \${new Date(takenAt).toLocaleString()}</span>
        \`;
        
        preview.className = 'show';
      } catch (err) {
        errorDiv.textContent = 'Error: ' + err.message;
        errorDiv.style.display = 'block';
      } finally {
        btn.disabled = false;
        loading.style.display = 'none';
      }
    }
  </script>
</body>
</html>
  `);
});

app.listen(PORT, () => console.log(`Fresh Browser Proxy listening on port ${PORT}`));