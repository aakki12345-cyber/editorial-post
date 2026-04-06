require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Multer (image uploads) ──────────────────────────────────────────────────
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images are allowed'));
  },
});

// ─── In-Memory Job Store ─────────────────────────────────────────────────────
const jobs = {};

// ─── Serialize a job safely (exclude sseClients → prevents circular JSON error) ────
function safeSerialize(jobId) {
  const { sseClients, ...safe } = jobs[jobId];
  return JSON.stringify(safe);
}

// ─── Broadcast current job state to all SSE clients ─────────────────────────
function broadcast(jobId) {
  if (!jobs[jobId] || !jobs[jobId].sseClients) return;
  let payload;
  try { payload = safeSerialize(jobId); } catch (e) { console.error('SSE serialize error:', e.message); return; }
  jobs[jobId].sseClients.forEach(res => {
    try { res.write(`data: ${payload}\n\n`); } catch (_) { }
  });
}

// ─── Update job metadata + broadcast ────────────────────────────────────────
function updateJob(jobId, update) {
  if (!jobs[jobId]) return;
  Object.assign(jobs[jobId], update);
  broadcast(jobId);
}

// ─── SSE Endpoint ────────────────────────────────────────────────────────────
app.get('/api/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!jobs[jobId]) {
    res.write(`data: ${JSON.stringify({ error: 'Job not found' })}\n\n`);
    return res.end();
  }

  jobs[jobId].sseClients = jobs[jobId].sseClients || [];
  jobs[jobId].sseClients.push(res);

  // Send current state immediately
  res.write(`data: ${JSON.stringify({ ...jobs[jobId], sseClients: undefined })}\n\n`);

  req.on('close', () => {
    jobs[jobId].sseClients = jobs[jobId].sseClients.filter(c => c !== res);
  });
});

// ─── PIPELINE FUNCTIONS ────────────────────────────────────────────────────

// 1. Extract URL from text (like n8n "Code in JavaScript")
function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s]+/);
  return match ? match[0] : null;
}

// 2. Fetch content via Jina.ai
async function fetchViaJina(url) {
  const jinaUrl = `https://r.jina.ai/${url}`;
  const response = await axios.get(jinaUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 30000,
  });
  return response.data;
}

// 3. Clean & extract best content block (like n8n "Code in JavaScript1")
function cleanContent(raw) {
  let cleaned = String(raw)
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/\n+/g, '\n');

  let lines = cleaned.split('\n').map(l => l.trim());

  const noise = [
    'subscribe', 'newsletter', 'advertisement', 'follow us',
    'contact', 'privacy policy', 'terms', 'courses',
    'test series', 'download app', 'mock test',
    'login', 'sign up', 'previous post', 'next post',
  ];

  lines = lines.filter(line => {
    if (line.length < 30) return false;
    const lower = line.toLowerCase();
    return !noise.some(n => lower.includes(n));
  });

  // Build content blocks
  let blocks = [];
  let temp = [];

  for (let line of lines) {
    if (line.length > 40) {
      temp.push(line);
    } else {
      if (temp.length > 5) blocks.push(temp);
      temp = [];
    }
  }
  if (temp.length > 5) blocks.push(temp);

  // Score & pick best block
  let bestBlock = [];
  let maxScore = 0;
  blocks.forEach(block => {
    const text = block.join(' ').toLowerCase();
    let score = block.length;
    if (text.includes('india')) score += 2;
    if (text.includes('ai')) score += 2;
    if (text.includes('challenge')) score += 1;
    if (text.includes('summit')) score += 2;
    if (score > maxScore) { maxScore = score; bestBlock = block; }
  });

  // If no good block found, use all lines joined
  return bestBlock.length > 0 ? bestBlock.join('\n\n') : lines.join('\n\n');
}

// 4. OCR via OCR.space API (for images)
async function extractTextFromImage(imagePath, mimeType) {
  const form = new FormData();
  const ext = mimeType.split('/')[1] || 'jpg';
  form.append('file', fs.createReadStream(imagePath), {
    filename: `upload.${ext}`,
    contentType: mimeType
  });
  form.append('scale', 'true'); // Recommended to improve OCR
  form.append('isTable', 'true'); // Helpful for structured text

  const apiKey = process.env.OCR_SPACE_API_KEY || 'helloworld';

  const response = await axios.post('https://api.ocr.space/parse/image', form, {
    headers: {
      ...form.getHeaders(),
      apikey: apiKey,
    },
    timeout: 60000,
  });

  if (response.data && response.data.ParsedResults && response.data.ParsedResults.length > 0) {
    return response.data.ParsedResults[0].ParsedText || '';
  }

  if (response.data && response.data.ErrorMessage) {
    throw new Error(response.data.ErrorMessage.join ? response.data.ErrorMessage.join(', ') : response.data.ErrorMessage);
  }

  return '';
}

// 5. Generate structured UPSC article via Gemini
async function generateStructuredArticle(content) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
  });

  const prompt = `You must return ONLY valid JSON.

You are an expert UPSC / State PCS educator and answer-writing mentor.

Convert the given content into an exam-oriented article suitable for UPSC aspirants.

DO NOT hallucinate. Rewrite content in hindi to make it completely original.

STRICT JSON FORMAT (do not change this format):

{
  "structured": {
    "title": "",
    "current_affairs_addon": [],
    "introduction": "",
    "background": [],
    "concepts": [],
    "pros": [],
    "cons": [],
    "way_forward": [],
    "conclusion": "",
    "mains_150": [{"question":"","answer":""}],
    "mains_250": [{"question":"","answer":""}],
    "mcqs": [
      {
        "question": "",
        "options": "(a)... (b)... (c)... (d)...",
        "answer": "",
        "explanation": ""
      }
    ]
  },
  "seo": {
    "meta_title": "",
    "meta_description": "",
    "keywords": [],
    "label": [],
    "tags": [],
    "slug": "",
    "canonical": "",
    "exam_relevance": "",
    "internal_link_suggestions": []
  }
}

CRITICAL RULES:
1. DO NOT return objects inside arrays — use plain strings only. All subheadings with strong html tag: <strong>subheadings</strong>
2. Every array MUST have at least 3 items (background, concepts, pros, cons, way_forward)
3. NEVER leave fields empty
4. At least 2 MCQs. mcqs.options must be a SINGLE STRING: "(a)... (b)... (c)... (d)..."
   MCQ FORMAT: Statement-based (2-3 statements), options visible, correct answer + explanation.
5. mains_150/mains_250 must have structure: Introduction (2-3 lines) → Body (sub-parts) → Conclusion
6. Use simple UPSC language
7. Rewrite in hindi: avoid similar sentence structure, change wording deeply, maintain meaning
8. current_affairs_addon: 3-5 latest Indian context points (schemes, reports, judgments)

FOR SEO:
- meta_description: 150-160 characters, include main keyword
- keywords: mix of SEO + UPSC keywords
- tags: short phrases / blog labels
- label: exactly ["NEWS","CURRENT AFFAIRS","UPSC","STATE PSC","ANSWER WRITING","EDITORIAL ANALYSIS"]
- exam_relevance: 2-3 lines why topic matters for UPSC
- internal_link_suggestions: 2 related topics
- slug: lowercase, hyphen-separated
- canonical: https://akbstudycenter.blogspot.com/slug
- meta_title: SEO optimized, include primary keyword

STRICT OUTPUT RULES:
- Output MUST start with { and end with }
- Do NOT use markdown or \`\`\`json
- Do NOT add any text outside JSON
- Use only double quotes
- No trailing commas
- JSON must be directly parsable with JSON.parse()

INPUT:
${content}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

// 6. Build HTML article (like n8n "Code in JavaScript3")
function buildHtmlArticle(data, imageUrl) {
  const s = data.structured;
  const seo = data.seo;

  const list = (arr) => (arr || []).map(i => `<li>${i}</li>`).join('');

  const mcqs = (s.mcqs || []).map(q => `
<details style="background:#fffde7;border-radius:6px;margin-bottom:10px;padding:12px;">
<summary><strong>${q.question}</strong><p>${q.options}</p></summary>
<p><strong>Answer:</strong> ${q.answer}</p>
<p><strong>Explanation:</strong> ${q.explanation}</p>
</details>`).join('');

  const imgTag = imageUrl
    ? `<div style="text-align:center;margin:20px 0;">
  <img src="${imageUrl}" alt="${seo.meta_title}" style="width:100%;max-width:850px;border-radius:12px;box-shadow:0 4px 10px rgba(0,0,0,0.1);" />
</div>`
    : '';

  const html = `<meta name="description" content="${seo.meta_description}"><meta name="keywords" content="${(seo.keywords || []).join(', ')}">
<div style="background:#ffffff;font-family:Segoe UI,Arial;line-height:1.8;margin:auto;max-width:900px;padding:20px;">
<h1 style="color:#0d47a1;font-size:30px;">${seo.meta_title}</h1>
${imgTag}
<div style="background:#fcf7c1;border-left:5px solid #a09402;border-radius:6px;margin-bottom:15px;padding:14px;">
<strong>📌 In Short:</strong>
<p>${seo.meta_description}</p>
</div>
<div style="background:#e3f2fd;border-left:5px solid #1e88e5;border-radius:6px;margin-bottom:15px;padding:14px;">
<strong>🎯 Exam Relevance:</strong>
<p>${seo.exam_relevance}</p>
</div>
<p style="background:#f1e0f3;padding:10px;border-radius:6px;"><strong>🔑 Keywords:</strong> ${(seo.keywords || []).join(', ')}</p>
<div style="background:#e8f5e9;padding:12px;border-left:5px solid #43a047;border-radius:6px;margin-bottom:15px;">
<strong>📰 Current Affairs Add-on:</strong>
<ul>${list(s.current_affairs_addon)}</ul>
</div>
<h2 style="color:#1565c0;border-bottom:2px solid #ddd;padding-bottom:5px;">🧭 Introduction</h2>
<p>${s.introduction}</p>
<h2 style="color:#1565c0;border-bottom:2px solid #ddd;padding-bottom:5px;">🌍 Background</h2>
<ul>${list(s.background)}</ul>
<h2 style="color:#6a1b9a;border-bottom:2px solid #ddd;padding-bottom:5px;">📊 Key Concepts</h2>
<ul>${list(s.concepts)}</ul>
<h2 style="color:#2e7d32;border-bottom:2px solid #ddd;padding-bottom:5px;">✅ Advantages</h2>
<ul>${list(s.pros)}</ul>
<h2 style="color:#c62828;border-bottom:2px solid #ddd;padding-bottom:5px;">⚠️ Challenges</h2>
<ul>${list(s.cons)}</ul>
<div style="background:#fff3e0;border-left:5px solid #fb8c00;border-radius:6px;margin-top:15px;padding:14px;">
<strong>🚀 Way Forward:</strong>
<ul>${list(s.way_forward)}</ul>
</div>
<h2 style="color:#004d40;border-bottom:2px solid #ddd;padding-bottom:5px;">🧾 Conclusion</h2>
<p>${s.conclusion}</p>
<hr style="border:1px solid #ddd;margin:30px 0;">
<h2 style="color:#5e35b1;">📝 Mains Answer (150 words)</h2>
<strong>${(s.mains_150 || [{}])[0].question}</strong>
<p>${(s.mains_150 || [{}])[0].answer}</p>
<h2 style="color:#5e35b1;">📝 Mains Answer (250 words)</h2>
<strong>${(s.mains_250 || [{}])[0].question}</strong>
<p>${(s.mains_250 || [{}])[0].answer}</p>
<hr style="border:1px solid #ddd;margin:30px 0;">
<h2 style="color:#f9a825;">❓ Prelims MCQs</h2>
${mcqs}
<hr style="border:1px solid #ddd;margin:30px 0;">
<div style="background:#e3f2fd;border-radius:6px;padding:12px;">
<strong>🔗 Related Topics:</strong>
<ul>${list(seo.internal_link_suggestions)}</ul>
</div>
<div style="margin-top:20px;">
<strong>🏷️ Tags:</strong>
${(seo.tags || []).map(t => `<span style="background:#f1f1f1;padding:6px 10px;margin:3px;border-radius:5px;">${t}</span>`).join('')}
${(seo.keywords || []).map(t => `<span style="background:#f1f1f1;padding:6px 10px;margin:3px;border-radius:5px;">${t}</span>`).join('')}
${(seo.label || []).map(t => `<span style="background:#f1f1f1;padding:6px 10px;margin:3px;border-radius:5px;">${t}</span>`).join('')}
</div></div>
<script type="application/ld+json">
{
 "@context": "https://schema.org",
 "@type": "Article",
 "headline": "${seo.meta_title}",
 "description": "${seo.meta_description}",
 "image": "${imageUrl || ''}",
 "author": {"@type": "Person","name": "AKB"},
 "publisher": {
   "@type": "Organization",
   "name": "AKB Study Center",
   "logo": {"@type": "ImageObject","url": "https://blogger.googleusercontent.com/img/a/AVvXsEgExco8lsQgQeKUawycNvDGQgELMityYm1QuG3v57pBJoVJXiNpnCs7iG3lIDxGfs9X-BYF8M9XBpt1nHQG-XnT4n2mRE9Kdas3XPxGFKIEEKTWJ_d_LBJLKqI4Ukl0iEeFjTpsgnmvAnC9rOWdrDlc26RssCtR05q6GwDfa4booA7R6Md_Mp2liIXcOtQ=s700"}
 },
 "mainEntityOfPage": {"@type": "WebPage","@id": "${seo.canonical}"}
}
</script>`;

  // Clean up newlines
  return html
    .replace(/\\n/g, '')
    .replace(/\n/g, '')
    .trim();
}

// 7. RenderForm — generate thumbnail
async function generateThumbnail(title) {
  const resp = await axios.post(
    'https://get.renderform.io/api/v2/render',
    {
      template: process.env.RENDERFORM_TEMPLATE || 'ugly-dragons-hang-blindly-1567',
      data: { 'title.text': title },
    },
    {
      headers: {
        'X-API-KEY': process.env.RENDERFORM_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );
  return resp.data.href; // downloadable image URL
}

// 8. Download image from URL → buffer
async function downloadImage(url) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return { buffer: Buffer.from(resp.data), contentType: resp.headers['content-type'] || 'image/png' };
}

// 9. Upload to Google Drive
async function uploadToGoogleDrive(buffer, filename, contentType) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_DRIVE_CLIENT_ID,
    process.env.GOOGLE_DRIVE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN });

  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const { Readable } = require('stream');
  const stream = Readable.from(buffer);

  const resp = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
    },
    media: { mimeType: contentType, body: stream },
    fields: 'id',
  });

  // Make it publicly accessible
  await drive.permissions.create({
    fileId: resp.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return resp.data.id; // file ID
}

// 10. Publish to Blogger
async function publishToBlogger(title, content, labels, slug) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.BLOGGER_CLIENT_ID,
    process.env.BLOGGER_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: process.env.BLOGGER_REFRESH_TOKEN });
  const blogger = google.blogger({ version: 'v3', auth: oauth2Client });

  const resp = await blogger.posts.insert({
    blogId: process.env.BLOGGER_BLOG_ID,
    requestBody: {
      kind: 'blogger#post',
      title,
      content,
      labels: Array.isArray(labels) ? labels : [labels],
    },
  });
  return resp.data;
}

// 11. Google Indexing API ping
async function pingGoogleIndexing(url) {
  try {
    const serviceAccountPath = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || './service-account.json';
    if (!fs.existsSync(serviceAccountPath)) {
      console.warn('Service account file not found, skipping indexing ping');
      return null;
    }
    const auth = new google.auth.GoogleAuth({
      keyFile: serviceAccountPath,
      scopes: ['https://www.googleapis.com/auth/indexing'],
    });
    const authClient = await auth.getClient();
    const resp = await authClient.request({
      url: 'https://indexing.googleapis.com/v3/urlNotifications:publish',
      method: 'POST',
      data: { url, type: 'URL_UPDATED' },
    });
    return resp.data;
  } catch (err) {
    console.warn('Indexing API error:', err.message);
    return null;
  }
}

// 12. Ping sitemap
async function pingSitemap() {
  try {
    const sitemapUrl = process.env.SITEMAP_URL || 'https://www.jkdmm.in/sitemap.xml';
    await axios.get(`https://www.google.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`, { timeout: 10000 });
  } catch (err) {
    console.warn('Sitemap ping error:', err.message);
  }
}

// ─── Step Result Helper (push + broadcast immediately) ───────────────────────
function pushStep(jobId, stepResult) {
  if (!jobs[jobId]) return;
  jobs[jobId].stepResults = jobs[jobId].stepResults || [];
  const idx = jobs[jobId].stepResults.findIndex(s => s.id === stepResult.id);
  if (idx >= 0) {
    jobs[jobId].stepResults[idx] = stepResult;
  } else {
    jobs[jobId].stepResults.push(stepResult);
  }
  // Broadcast immediately so each step shows in UI without waiting for next updateJob
  broadcast(jobId);
}

// ─── MAIN PIPELINE ──────────────────────────────────────────────────────────
async function runPipeline(jobId, urls, imagePaths) {
  try {
    // ── Step 1: Fetch URL content ────────────────────────────────────────────
    pushStep(jobId, { id: 'fetch', icon: '🔗', label: 'Fetching URL Content', status: 'active', data: null });
    updateJob(jobId, { step: 'Fetching URL content via Jina.ai...', progress: 5 });

    const urlContents = [];
    const urlResults = [];
    for (const url of urls) {
      try {
        const raw = await fetchViaJina(url);
        const cleaned = cleanContent(raw);
        if (cleaned.length > 100) {
          urlContents.push(cleaned);
          urlResults.push({
            url,
            chars: cleaned.length,
            preview: cleaned,
          });
        }
      } catch (err) {
        urlResults.push({ url, error: err.message });
        console.error(`Failed to fetch ${url}:`, err.message);
      }
    }
    pushStep(jobId, {
      id: 'fetch', icon: '🔗', label: 'URL Content Fetched', status: 'done',
      data: {
        type: 'url_fetch',
        fetched: urlResults.filter(r => !r.error).length,
        failed: urlResults.filter(r => r.error).length,
        totalChars: urlContents.reduce((s, c) => s + c.length, 0),
        results: urlResults,
      },
    });
    updateJob(jobId, { step: `Fetched ${urlResults.filter(r => !r.error).length} URL(s)`, progress: 18 });

    // ── Step 2: OCR / Extract text from images ────────────────────────────────
    pushStep(jobId, { id: 'ocr', icon: '🖼️', label: 'Running Image OCR', status: 'active', data: null });
    updateJob(jobId, { step: 'Extracting text from images (Qwen VL OCR)...', progress: 20 });

    const imageContents = [];
    const ocrResults = [];
    for (const img of imagePaths) {
      try {
        const text = await extractTextFromImage(img.path, img.mimetype);
        if (text.length > 50) {
          imageContents.push(text);
          ocrResults.push({
            name: img.originalname,
            chars: text.length,
            preview: text,
          });
        }
      } catch (err) {
        ocrResults.push({ name: img.originalname, error: err.message });
        console.error(`Failed OCR for ${img.path}:`, err.message);
      }
    }
    pushStep(jobId, {
      id: 'ocr', icon: '🖼️', label: 'Image OCR Complete', status: imagePaths.length === 0 ? 'skipped' : 'done',
      data: {
        type: 'ocr',
        processed: ocrResults.filter(r => !r.error).length,
        skipped: imagePaths.length === 0,
        results: ocrResults,
      },
    });
    updateJob(jobId, { step: `OCR done for ${ocrResults.filter(r => !r.error).length} image(s)`, progress: 32 });

    // ── Step 3: Merge all content ─────────────────────────────────────────────
    const mergedContent = [...urlContents, ...imageContents].join('\n\n---\n\n');
    if (!mergedContent || mergedContent.length < 100) {
      throw new Error('Not enough content extracted from URLs or images. Please provide richer sources.');
    }

    // ── Step 4: Generate structured article via Gemini ────────────────────────
    pushStep(jobId, { id: 'ai', icon: '✨', label: 'Gemini Writing UPSC Article', status: 'active', data: null });
    updateJob(jobId, { step: 'Generating UPSC article with Gemini AI...', progress: 35 });

    const articleData = await generateStructuredArticle(mergedContent);
    const s = articleData.structured;
    const seo = articleData.seo;

    pushStep(jobId, {
      id: 'ai', icon: '✨', label: 'Article Generated by Gemini', status: 'done',
      data: {
        type: 'article',
        title: s.title,
        metaTitle: seo.meta_title,
        metaDescription: seo.meta_description,
        examRelevance: seo.exam_relevance,
        introduction: s.introduction,
        slug: seo.slug,
        canonical: seo.canonical,
        keywords: seo.keywords,
        tags: seo.tags,
        labels: seo.label,
        mcqCount: s.mcqs?.length || 0,
        backgroundCount: s.background?.length || 0,
        currentAffairs: s.current_affairs_addon,
        mains150Q: s.mains_150?.[0]?.question,
        mains250Q: s.mains_250?.[0]?.question,
        wayForward: s.way_forward,
      },
    });
    updateJob(jobId, { articleData, step: 'Article JSON generated', progress: 55 });

    // ── Step 5: Generate thumbnail via RenderForm ─────────────────────────────
    pushStep(jobId, { id: 'thumb', icon: '🎨', label: 'Generating Thumbnail', status: 'active', data: null });
    updateJob(jobId, { step: 'Generating thumbnail via RenderForm...', progress: 60 });

    let driveImageUrl = '';
    let driveFileId = '';
    let thumbnailDownloadUrl = '';
    try {
      thumbnailDownloadUrl = await generateThumbnail(s.title);
      pushStep(jobId, {
        id: 'thumb', icon: '🎨', label: 'Thumbnail Generated', status: 'done',
        data: {
          type: 'thumbnail',
          renderFormUrl: thumbnailDownloadUrl,
          title: s.title,
        },
      });
      updateJob(jobId, { step: 'Downloading & uploading thumbnail...', progress: 65 });

      const { buffer, contentType } = await downloadImage(thumbnailDownloadUrl);

      // ── Step 6: Upload thumbnail to Google Drive ──────────────────────────
      pushStep(jobId, { id: 'drive', icon: '💾', label: 'Uploading to Google Drive', status: 'active', data: null });
      updateJob(jobId, { step: 'Uploading thumbnail to Google Drive...', progress: 70 });

      driveFileId = await uploadToGoogleDrive(buffer, `${s.title}.png`, contentType);
      driveImageUrl = `https://lh3.googleusercontent.com/d/${driveFileId}=w1200`;

      pushStep(jobId, {
        id: 'drive', icon: '💾', label: 'Thumbnail Uploaded to Drive', status: 'done',
        data: {
          type: 'drive',
          fileId: driveFileId,
          imageUrl: driveImageUrl,
          driveLink: `https://drive.google.com/file/d/${driveFileId}/view`,
        },
      });
    } catch (err) {
      pushStep(jobId, {
        id: 'thumb', icon: '🎨', label: 'Thumbnail Skipped', status: 'skipped',
        data: { type: 'thumbnail', error: err.message },
      });
      console.warn('Thumbnail pipeline error (continuing without image):', err.message);
    }

    // ── Step 7: Build HTML article ─────────────────────────────────────────
    pushStep(jobId, { id: 'html', icon: '🏗️', label: 'Building HTML Article', status: 'active', data: null });
    updateJob(jobId, { step: 'Building HTML article...', progress: 78 });
    const htmlContent = buildHtmlArticle(articleData, driveImageUrl);

    pushStep(jobId, {
      id: 'html', icon: '🏗️', label: 'HTML Article Built', status: 'done',
      data: {
        type: 'html',
        chars: htmlContent.length,
        preview: htmlContent,
      },
    });
    updateJob(jobId, { step: 'HTML article ready', progress: 82 });

    // ── Step 8: Publish to Blogger ─────────────────────────────────────────
    pushStep(jobId, { id: 'publish', icon: '📤', label: 'Publishing to Blogger', status: 'active', data: null });
    updateJob(jobId, { step: 'Publishing to Blogger...', progress: 85 });

    let bloggerPost = null;
    try {
      bloggerPost = await publishToBlogger(s.title, htmlContent, seo.label, seo.slug);
      pushStep(jobId, {
        id: 'publish', icon: '📤', label: 'Published to Blogger', status: 'done',
        data: {
          type: 'blogger',
          postId: bloggerPost.id,
          postUrl: bloggerPost.url,
          title: bloggerPost.title,
          published: bloggerPost.published,
          labels: bloggerPost.labels,
        },
      });
    } catch (err) {
      pushStep(jobId, {
        id: 'publish', icon: '📤', label: 'Blogger Publish Skipped', status: 'skipped',
        data: { type: 'blogger', error: err.message },
      });
      console.warn('Blogger publish error:', err.message);
    }
    updateJob(jobId, { step: 'Published to Blogger', progress: 90 });

    // ── Step 9: Ping Google Indexing API ──────────────────────────────────
    pushStep(jobId, { id: 'index', icon: '🔍', label: 'Pinging Google Indexing', status: 'active', data: null });
    updateJob(jobId, { step: 'Pinging Google Indexing API...', progress: 93 });

    let indexResult = null;
    if (bloggerPost?.url) {
      indexResult = await pingGoogleIndexing(bloggerPost.url);
    }
    pushStep(jobId, {
      id: 'index', icon: '🔍', label: 'Google Indexing Pinged', status: indexResult ? 'done' : 'skipped',
      data: {
        type: 'indexing',
        url: bloggerPost?.url || null,
        response: indexResult,
        skipped: !bloggerPost?.url,
      },
    });

    // ── Step 10: Ping Sitemap ─────────────────────────────────────────────
    pushStep(jobId, { id: 'sitemap', icon: '🗺️', label: 'Pinging Sitemap', status: 'active', data: null });
    updateJob(jobId, { step: 'Pinging sitemap...', progress: 97 });
    await pingSitemap();
    pushStep(jobId, {
      id: 'sitemap', icon: '🗺️', label: 'Sitemap Pinged', status: 'done',
      data: {
        type: 'sitemap',
        url: process.env.SITEMAP_URL || 'https://www.jkdmm.in/sitemap.xml',
      },
    });

    // ── Done ──────────────────────────────────────────────────────────────
    updateJob(jobId, {
      step: 'Complete!',
      progress: 100,
      status: 'done',
      result: {
        postUrl: bloggerPost?.url || null,
        postId: bloggerPost?.id || null,
        driveFileId,
        driveImageUrl,
        thumbnailUrl: thumbnailDownloadUrl,
        title: s.title,
        slug: seo.slug,
        articleData,
      },
    });
  } catch (err) {
    console.error('Pipeline error:', err);
    // Mark last active step as error
    if (jobs[jobId]?.stepResults) {
      const active = jobs[jobId].stepResults.find(s => s.status === 'active');
      if (active) {
        active.status = 'error';
        active.data = { ...(active.data || {}), error: err.message };
      }
    }
    updateJob(jobId, {
      step: `Error: ${err.message}`,
      status: 'error',
      error: err.message,
    });
  } finally {
    // Clean up uploaded files
    if (imagePaths && imagePaths.length) {
      imagePaths.forEach(img => {
        try { fs.unlinkSync(img.path); } catch (_) { }
      });
    }
  }
}

// ─── API ROUTES ──────────────────────────────────────────────────────────────

// POST /api/generate — start the pipeline
app.post('/api/generate', upload.array('images', 10), async (req, res) => {
  try {
    const urls = JSON.parse(req.body.urls || '[]').filter(u => u && u.trim());
    const imagePaths = (req.files || []).map(f => ({ path: f.path, mimetype: f.mimetype, originalname: f.originalname }));

    if (urls.length === 0 && imagePaths.length === 0) {
      return res.status(400).json({ error: 'Please provide at least one URL or image.' });
    }

    const jobId = uuidv4();
    jobs[jobId] = {
      jobId,
      status: 'running',
      step: 'Starting pipeline...',
      progress: 0,
      createdAt: new Date().toISOString(),
      sseClients: [],
    };

    res.json({ jobId });

    // Run pipeline asynchronously
    runPipeline(jobId, urls, imagePaths);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/job/:jobId — polling fallback
app.get('/api/job/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const { sseClients, ...safeJob } = job;
  res.json(safeJob);
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Editorial Blogger running at http://localhost:${PORT}\n`);
});
