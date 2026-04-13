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
async function generateStructuredArticle(content, postType = 'editorial', importantText = '') {
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

  if (postType === 'job_posting') {
    prompt = `You are a highly accurate data extraction + content optimization engine.

Your task:
1. Extract structured job recruitment data
2. Improve readability of title, summary, and short_information (ONLY rephrase, DO NOT change meaning)
3. Keep all factual data EXACT (dates, numbers, names)

━━━━━━━━━━━━━━━━━━━━━━━
🚨 STRICT RULES
━━━━━━━━━━━━━━━━━━━━━━━

1. DO NOT hallucinate.
2. DO NOT change any facts (dates, numbers, posts, fees).
3. DO NOT assume missing values.
4. If data is missing → return "" (empty string).
5. Extract data EXACTLY from input.
6. Only improve:
   - title (make SEO friendly)
   - short_information (clear + readable)
   - summary (3–5 line crisp summary)
7. Keep everything else unchanged.
8. Remove ads, unrelated text, promotions.
9. Return ONLY valid JSON (no explanation, no markdown, no \`\`\`).

━━━━━━━━━━━━━━━━━━━━━━━
📦 OUTPUT FORMAT (STRICT)
━━━━━━━━━━━━━━━━━━━━━━━

{
  "title": "",
  "subtitle":"",
  "short_information": "",
  "hiringOrganization": "",
  "location": "",
  "state": "",
  "pincode":"",
  "advertisement_no":"",
  "important_dates": [
    {
      "application_start_date": "",
      "last_date": "",
      "fee_payment_last_date": "",
      "exam_date": "",
      "admit_card": ""
    }
  ],

  "application_fee": [
    {
      "general_ews_obc": "",
      "sc_st_female": "",
      "mode_of_payment": ""
    }
  ],

  "age_limit": [
    {
      "age_calculated_upto": "",
      "maximum_age": "",
      "minimum_age": "",
      "age_relexation": ""
    }
  ],

  "vacancy_detail": [
    {
      "total_post": "",
      "posts": [
        {
          "post_name": "",
          "no_of_post": ""
        }
      ]
    }
  ],

  "qualification": [
    {
      "post_name": "",
      "eligibility_criteria": ""
    }
  ],
  "salary": [
    {
      "posts": [
        {
          "post_name": "",
          "min_salary": "",
          "max_salary": ""
        }
      ]
    }
  ],

  "degree_name": [],
  "selection_mode": [],
  "how_to_apply": [],
  "apply_link": "",
  "official_notification_link":"",
  "official_website_link":"",
  "label":[],
  "tags":[],
  "summary": ""
}

━━━━━━━━━━━━━━━━━━━━━━━
📌 EXTRACTION RULES
━━━━━━━━━━━━━━━━━━━━━━━

- title → make short slightly SEO-friendly.
- subtitle → make slightly SEO-friendly (add key terms like "Apply Online", "Eligibility", "Last Date" if present in input)
- short_information → rewrite into clean readable 3–5 lines
- summary → short crisp 3–5 lines (factual only)

- important_dates → extract all dates exactly
- application_fee → category-wise fee
- age_limit → exact values
- vacancy_detail → total + post-wise breakup
- qualification → post-wise eligibility
- degree_name → on the basis of qualification array, get the degree name. In general Graduation, Post Graduation, Diploma, PhD, etc.
- selection_mode → array like ["Written Exam", "Interview"]
- how_to_apply → steps or paragraph
- apply_link → official link only
- official_notification_link → official notification link only
- official_website_link → official website link only
- label → RECRUITMENT, Central Govt Job|State Govt Job,PSU Job|Bank Job|Defence Job|Railway Job|Teaching Job|Nursing Job|Other
- tags → generate on the basis of content
- state → extract from the title or content. if not found then "India"
- location → always capital of state. if not found then "New Delhi"
- pincode → pincode of captital of state and if not found then make it:"110001"
- advertisement_no → if not found then make it:"hiringOrganization"+"-"+"post_name-" + "year"
━━━━━━━━━━━━━━━━━━━━━━━
⚠️ VALIDATION RULE
━━━━━━━━━━━━━━━━━━━━━━━

- Ensure output is valid JSON
- Ensure all keys exist
- Ensure arrays are not removed
- If unsure → leave empty ""

━━━━━━━━━━━━━━━━━━━━━━━
INPUT:
${contextSection}
${content}`;
  } else if (postType === 'normal') {
    prompt = `You must return ONLY valid JSON.
You are a professional content writer. Create an engaging blog post based on the input.
STRICT JSON FORMAT:
{
  "structured": {
    "title": "",
    "introduction": "",
    "sections": [
       { "heading": "", "content": "" }
    ],
    "conclusion": ""
  },
  "seo": {
    "meta_title": "",
    "meta_description": "",
    "keywords": [],
    "label": ["BLOG"],
    "tags": [],
    "slug": ""
  }
}
INPUT: 
${contextSection}
${content}`;
  } else {
    // DEFAULT: editorial (UPSC)
    prompt = `You must return ONLY valid JSON.

You are an expert UPSC / State PCS educator and answer-writing mentor.

Convert the given content into an exam-oriented article suitable for UPSC aspirants.

DO NOT hallucinate. Rewrite content in hindi + english (hindi heavy) (Easy understandable- don't use complex words in english or hindi) to make it completely original.

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
    "mains_150": [{"question":"","answer":""}],
    "mains_250": [{"question":"","answer":""}],
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
    "keywords": [],
    "label": [],
    "tags": [],
    "slug": "",
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
7. title should be catchy and interesting in english only so that urls can be generated easily. it should be of length not more than 36 characters including space.
8. slug should be title in lowercase words seperated by hyphen(-).It should be of length not more than 36 characters including hyphen(-).
9. label should have "NEWS","CURRENT AFFAIRS","EDITORIAL ANALYSIS","UPSC","STATE PCS", "ANSWER WRITING" in it.
10.featured_snippet -Add a short 2-3 line definition for featured snippet.Simple Hindi + English mix.Direct question-answer format. Question should be start with "What is [topic name]" and answer should be 2-3 lines.
11.alt_text - alt_text for image seo friendly.
12. meta_title - meta title for blog post seo friendly. It contains "UPSC GS1/2/3/4 2026", "Analysis", etc.
13. meta_description - meta description  is rich and keyword for seo friendly.
14. tags - tags for blog post seo friendly.
15. exam_relevance - exam relevance for blog post seo friendly.
16. keywords - keywords for blog post seo friendly. first keyword is "UPSC GS1/2/3/4 Topic" . Other keywords should be related to the subject and topic.
17. key_facts - key facts for blog post seo friendly. This is static GK which is related to the content of context provided. it should be 3-5 points.
INPUT: 
${contextSection}
${content}`;
  }

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

// 6. Build HTML article
function buildHtmlArticle(data, imageUrl, postType = 'editorial') {
  if (postType === 'job_posting') {
    const job = data; // In job posting, the whole structure IS the job data
    const safe = (v) => v ? v : "";
    const list = (arr) => (arr || []).map(i => `<li>${i}</li>`).join('');

    const dates = job.important_dates?.[0] || {};
    const fee = job.application_fee?.[0] || {};
    const age = job.age_limit?.[0] || {};
    const vacancy = job.vacancy_detail?.[0] || {};
    const posts = vacancy.posts || [];

    const vacancyRows = posts.map(p => `
    <tr>
    <td style="padding:10px;border:1px solid #ddd;">${p.post_name}</td>
    <td style="padding:10px;border:1px solid #ddd;text-align:center;">${p.no_of_post}</td>
    </tr>
    `).join('');

    const selection = list(job.selection_mode && job.selection_mode.length > 0 ? job.selection_mode : ["Written Exam"]);
    const degreeHtml = (job.degree_name && job.degree_name.length > 0 ? job.degree_name : ["Graduation"]).map(d => `<span style="background:#e8f5e9;padding:2px 6px;border-radius:4px;margin-right:4px;">${d}</span>`).join(' ');
    const howtoapply = list(job.how_to_apply && job.how_to_apply.length > 0 ? job.how_to_apply : ["Visit <strong>Official Website</strong>", "Read the official Notification", "Check for <strong>Online Apply link</strong>", "Fill the Required details in the form", "Upload the Required Documents", "Review the filled form or Verify the Details.", "Click <strong>Submit</strong> Button"]);
    const qualification = (job.qualification || []).map(q => `<li><strong>${q.post_name}:</strong> ${q.eligibility_criteria}</li>`).join('');

    const salary = (job.salary || []).map(s => {
      if (s.posts) {
        return s.posts.map(p => `<li><strong>${p.post_name}:</strong> ${p.min_salary}-${p.max_salary}</li>`).join('');
      }
      return `<li><strong>Salary:</strong> ${s.min_salary}-${s.max_salary}</li>`;
    }).join('');

    const html = `<meta name="robots" content="index, follow"><meta property="og:image" content="${imageUrl}"><meta property="og:title" content="${job.title}"><meta name="description" content="${safe(job.summary)}">
<meta name="keywords" content="${job.title}, govt jobs, apply online, vacancy">
<h1 style="color:#0d47a1;text-align:center;">${job.subtitle || job.title}</h1>
<div style="text-align:center;margin:20px 0;">
  <img src="${imageUrl}" alt="${job.title}" style="width:100%;max-width:850px;border-radius:12px;box-shadow:0 4px 10px rgba(0,0,0,0.1);" />
</div>
<div style="background:#e3f2fd;padding:14px;border-left:5px solid #1e88e5;border-radius:8px;margin-bottom:15px;">
<strong>📌 Short Information:</strong>
<p>${job.short_information}</p>
</div>
<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:15px;">
<div style="flex:1;min-width:150px;background:#fdecea;padding:12px;border-radius:8px;">
<strong>📊 Total Posts</strong>
<p>${vacancy.total_post}</p>
</div>
<div style="flex:1;min-width:150px;background:#e8f5e9;padding:12px;border-radius:8px;">
<strong>📅 Last Date</strong>
<p>${dates.last_date}</p>
</div>
<div style="flex:1;min-width:150px;background:#fff3e0;padding:12px;border-radius:8px;">
<strong>🎓 Qualification</strong>
<p>${degreeHtml}</p>
</div>
</div>
<h2>📅 Important Dates</h2>
<ul>
<li>Start: ${dates.application_start_date}</li>
<li>Last Date: ${dates.last_date}</li>
${dates.fee_payment_last_date ? `<li>Fee Last Date: ${dates.fee_payment_last_date}</li>` : ''}
${dates.exam_date ? `<li>Exam: ${dates.exam_date}</li>` : ''}
${dates.admit_card ? `<li>Admit Card: ${dates.admit_card}</li>` : ''}
</ul>
${fee.general_ews_obc || fee.sc_st_female || fee.mode_of_payment ? ` <h2>💰 Application Fee</h2>
<ul>
${fee.general_ews_obc ? `<li>General/OBC: ${fee.general_ews_obc}</li>` : ''}
${fee.sc_st_female ? `<li>SC/ST: ${fee.sc_st_female}</li>` : ''}
${fee.mode_of_payment ? `<li>Mode: ${fee.mode_of_payment}</li>` : ''}
</ul>` : ''}
${age.minimum_age || age.maximum_age || age.age_calculated_upto || age.age_relexation ? `<h2>🎯 Age Limit</h2>
<ul>
${age.minimum_age ? `<li>Min: ${age.minimum_age}</li>` : ''}
${age.maximum_age ? `<li>Max: ${age.maximum_age}</li>` : ''}
${age.age_calculated_upto ? `<li>As on: ${age.age_calculated_upto}</li>` : ''}
${age.age_relexation ? `<li>Relaxation: ${age.age_relexation}</li>` : ''}
</ul>` : ''}
${vacancyRows.length > 0 ? `<h2>📊 Vacancy Details</h2>
<table style="width:100%;border-collapse:collapse;background:#ffffff;border:1px solid #ddd;">
<tr style="background:#0d47a1;color:white;">
<th style="padding:10px;border:1px solid #ddd;">Post</th>
<th style="padding:10px;border:1px solid #ddd;">No. of Posts</th>
</tr>
${vacancyRows}
</table>` : ''}
${qualification.length > 0 ? `<h2>🎓 Qualification Detail</h2>
<ul>${qualification}</ul>` : ''}
${salary.length > 0 ? `<h2>🎓 Salary Detail</h2>
<ul>${salary}</ul>` : ''}
${selection.length > 0 ? `<h2>🧪 Selection Process</h2>
<ul>${selection}</ul>` : ''}
<div style="text-align:center;margin-top:25px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
<a href="${job.apply_link}" target="_blank" style="background:#0d47a1;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;">🚀 Apply Online</a>
</div>
<span style="color: red;"><b><strong>Candidates can apply through link provided below or they can also apply through official site before last date.</strong></b></span>
<div style="text-align:center;margin-top:25px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
<a href="${job.official_notification_link}" target="_blank" style="background:#2e7d32;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;">📜 Official Notification</a>
</div>
<div style="text-align:center;margin-top:25px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
<a href="${job.official_website_link}" target="_blank" style="background:#ef6c00;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;">🌐 Official Website</a>
</div>
<h2>📑 How to Apply</h2>
<ul>${howtoapply}</ul>
<h2>🖊️Summary</h2>
<p>${job.summary}</p>
<h2>❓ FAQs</h2>
${dates.last_date ? `<p><strong>What is last date?</strong></p>
<p><strong>Last Date:</strong> ${dates.last_date}</p>` : ''}
${vacancy.total_post ? `<p><strong>What is total posts?</strong></p>
<p><strong>Total Posts:</strong> ${vacancy.total_post}</p>` : ''}
${age.minimum_age || age.maximum_age ? `<p><strong>What is age limit?</strong></p>
<p><strong>Age Limit:</strong> ${age.minimum_age}-${age.maximum_age}</p>` : ''}
${fee.general_ews_obc || fee.sc_st_female ? `<p><strong>What is application fee?</strong></p>
<p><strong>Application Fee:</strong> ${fee.general_ews_obc || fee.sc_st_female}</p>` : ''}
${qualification ? `<p><strong>What is qualification?</strong></p>
<p><strong>Qualification:</strong> ${qualification}</p>` : ''}
${salary ? `<p><strong>What is salary?</strong></p>
<p><strong>Salary:</strong> ${salary}</p>` : ''}
${selection ? `<p><strong>What is selection process?</strong></p>
<p><strong>Selection Process:</strong> ${selection}</p>` : ''}

<div style="margin-top:20px;">
<strong>🏷️ Tags:</strong>
${(job.tags || []).map(t => `<span style="background:#f1f1f1;padding:6px 10px;margin:3px;border-radius:5px;">${t}</span>`).join('')}
${(job.label || []).map(t => `<span style="background:#f1f1f1;padding:6px 10px;margin:3px;border-radius:5px;">${t}</span>`).join('')}
</div>`;

    function toISO(dateStr) {
      if (!dateStr) return new Date().toISOString().split('T')[0];
      const d = new Date(dateStr);
      if (isNaN(d)) return new Date().toISOString().split('T')[0];
      return d.toISOString().split('T')[0];
    }
    const datePosted = toISO(dates.application_start_date);
    const validThrough = toISO(dates.last_date);
    const minSalary = (job.salary?.[0]?.posts?.[0]?.min_salary) || 20000;
    const maxSalary = (job.salary?.[0]?.posts?.[0]?.max_salary) || 80000;
    const locationName = job.location || "India";

    const schema = `<script type="application/ld+json">
{
 "@context": "https://schema.org",
 "@type": "JobPosting",
 "title": "${job.title}",
 "description": "${(job.summary || job.short_information || "").replace(/"/g, '\\"')}",
 "identifier": {
   "@type": "PropertyValue",
   "name": "${job.hiringOrganization || "Government Recruitment"}",
   "value": "${job.advertisement_no}"
 },
 "datePosted": "${datePosted}",
 "validThrough": "${validThrough ? validThrough + "T23:59" : ""}",
 "employmentType": "FULL_TIME",
 "directApply": true,
 "hiringOrganization": {
   "@type": "Organization",
   "name": "${job.hiringOrganization || "Government Organization"}",
   "sameAs": "${job.official_website_link || job.official_notification_link || ""}"
 },
 "jobLocation": {
   "@type": "Place",
   "address": {
     "@type": "PostalAddress",
     "addressLocality": "${locationName || "India"}",
     "addressRegion": "${job.state || ""}",
     "postalCode": "${job.pincode || ""}",
     "addressCountry": "IN"
   }
 },
 "applicantLocationRequirements": {
   "@type": "Country",
   "name": "India"
 },
 "baseSalary": {
   "@type": "MonetaryAmount",
   "currency": "INR",
   "value": {
     "@type": "QuantitativeValue",
     "minValue": ${minSalary || 20000},
     "maxValue": ${maxSalary || 80000},
     "unitText": "MONTH"
   }
 },
 "educationRequirements": "${(job.degree_name || []).join('or ')}",
 "experienceRequirements": "Freshers eligible; experience may required for some posts",
 "industry": "Government Recruitment",
 "occupationalCategory": "${(job.tags && job.tags[0]) || "Government Job"}",
 "jobBenefits": "Government job benefits, allowances, job security"
}
</script>

<script type="application/ld+json">
{
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "What is the last date to apply?",
 "acceptedAnswer": {
   "@type": "Answer",
   "text": "The last date is ${dates.last_date || "not specified"}."
 }
 },
 {
 "@type": "Question",
 "name": "What is total number of posts?",
 "acceptedAnswer": {
   "@type": "Answer",
   "text": "Total ${vacancy.total_post || "not specified"} posts are available."
 }
 },
 {
 "@type": "Question",
 "name": "What is age limit?",
 "acceptedAnswer": {
   "@type": "Answer",
   "text": "Total ${age.minimum_age || "not specified"} to ${age.maximum_age || "not specified"} posts are available."
 }
 },
 {
 "@type": "Question",
 "name": "What is application fee?",
 "acceptedAnswer": {
   "@type": "Answer",
   "text": "${fee.general_ews_obc || "not specified"} to ${fee.sc_st_female || "not specified"} "
 }
 },
 {
 "@type": "Question",
 "name": "What is qualification?",
 "acceptedAnswer": {
   "@type": "Answer",
   "text": "${qualification || "not specified"}"
 }
 },
 {
 "@type": "Question",
 "name": "What is salary?",
 "acceptedAnswer": {
   "@type": "Answer",
   "text": "${salary || "not specified"}"
 }
 },
 {
 "@type": "Question",
 "name": "What is selection process?",
 "acceptedAnswer": {
   "@type": "Answer",
   "text": "${selection || "not specified"}"
 }
 }
 ]
} 
</script>`;
    return (html + schema).replace(/\\n/g, '').replace(/\n/g, '').trim();
  }

  if (postType === 'normal') {
    const s = data.structured;
    const seo = data.seo;
    const imgTag = imageUrl ? `<div style="text-align:center;margin:20px 0;"><img src="${imageUrl}" style="width:100%;max-width:850px;border-radius:12px;" /></div>` : '';
    const sections = (s.sections || []).map(sec => `<h2>${sec.heading}</h2><p>${sec.content}</p>`).join('');
    const htmlContent = `<div style="font-family:sans-serif;line-height:1.6;max-width:800px;margin:auto;">
       <h1>${s.title || seo.meta_title}</h1>
       ${imgTag}
       <p>${s.introduction}</p>
       ${sections}
       <p>${s.conclusion}</p>
     </div>`;
    return htmlContent.replace(/\\n/g, '').replace(/\n/g, '').trim();
  }

  // DEFAULT: editorial (UPSC)
  const s = data.structured;
  const seo = data.seo;
  const publishedDate = new Date();
  const year = publishedDate.getFullYear();
  const month = String(publishedDate.getMonth() + 1).padStart(2, '0');
  const postSlug = seo.slug || (seo.meta_title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const list = (arr) => (arr || []).map(i => `<li>${i}</li>`).join('');
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

  const html = `<p><strong>By AKB | UPSC Educator</strong></p><meta name="description" content="${seo.meta_description}"><meta name="keywords" content="${(seo.keywords || []).join(', ')}">
<div style="background:#ffffff;font-family:Segoe UI,Arial;line-height:1.8;margin:auto;max-width:900px;padding:20px;">
<h1 style="color:#0d47a1;font-size:30px;">${seo.meta_title}</h1>
${imgTag}

<div style="background:#fff3e0;padding:12px;border-left:5px solid #ff9800;border-radius:6px;margin-bottom:15px;padding:14px;">
<strong>📌 ${s.featured_snippet.question}</strong>
<p>${s.featured_snippet.answer}</p>
</div>
<div style="background:#e8f5e9;padding:12px;border-left:5px solid #43a047;border-radius:6px;margin-bottom:15px;padding:14px;">
<strong>📰 Why in News?</strong>
<ul>${list(s.why_in_news)}</ul>
</div>
<div style="background:#fcf7c1;border-left:5px solid #a09402;border-radius:6px;margin-bottom:15px;padding:14px;">
<strong>📌 In Short:</strong>
<p>${seo.meta_description}</p>
</div>
<div style="background:#e3f2fd;border-left:5px solid #1e88e5;border-radius:6px;margin-bottom:15px;padding:14px;">
<strong>🎯 Exam Relevance:</strong>
<p>${seo.exam_relevance}</p>
</div>
<p style="background:#f1e0f3;padding:10px;border-radius:6px;"><strong>${seo.keywords[0]}:</strong> ${(seo.keywords || []).join(', ')}</p>
<div style="background:#d09ddbff;padding:12px;border-left:5px solid #482451ff;border-radius:6px;margin-bottom:15px;">
<strong>📊 Key Facts:</strong>
<ul>${list(s.key_facts)}</ul>
</div>
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

<div style="background:#e3f2fd;padding:10px;border-radius:6px;">
<strong>🔗 Related Articles:</strong>
<ul>
<li><a href="/search/label/EDITORIAL%20ANALYSIS">Editorial Analysis</a></li>
<li><a href="/search/label/UPSC">UPSC Notes</a></li>
</ul>
</div>

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
<h2>❓ FAQs</h2>
${(s.faqs || []).map(f => `
<details>
<summary><strong>${f.question}</strong></summary>
<p>${f.answer}</p>
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
{
 "@context": "https://schema.org",
 "@type": "Article",
 "headline": "${seo.meta_title}",
 "description": "${seo.meta_description}",
 "author": {"@type": "Person","name": "By AKB | UPSC Educator"},
 "publisher": {
   "@type": "Organization",
   "name": "JKDMM",
   "logo": {
     "@type": "ImageObject",
     "url": "https://blogger.googleusercontent.com/img/a/AVvXsEgExco8lsQgQeKUawycNvDGQgELMityYm1QuG3v57pBJoVJXiNpnCs7iG3lIDxGfs9X-BYF8M9XBpt1nHQG-XnT4n2mRE9Kdas3XPxGFKIEEKTWJ_d_LBJLKqI4Ukl0iEeFjTpsgnmvAnC9rOWdrDlc26RssCtR05q6GwDfa4booA7R6Md_Mp2liIXcOtQ=s700"
   }
 },
 "mainEntityOfPage": {
   "@type": "WebPage",
   "@id": "https://www.jkdmm.in/${year}/${month}/${postSlug}.html"
 }
}
</script>`;
  return html.replace(/\\n/g, '').replace(/\n/g, '').trim();
}

// 7. RenderForm — generate thumbnail
async function generateThumbnail(title, postType = 'editorial') {
  let template = process.env.RENDERFORM_TEMPLATE || 'bad-mermaids-stretch-weakly-1555';
  let titleKey = 'title.text';

  if (postType === 'job_posting') {
    template = 'purple-dragonflies-push-fiercely-1833';
    titleKey = 'text_1.text';
  }

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
async function runPipeline(jobId, urls, imagePaths, postType = 'editorial', importantText = '') {
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
    pushStep(jobId, { id: 'ai', icon: '✨', label: `Gemini Writing ${postType === 'job_posting' ? 'Job' : 'Article'}`, status: 'active', data: null });
    updateJob(jobId, { step: `Generating ${postType} with Gemini AI...`, progress: 35 });

    const articleData = await generateStructuredArticle(mergedContent, postType, importantText);
    let s, seo, postTitle;

    if (postType === 'job_posting') {
      s = articleData;
      seo = {
        meta_title: articleData.title,
        meta_description: articleData.summary,
        label: articleData.label,
        tags: articleData.tags,
        slug: (articleData.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      };
      postTitle = articleData.title;
    } else {
      s = articleData.structured;
      seo = articleData.seo;
      postTitle = s.title || seo.meta_title;
    }

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
      thumbnailDownloadUrl = await generateThumbnail(postTitle, postType);
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
    const htmlContent = buildHtmlArticle(articleData, driveImageUrl, postType);

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
      bloggerPost = await publishToBlogger(postTitle, htmlContent, seo.label, seo.slug);
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

    const postType = req.body.postType || 'editorial';
    const importantText = req.body.importantText || '';

    const jobId = uuidv4();
    jobs[jobId] = {
      jobId,
      status: 'running',
      step: 'Starting pipeline...',
      progress: 0,
      postType,
      createdAt: new Date().toISOString(),
      sseClients: [],
    };

    res.json({ jobId });

    // Run pipeline asynchronously
    runPipeline(jobId, urls, imagePaths, postType, importantText);
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
