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

// 5. Generate structured article via Gemini
async function generateStructuredArticle(content, importantText = '') {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
  });

  const contextSection = importantText
    ? `━━━━━━━━━━━━━━━━━━━━━━━
🚨 IMPORTANT INSTRUCTIONS / EXTRA CONTEXT
━━━━━━━━━━━━━━━━━━━━━━━
${importantText}

━━━━━━━━━━━━━━━━━━━━━━━
📚 SOURCE MATERIAL
━━━━━━━━━━━━━━━━━━━━━━━
` : '';

  let prompt = '';

  prompt = `You must return ONLY valid JSON.

You are an expert UPSC / State PCS educator, Editorial Analyst and answer-writing mentor.

Convert the given content into an exam-oriented article suitable for UPSC aspirants.

DO NOT hallucinate. Rewrite content in English in depth with about 1500-2000 words (Easy understandable- don't use complex words in english) to make it completely original.

STRICT JSON FORMAT (do not change this format):

{
  "structured": {
    "title": "",
    "current_affairs_addon": [],
    "featured_snippet": {
      "question": "",
      "answer": ""
    },
    "alt_text": "",
    "key_facts": [],
    "why_in_news": [],
    "introduction": "",
    "background": [],
    "concepts": [],
    "pros": [],
    "cons": [],
    "way_forward": [],
    "conclusion": "",
    "pyqs": [],
    "mains_enrichment": [],
    "flowchart": [],
    "data_points": [],
    "expert_insight": "",
    "government_schemes": [],
    "counter_arguments": [],
    "india_specific_relevance": [],
    "related_static_topics": [],
    "mains_150": [{"question":"","answer":""}],
    "mains_250": [{"question":"","answer":""}],
    "mains_keywords": [],
    "essay_angles": [],
    "interlinkages": [],
    "future_risks": [],
    "mcqs": [
      {
        "question": "",
        "options": "(a)... (b)... (c)... (d)...",
        "answer": "",
        "explanation": ""
      }
    ],
    "faqs": [
      {"question":"","answer":""}
    ]
  },
  "seo": {
    "meta_title": "",
    "meta_description": "",
    "searchDescription": "",
    "custom_url": "",
    "keywords": [],
    "label": [],
    "tags": [],
    "exam_relevance": "",
    "internal_link_suggestions": []
  }
}
CRITICAL RULES:
1. DO NOT return objects inside arrays — use plain strings only. All subheadings with strong html tag: <strong>subheadings</strong>
2. Every array MUST have at least 3 items
3. NEVER leave fields empty
4. At least 2 MCQs.
5. Rewrite in English where appropriate.
6. Don't use complex words in english and hindi.
7. title should be catchy and interesting in english only so that urls can be generated easily.
8. Ensure the first label should always be "EDITORIAL ANALYSIS" and other can be "ANSWER WRITING","CURRENT AFFAIRS " if related to it.
9.featured_snippet -Add a short 2-3 line definition for featured snippet.Simple English.Direct question-answer format. Question should be start with "What is [topic name]" and answer should be 2-3 lines.
10.alt_text - alt_text for image seo friendly.
11. meta_title - meta title for blog post seo friendly. 
12. meta_description - meta description  is rich and keyword for seo friendly.
13. searchDescription - it is seo friendly matched with my article and upto maximun 150 character.
14. custom_url - seo friendly custom permalink url of length exactly or upto 36 characters. Only use lowercase letters and hyphens (e.g. "upsc-exam-analysis-2026").
15. tags - tags for blog post seo friendly.
15. exam_relevance - exam relevance for blog post seo friendly.
15. keywords - keywords for blog post seo friendly. first keyword is "UPSC GS1/2/3/4 Topic" . Other keywords should be related to the subject and topic.
16. key_facts - key facts for blog post seo friendly. This is static GK which is related to the content of context provided. it should be 3-5 points.
17. Avoid generic AI phrases like:"bright spot", "turbulent waters", "in today's world", "plays a crucial role", "important to note", etc.Use analytical UPSC-style language with precise points.
18. pyqs - Add at least 3 UPSC Previous Year Question style questions related to the topic for GS Paper relevance.
19. mains_enrichment - Add 5-8 crisp analytical points useful in UPSC Mains answers.
20. flowchart - Add 5-7 short cause-effect flowchart points in sequential order for revision.
21. data_points - Add 3-5 important statistics, reports, indices, rankings or government data related to the topic.
22. expert_insight - Add one original UPSC-oriented expert analysis paragraph explaining deeper implications for exam and governance perspective.
23. related_static_topics - Add static GS topics related to the current issue.
24. featured_snippet answer must contain the target keyword naturally within first sentence.
25. Use semantic SEO keywords naturally throughout the content including governance, economy, social impact, international relations, environment, ethics, and policy dimensions wherever relevant.
26. Write like an experienced UPSC mentor explaining concepts to aspirants. Avoid robotic sentence structure.
27. mains_150 - Add 3-5 Mains-style analytical points in 150-word format.
28. mains_250 - Add 3-4 Mains-style analytical points in 250-word format.
29. government_schemes - Add 3-5 relevant government schemes, constitutional provisions, committees, missions, policies, SDGs, reports, or international agreements related to the topic.
30. counter_arguments - Add 2-4 balanced counter perspectives, implementation constraints, economic concerns, or opposing viewpoints related to the issue.
31. mains_keywords - Add 5-10 important analytical keywords or phrases useful in UPSC Mains answers.
32. india_specific_relevance - Add 3-5 points explaining why the issue is important specifically for India’s governance, economy, society, or foreign policy.
33. essay_angles - Add 3-5 philosophical, ethical, governance, or societal dimensions useful for UPSC Essay paper.
34. interlinkages - Connect the topic with Economy, Geography, Ethics, Environment, Governance, Society, International Relations, or Technology wherever relevant.
35. future_risks - Add 3-5 future governance, economic, social, environmental, or geopolitical risks if the issue remains unresolved.
36. faqs - Add 5-7 relevant FAQs with questions and answers.


INPUT: 
${contextSection}
${content}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

function buildHtmlArticle(data, imageUrl) {
  imageUrl = imageUrl || "https://lh3.googleusercontent.com/d/1m0saesFzaDIiYYwwB-cgA6jga0Usjgqj=w1200";

  // DEFAULT: editorial (UPSC)
  const s = data.structured;
  const seo = data.seo;
  const publishedDate = new Date();
  const year = publishedDate.getFullYear();
  const month = String(publishedDate.getMonth() + 1).padStart(2, '0');
  const list = (arr) => (arr || []).map(i => `<li>${i}</li>`).join('');
  const wordCountText = [
    s.title,

    ...(s.current_affairs_addon || []),

    s.featured_snippet?.question,
    s.featured_snippet?.answer,

    s.alt_text,

    ...(s.key_facts || []),

    ...(s.why_in_news || []),

    s.introduction,

    ...(s.background || []),

    ...(s.concepts || []),

    ...(s.pros || []),

    ...(s.cons || []),

    ...(s.way_forward || []),

    s.conclusion,

    ...(s.pyqs || []),

    ...(s.mains_enrichment || []),

    ...(s.flowchart || []),

    ...(s.data_points || []),

    s.expert_insight,

    ...(s.government_schemes || []),

    ...(s.counter_arguments || []),

    ...(s.india_specific_relevance || []),

    ...(s.related_static_topics || []),

    ...(s.mains_keywords || []),

    ...(s.essay_angles || []),

    ...(s.interlinkages || []),

    ...(s.future_risks || []),

    ...(s.mains_150 || []).flatMap(item => [
      item.question,
      item.answer
    ]),

    ...(s.mains_250 || []).flatMap(item => [
      item.question,
      item.answer
    ]),

    ...(s.mcqs || []).flatMap(item => [
      item.question,
      item.options,
      item.answer,
      item.explanation
    ]),

    ...(s.faqs || []).flatMap(item => [
      item.question,
      item.answer
    ])

  ]
    .filter(Boolean)
    .join(" ");
  const wordCount = wordCountText
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .length;
  const mcqs = (s.mcqs || []).map(q => `
<details style="background:#fffde7;border-radius:6px;margin-bottom:10px;padding:12px;">
<summary><strong>${q.question}</strong><p>${q.options}</p></summary>
<p><strong>Answer:</strong> ${q.answer}</p>
<p><strong>Explanation:</strong> ${q.explanation}</p>
</details>`).join('');

  const imgTag = imageUrl
    ? `<div style="text-align:center;margin:20px 0;">
  <img src="${imageUrl}" alt="${s.alt_text}" style="width:100%;max-width:850px;border-radius:12px;box-shadow:0 4px 10px rgba(0,0,0,0.1);" />
</div>`
    : '';

  const html = `
<style>
  .blog-container { background:#ffffff;font-family:Segoe UI,Arial,sans-serif;line-height:1.8;margin:auto;max-width:900px;padding:20px; }
  .blog-subtitle { color:#0d47a1;font-size:30px; }
  .box { padding:14px;border-radius:6px;margin-bottom:15px; }
  .box-warning { background:#fff3e0;border-left:5px solid #ff9800; }
  .box-success { background:#e8f5e9;border-left:5px solid #43a047; }
  .box-info { background:#fcf7c1;border-left:5px solid #a09402; }
  .box-primary { background:#e3f2fd;border-left:5px solid #1e88e5; }
  .box-purple { background:#d09ddbff;border-left:5px solid #482451ff; }
  .box-amber { background:#fff8e1;border-left:5px solid #fbc02d; }
  .box-pink { background:#fce4ec;border-left:5px solid #c2185b; }
  .box-red { background:#ffebee;border-left:5px solid #d32f2f; }
  .box-lightblue { background:#e1f5fe;border-left:5px solid #0288d1; }
  .box-lightpurple { background:#f3e5f5;border-left:5px solid #7b1fa2; }
  .box-grey { background:#f5f5f5;padding:15px;border-radius:8px;line-height:2; }
  .keyword-tag { background:#f1e0f3;padding:10px;border-radius:6px; }
  .toc { background:#f5f5f5;padding:15px;border-radius:8px;margin-bottom:20px; }
  .heading { border-bottom:2px solid #ddd;padding-bottom:5px; }
  .heading-blue { color:#1565c0; }
  .heading-purple { color:#6a1b9a; }
  .heading-green { color:#2e7d32; }
  .heading-red { color:#c62828; }
</style>

<!-- 
SEARCH DESCRIPTION (Copy/paste this into Blogger Settings): 
${seo.searchDescription}

CUSTOM URL (Copy/paste this into Blogger Settings): 
${seo.custom_url}
-->

<div class="blog-container">
<p class="blog-subtitle">${seo.meta_title}</p>
${imgTag}

<div class="box box-warning">
<strong>📌 ${s.featured_snippet.question}</strong>
<p>${s.featured_snippet.answer}</p>
</div>
<div class="box box-success">
<strong>📰 Why in News?</strong>
<ul>${list(s.why_in_news)}</ul>
</div>
<div class="box box-info">
<strong>📌 In Short:</strong>
<p>${seo.meta_description}</p>
</div>
<div class="box box-primary">
<strong>🎯 Exam Relevance:</strong>
<p>${seo.exam_relevance}</p>
</div>
<p class="keyword-tag"><strong>${seo.keywords[0]}:</strong> ${(seo.keywords || []).join(', ')}</p>
<div class="box box-purple">
<strong>📊 Key Facts:</strong>
<ul>${list(s.key_facts)}</ul>
</div>
<div class="box box-success">
<strong>📰 Current Affairs Add-on:</strong>
<ul>${list(s.current_affairs_addon)}</ul>
</div>
<details id="toc" class="toc" style="cursor:pointer;">
<summary><strong>📚 Table of Contents</strong></summary>
<ul style="margin-top:10px;">
<li><a href="#intro">Introduction</a></li>
<li><a href="#background">Background</a></li>
<li><a href="#concepts">Key Concepts</a></li>
<li><a href="#pros">Advantages</a></li>
<li><a href="#cons">Challenges</a></li>
<li><a href="#wayforward">Way Forward</a></li>
<li><a href="#conclusion">Conclusion</a></li>
</ul>
</details>
<h2 id="intro" class="heading heading-blue">🧭 Introduction</h2>
<p>${s.introduction}</p>
<h2 id="background" class="heading heading-blue">🌍 Background</h2>
<ul>${list(s.background)}</ul>
<h2 id="concepts" class="heading heading-purple">📊 Key Concepts</h2>
<ul>${list(s.concepts)}</ul>
<h2 id="pros" class="heading heading-green">✅ Advantages</h2>
<ul>${list(s.pros)}</ul>
<h2 id="cons" class="heading heading-red">⚠️ Challenges</h2>
<ul>${list(s.cons)}</ul>
<div id="wayforward" class="box box-warning">
<strong>🚀 Way Forward:</strong>
<ul>${list(s.way_forward)}</ul>
</div>

<h2 id="conclusion" class="heading heading-green">🧾 Conclusion</h2>
<p>${s.conclusion}</p>

<div id="revi" class="box box-amber">
<strong>🧠 Quick Revision Points</strong>
<ul>
${list(s.mains_enrichment)}
</ul>
</div>
<hr style="border:1px solid #ddd;margin:30px 0;"> 
<h2>🔄 Cause-Effect Flowchart</h2>

<div class="box box-grey">
${(s.flowchart || []).join(' → ')}
</div>
<h2>📊 Important Data & Reports</h2>
<ul>${list(s.data_points)}</ul>
<div class="box box-success">
<strong>🏛️ Government Schemes & Policies</strong>
<ul>${list(s.government_schemes)}</ul>
</div>
<div class="box box-pink">
<strong>⚖️ Counter Perspective</strong>
<ul>${list(s.counter_arguments)}</ul>
</div>
<h2 class="heading heading-blue">
Why This Matters for India
</h2>
<ul>${list(s.india_specific_relevance)}</ul>
<div class="box box-red">
<strong>⚠️ Future Risks</strong>
<ul>${list(s.future_risks)}</ul>
</div>
<div class="box box-purple">
<strong>📘 Keywords for Mains</strong>
<ul>${list(s.mains_keywords)}</ul>
</div>
<div class="box box-amber">
<strong>✍️ Essay Dimensions</strong>
<ul>${list(s.essay_angles)}</ul>
</div>
<h2>📚 UPSC Previous Year Questions</h2>
<ul>${list(s.pyqs)}</ul>
<hr style="border:1px solid #ddd;margin:30px 0;">
<div class="box box-lightblue">
<strong>🔗 Interdisciplinary Linkages</strong>
<ul>${list(s.interlinkages)}</ul>
</div>
<div class="box box-lightpurple">
<strong>🧠 Expert Insight for UPSC Aspirants</strong>
<p>${s.expert_insight}</p>
</div>
<hr style="border:1px solid #ddd;margin:30px 0;">
<div id="about" class="box box-grey">
<h3>About the Author</h3>
<p><strong>AKB</strong> is a UPSC educator focusing on Editorial Analysis, GS Mains preparation and Current Affairs.</p>
</div>
<div class="box box-primary">
<strong>🔗 Related Articles:</strong>
<ul>
<li><a href="/search/label/EDITORIAL%20ANALYSIS">Editorial Analysis</a></li>
<li><a href="/search/label/UPSC">UPSC Notes</a></li>
</ul>
</div>

<hr style="border:1px solid #ddd;margin:30px 0;">
<h2 id="mains" style="color:#5e35b1;">📝 Mains Answer (150 words)</h2>
<strong>${(s.mains_150 || [{}])[0].question}</strong>
<p>${(s.mains_150 || [{}])[0].answer}</p>
<h2 id="mains2" style="color:#5e35b1;">📝 Mains Answer (250 words)</h2>
<strong>${(s.mains_250 || [{}])[0].question}</strong>
<p>${(s.mains_250 || [{}])[0].answer}</p>
<hr style="border:1px solid #ddd;margin:30px 0;">
<h2 style="color:#f9a825;">❓ Prelims MCQs</h2>
${mcqs}

<hr style="border:1px solid #ddd;margin:30px 0;">
<h2>❓ FAQs</h2>
${(s.faqs || []).map(f => `
<details style="background:#f5f5f5;border-radius:6px;margin-bottom:10px;padding:12px;">
<summary style="cursor:pointer;"><strong>${f.question}</strong></summary>
<p style="margin-top:10px;">${f.answer}</p>
</details>`).join('')}

<div style="background:#e3f2fd;border-radius:6px;padding:12px;">
<strong>🔗 Related Topics:</strong>
<ul>${list(seo.internal_link_suggestions)}</ul>
</div>
<div style="margin-top:20px;">
<strong>🏷️ Tags:</strong>
${(seo.tags || []).map(t => `<span style="background:#f1f1f1;padding:6px 10px;margin:3px;border-radius:5px;">${t}</span>`).join('')}
</div></div>
<script type="application/ld+json">
{
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": ${JSON.stringify(
    (s.faqs || []).map(f => ({
      "@type": "Question",
      "name": f.question,
      "acceptedAnswer": {
        "@type": "Answer",
        "text": f.answer
      }
    }))
  )}
}
</script>
<script type="application/ld+json">
${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "NewsArticle",

    "mainEntityOfPage": {
      "@type": "WebPage",
      "@id": `posturl`
    },

    "headline": seo.meta_title,

    "description": seo.meta_description,

    "image": [
      imageUrl || "https://www.jkdmm.in/default-image.jpg"
    ],

    "author": {
      "@type": "Person",
      "name": "Akhilesh Kumar Bhaskar",
      "url": "https://www.jkdmm.in/p/about-us.html",
      "sameAs": [
        "https://www.jkdmm.in/"
      ],
      "jobTitle": "UPSC Educator and Editorial Analyst"
    },

    "publisher": {
      "@type": "Organization",
      "name": "JKDMM-Jobs • Knowledge • Daily Materials & Mocktests",
      "url": "https://www.jkdmm.in",
      "logo": {
        "@type": "ImageObject",
        "url": "https://blogger.googleusercontent.com/img/a/AVvXsEgExco8lsQgQeKUawycNvDGQgELMityYm1QuG3v57pBJoVJXiNpnCs7iG3lIDxGfs9X-BYF8M9XBpt1nHQG-XnT4n2mRE9Kdas3XPxGFKIEEKTWJ_d_LBJLKqI4Ukl0iEeFjTpsgnmvAnC9rOWdrDlc26RssCtR05q6GwDfa4booA7R6Md_Mp2liIXcOtQ=s700"
      }
    },

    "datePublished": publishedDate.toISOString(),

    "dateModified": new Date().toISOString(),

    "articleSection": [
      "Editorial Analysis",
      "UPSC Current Affairs",
      "State PSC Current Affairs",
      "GS Analysis"
    ],

    "keywords": (seo.keywords || []).join(", "),

    "wordCount": wordCount,

    "inLanguage": "en",

    "isAccessibleForFree": true,

    "genre": [
      "Educational",
      "Current Affairs",
      "UPSC Preparation"
    ],

    "about": [
      {
        "@type": "Thing",
        "name": seo.tags?.[0] || "UPSC"
      },
      {
        "@type": "Thing",
        "name": seo.tags?.[1] || "Current Affairs"
      }
    ],

    "speakable": {
      "@type": "SpeakableSpecification",
      "cssSelector": [
        "h1",
        "#intro",
        "#conclusion"
      ]
    }
  })}
</script>`;
  return html.trim();
}

// 7. RenderForm — generate thumbnail
async function generateThumbnail(title) {
  let template = process.env.RENDERFORM_TEMPLATE || 'bad-mermaids-stretch-weakly-1555';
  let titleKey = 'title.text';

  const resp = await axios.post(
    'https://get.renderform.io/api/v2/render',
    {
      template: template,
      data: { [titleKey]: title },
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
async function publishToBlogger(title, content, labels, searchDescription) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.BLOGGER_CLIENT_ID,
    process.env.BLOGGER_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: process.env.BLOGGER_REFRESH_TOKEN });
  const blogger = google.blogger({ version: 'v3', auth: oauth2Client });

  const requestBody = {
    kind: 'blogger#post',
    title,
    content,
    labels: Array.isArray(labels) ? labels : [labels],
  };

  if (searchDescription) {
    requestBody.customMetaData = searchDescription;
  }

  const resp = await blogger.posts.insert({
    blogId: process.env.BLOGGER_BLOG_ID,
    isDraft: true,
    requestBody,
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
async function runPipeline(jobId, urls, imagePaths, importantText = '') {
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
    pushStep(jobId, { id: 'ai', icon: '✨', label: `Gemini Writing Article`, status: 'active', data: null });
    updateJob(jobId, { step: `Generating Article with Gemini AI...`, progress: 35 });

    const articleData = await generateStructuredArticle(mergedContent, importantText);
    let s, seo, postTitle;

    s = articleData.structured;
    seo = articleData.seo;
    postTitle = s.title || seo.meta_title;

    pushStep(jobId, {
      id: 'ai', icon: '✨', label: 'Content Generated by Gemini', status: 'done',
      data: {
        type: 'article',
        title: postTitle,
        metaTitle: seo.meta_title,
        metaDescription: seo.meta_description,
        examRelevance: seo.exam_relevance || 'N/A',
        introduction: s.introduction || '',
        slug: seo.slug,
        canonical: seo.canonical || '',
        keywords: seo.keywords || [],
        tags: seo.tags || [],
        labels: seo.label || [],
        mcqCount: s.mcqs?.length || 0,
        backgroundCount: s.background?.length || 0,
        currentAffairs: s.current_affairs_addon || [],
        mains150Q: s.mains_150?.[0]?.question || '',
        mains250Q: s.mains_250?.[0]?.question || '',
        wayForward: s.way_forward || [],
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
      thumbnailDownloadUrl = await generateThumbnail(postTitle);
      pushStep(jobId, {
        id: 'thumb', icon: '🎨', label: 'Thumbnail Generated', status: 'done',
        data: {
          type: 'thumbnail',
          renderFormUrl: thumbnailDownloadUrl,
          title: postTitle,
        },
      });
      updateJob(jobId, { step: 'Downloading & uploading thumbnail...', progress: 65 });

      const { buffer, contentType } = await downloadImage(thumbnailDownloadUrl);

      // ── Step 6: Upload thumbnail to Google Drive ──────────────────────────
      pushStep(jobId, { id: 'drive', icon: '💾', label: 'Uploading to Google Drive', status: 'active', data: null });
      updateJob(jobId, { step: 'Uploading thumbnail to Google Drive...', progress: 70 });

      driveFileId = await uploadToGoogleDrive(buffer, `${postTitle}.png`, contentType);
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
      bloggerPost = await publishToBlogger(postTitle, htmlContent, seo.label, seo.searchDescription);
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
        title: postTitle,
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

    const importantText = req.body.importantText || '';

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
    runPipeline(jobId, urls, imagePaths, importantText);
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
