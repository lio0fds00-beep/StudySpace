import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@latest/build/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@latest/build/pdf.worker.min.mjs";

/* ---------------- IndexedDB Storage ---------------- */
const DB_NAME = "study-space-v3";
const STORE = "lectures";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllLectures() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.createdAt - a.createdAt));
    req.onerror = () => reject(req.error);
  });
}

async function saveLecture(lecture) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(lecture);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteLecture(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function clearAllLectures() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------------- Settings ---------------- */
const DEFAULT_SETTINGS = {
  accessCode: "",
  lang: "ar",
};

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("ss_student_settings") || "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s) {
  localStorage.setItem("ss_student_settings", JSON.stringify(s));
}

/* ---------------- App State ---------------- */
const state = {
  view: "home",
  studyTab: "parts",
  lectures: [],
  activeLectureId: null,
  activePartIndex: 0,
  quizState: { qIndex: 0, picked: null, answered: false, score: 0, finished: false },
  busy: false,
  busyMessage: "",
  needAccessCode: false,
  alert: null,
  uploadProgress: null,
  settings: loadSettings(),
};

function esc(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setAlert(type, text) {
  state.alert = text ? { type, text } : null;
  render();
}

function applyLang() {
  const isAr = state.settings.lang === "ar";
  document.documentElement.lang = isAr ? "ar" : "en";
  document.documentElement.dir = isAr ? "rtl" : "ltr";
}

/* ---------------- Fast PDF / TXT Extraction ---------------- */
async function extractPagesFromFile(file, onProgress) {
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "txt" || ext === "md") {
    const text = await file.text();
    const chunks = text.match(/[\s\S]{1,2200}/g) || [text];
    return chunks.map((t, i) => ({ num: i + 1, text: t.trim() })).filter((p) => p.text);
  }

  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim();
    pages.push({ num: i, text });
    onProgress(i, pdf.numPages);
    await new Promise((r) => setTimeout(r, 0));
  }
  return pages;
}

function buildParts(pages, pagesPerPart = 8) {
  const parts = [];
  for (let i = 0; i < pages.length; i += pagesPerPart) {
    const slice = pages.slice(i, i + pagesPerPart);
    parts.push({
      index: parts.length,
      startPage: slice[0].num,
      endPage: slice[slice.length - 1].num,
      title: `الجزء ${parts.length + 1} (ص ${slice[0].num}–${slice[slice.length - 1].num})`,
      summary: null,
      quiz: null,
    });
  }
  return parts;
}

/* ---------------- Call Server Proxy (/api/ai) ---------------- */
async function callAI(prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

  try {
    const res = await fetch("./api/ai", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-access-code": state.settings.accessCode || "",
      },
      body: JSON.stringify({ prompt }),
    });

    if (res.status === 404) {
      throw new Error("ملف السيرفر (functions/api/ai.js) غير موجود أو لم يُنشر بعد.");
    }

    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      state.needAccessCode = true;
      throw new Error(data.error || "مطلوب رمز الدخول للمادة.");
    }
    if (!res.ok) {
      throw new Error(data.error || `خطأ من السيرفر (${res.status})`);
    }
    state.needAccessCode = false;
    return data;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("انتهت المهلة (45 ثانية). حاول تقليل عدد الصفحات في الجزء.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function generatePartContent(lecture, partIndex) {
  const part = lecture.parts[partIndex];
  const slice = lecture.pages.filter((p) => p.num >= part.startPage && p.num <= part.endPage);
  const textChunk = slice.map((p) => `[Page ${p.num}]\n${p.text}`).join("\n\n").slice(0, 28000);

  if (!textChunk.trim()) {
    throw new Error("هذا الجزء لا يحتوي على نص قابل للقراءة (قد يكون PDF مصوّر كصور).");
  }

  const prompt = `Analyze the following study material and return ONLY valid JSON with this exact schema:
{
  "summary": [
    { "en": "Concise key concept in source language", "ar": "شرح واضح ومختصر بالعربية", "page": 1 }
  ],
  "quiz": [
    {
      "q": "Clear multiple-choice question testing understanding",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "answerIndex": 0,
      "explanation": "Short explanation in Arabic of why this answer is correct",
      "page": 1
    }
  ]
}
Rules:
- Create 5 to 8 high-value summary points.
- Create 5 challenging MCQ questions with exactly 4 options each.
- Base everything strictly on the provided text.

MATERIAL:
${textChunk}`;

  const result = await callAI(prompt);
  if (!Array.isArray(result.summary) || !Array.isArray(result.quiz)) {
    throw new Error("صيغة الرد من الذكاء الاصطناعي غير متوقعة. حاول مرة أخرى.");
  }

  part.summary = result.summary;
  part.quiz = result.quiz;
  lecture.lastPart = partIndex;
  await saveLecture(lecture);
}

/* ---------------- UI Helpers ---------------- */
function getActiveLecture() {
  return state.lectures.find((l) => l.id === state.activeLectureId) || null;
}

function resetQuiz() {
  state.quizState = { qIndex: 0, picked: null, answered: false, score: 0, finished: false };
}

/* ---------------- Render Views ---------------- */
function renderAlert() {
  if (!state.alert) return "";
  return `
    <div class="alert ${state.alert.type}">
      <span>${esc(state.alert.text)}</span>
      <button class="icon-btn" data-action="dismiss-alert" aria-label="إغلاق">✕</button>
    </div>`;
}

function renderAccessPromptIfNeeded() {
  if (!state.needAccessCode) return "";
  return `
    <form class="panel" id="quickCodeForm" style="margin-bottom:20px">
      <h3>أدخل رمز الدخول الخاص بالطلاب</h3>
      <p class="muted tiny" style="margin:6px 0 12px">اطلب الرمز من مشرف الموقع (يُحفظ في جهازك مرة واحدة فقط).</p>
      <div class="row">
        <input type="text" id="quickAccessCode" value="${esc(state.settings.accessCode)}" placeholder="أدخل الرمز هنا..." dir="ltr" required />
        <button class="primary" type="submit" style="flex:none">حفظ الرمز</button>
      </div>
    </form>`;
}

function renderHome() {
  const latest = state.lectures[0];
  if (!latest) {
    return `
      <div class="page-heading">
        <div>
          <h1>مساحة دراسة</h1>
          <p>ارفع ملف المحاضرة واحصل على ملخص واختبار فوري بالذكاء الاصطناعي</p>
        </div>
      </div>
      ${renderAlert()}
      <section class="welcome">
        <div class="welcome-icon">📚</div>
        <span class="welcome-kicker">سريع • يحفظ محلياً في جهازك • بدون تعقيد</span>
        <h2>جاهز تبدأ مذاكرتك بذكاء؟</h2>
        <p>ارفع ملف PDF أو نص، وسنقسمه لك لأجزاء مع ملخص واختبار لكل جزء.</p>
        <button class="primary" data-nav="upload">رفع أول محاضرة</button>
      </section>`;
  }

  return `
    <div class="page-heading">
      <div>
        <h1>مكتبتك الدراسية</h1>
        <p>اختر محاضرة للمتابعة أو ارفع ملفاً جديداً</p>
      </div>
      <button class="primary" data-nav="upload">+ محاضرة جديدة</button>
    </div>
    ${renderAlert()}
    <section class="continue-card">
      <div>
        <span class="eyebrow">متابعة من حيث توقفت</span>
        <h2>${esc(latest.title)}</h2>
        <p>${esc(latest.subject || "مادة عامة")} • ${latest.pages.length} صفحة • ${latest.parts.length} أجزاء</p>
      </div>
      <button class="light-button" data-open-lecture="${esc(latest.id)}">فتح المحاضرة</button>
    </section>
    <div class="section-title">
      <h2>كل المحاضرات</h2>
      <span class="muted">${state.lectures.length} ملفات</span>
    </div>
    <div class="library-grid">
      ${state.lectures
        .map((lec) => {
          const readyCount = lec.parts.filter((p) => p.summary).length;
          return `
          <article class="panel lecture-card">
            <div class="row between">
              <div class="file-symbol">📄</div>
              <span class="tag ${readyCount > 0 ? "ready" : ""}">${readyCount}/${lec.parts.length} أجزاء جاهزة</span>
            </div>
            <h3>${esc(lec.title)}</h3>
            <p class="muted">${esc(lec.subject || "بدون تصنيف")} • ${lec.pages.length} صفحة</p>
            <div class="row between">
              <button class="secondary" data-open-lecture="${esc(lec.id)}">دراسة</button>
              <button class="text-button" data-delete-lecture="${esc(lec.id)}">حذف</button>
            </div>
          </article>`;
        })
        .join("")}
    </div>`;
}

function renderUpload() {
  const p = state.uploadProgress;
  return `
    <div class="page-heading">
      <div>
        <h1>رفع محاضرة جديدة</h1>
        <p>يتم قراءة الملف داخل جهازك في ثوانٍ بدون انتظار</p>
      </div>
    </div>
    ${renderAlert()}
    <div class="upload-layout">
      <form class="panel upload-form" id="uploadForm">
        <label class="dropzone" for="fileInput">
          <span class="upload-symbol">⬆️</span>
          <strong id="fileNameLabel">اضغط لاختيار ملف PDF أو TXT</strong>
          <span>يفضّل ملفات PDF النصية لسرعة الاستخراج</span>
          <input id="fileInput" type="file" accept=".pdf,.txt,.md" hidden required />
        </label>
        <div class="form-grid">
          <label>
            عنوان المحاضرة
            <input type="text" id="lecTitle" placeholder="مثال: المحاضرة 3 - الفارماكولوجي" required />
          </label>
          <label>
            اسم المادة
            <input type="text" id="lecSubject" placeholder="مثال: علم الأدوية" />
          </label>
          <label>
            عدد الصفحات في كل جزء
            <select id="pagesPerPart">
              <option value="5">5 صفحات (أسرع)</option>
              <option value="8" selected>8 صفحات (متوازن)</option>
              <option value="12">12 صفحة</option>
            </select>
          </label>
        </div>
        ${
          p
            ? `<div class="import-progress">
                 <div><span>جاري قراءة ${esc(p.name)}</span><span>${p.current} / ${p.total}</span></div>
                 <progress value="${p.current}" max="${p.total}"></progress>
               </div>`
            : ""
        }
        <button class="primary" type="submit" ${state.busy ? "disabled" : ""}>
          ${state.busy ? "جاري الاستخراج..." : "إضافة للمكتبة"}
        </button>
      </form>
    </div>`;
}

function renderStudy() {
  const lec = getActiveLecture();
  if (!lec) return renderHome();
  const part = lec.parts[state.activePartIndex] || lec.parts[0];

  const tabsHtml = `
    <button class="text-button back-link" data-nav="home">← العودة للمكتبة</button>
    <div class="page-heading">
      <div>
        <h1>${esc(lec.title)}</h1>
        <p>${esc(lec.subject || "مادة عامة")} • ${lec.pages.length} صفحة</p>
      </div>
    </div>
    ${renderAlert()}
    ${renderAccessPromptIfNeeded()}
    ${
      state.busy
        ? `<div class="generation-live">
             <div class="busy"><span class="spin">⏳</span><div><strong>${esc(state.busyMessage)}</strong><small>يتم التوليد وحفظه تلقائياً في جهازك</small></div></div>
           </div>`
        : ""
    }
    <div class="part-tabs">
      <button class="${state.studyTab === "parts" ? "active" : ""}" data-tab="parts">الأجزاء (${lec.parts.length})</button>
      <button class="${state.studyTab === "summary" ? "active" : ""}" data-tab="summary">الملخص (${esc(part.title)})</button>
      <button class="${state.studyTab === "quiz" ? "active" : ""}" data-tab="quiz">الاختبار</button>
    </div>`;

  if (state.studyTab === "parts") {
    return (
      tabsHtml +
      `<div class="part-grid">
        ${lec.parts
          .map((pt, idx) => {
            const ready = Boolean(pt.summary && pt.quiz);
            return `
            <article class="panel part-card ${ready ? "prepared" : ""}">
              <div class="row between">
                <span class="part-number">Part 0${idx + 1}</span>
                <span class="tag ${ready ? "ready" : ""}">${ready ? "جاهز" : "غير مجهز"}</span>
              </div>
              <h3>${esc(pt.title)}</h3>
              <p class="muted">${ready ? `${pt.summary.length} نقاط • ${pt.quiz.length} أسئلة` : "اضغط تجهيز لتوليد الملخص والاختبار"}</p>
              <div class="part-actions">
                ${
                  ready
                    ? `<button class="primary" data-view-summary="${idx}">الملخص</button>
                       <button class="secondary" data-start-quiz="${idx}">الاختبار</button>`
                    : `<button class="primary" data-generate-part="${idx}" ${state.busy ? "disabled" : ""}>تجهيز بالـ AI</button>`
                }
              </div>
            </article>`;
          })
          .join("")}
      </div>`
    );
  }

  if (state.studyTab === "summary") {
    if (!part.summary) {
      return (
        tabsHtml +
        `<div class="panel empty">
           <h3>هذا الجزء غير مجهز بعد</h3>
           <p>اضغط الزر بالأسفل لتوليد الملخص والاختبار لهذا الجزء.</p>
           <button class="primary" data-generate-part="${part.index}" ${state.busy ? "disabled" : ""}>تجهيز الآن</button>
         </div>`
      );
    }
    return (
      tabsHtml +
      `<section class="panel summary">
        <div class="row between">
          <div>
            <span class="eyebrow">ملخص ذكي</span>
            <h2>${esc(part.title)}</h2>
          </div>
          <button class="primary" data-start-quiz="${part.index}">ابدأ اختبار الجزء</button>
        </div>
        <div class="summary-points">
          ${part.summary
            .map(
              (pt, i) => `
            <article>
              <span class="point-num">${String(i + 1).padStart(2, "0")}</span>
              <div>
                <p dir="auto">${esc(pt.en || "")}</p>
                ${pt.ar ? `<p class="arabic-point">${esc(pt.ar)}</p>` : ""}
                ${pt.page ? `<span class="source-link">المصدر: صفحة ${esc(pt.page)}</span>` : ""}
              </div>
            </article>`
            )
            .join("")}
        </div>
        <div class="row between">
          <button class="secondary" data-generate-part="${part.index}" ${state.busy ? "disabled" : ""}>إعادة التوليد</button>
          <button class="primary" data-start-quiz="${part.index}">الانتقال للاختبار ←</button>
        </div>
      </section>`
    );
  }

  if (!part.quiz || !part.quiz.length) {
    return (
      tabsHtml +
      `<div class="panel empty">
         <h3>لا يوجد اختبار لهذا الجزء بعد</h3>
         <p>جهّز الجزء أولاً لتوليد أسئلة الاختبار.</p>
         <button class="primary" data-generate-part="${part.index}" ${state.busy ? "disabled" : ""}>تجهيز الآن</button>
       </div>`
    );
  }

  const qState = state.quizState;
  if (qState.finished) {
    const pct = Math.round((qState.score / part.quiz.length) * 100);
    return (
      tabsHtml +
      `<div class="quiz-wrap">
        <div class="panel empty">
          <div class="empty-icon">🎯</div>
          <h3>انتهيت من الاختبار!</h3>
          <p>درجتك: <strong>${qState.score} من ${part.quiz.length}</strong> (${pct}%)</p>
          <div class="row" style="justify-content:center">
            <button class="primary" data-start-quiz="${part.index}">إعادة الاختبار</button>
            <button class="secondary" data-tab="parts">رجوع للأجزاء</button>
          </div>
        </div>
      </div>`
    );
  }

  const q = part.quiz[qState.qIndex];
  const progressPct = Math.round(((qState.qIndex + 1) / part.quiz.length) * 100);
  const letters = ["A", "B", "C", "D"];

  return (
    tabsHtml +
    `<div class="quiz-wrap">
      <div class="panel quiz-card">
        <div class="row between">
          <span class="tag">${esc(part.title)}</span>
          <span class="muted tiny">سؤال ${qState.qIndex + 1} من ${part.quiz.length}</span>
        </div>
        <div class="progress-bar"><span style="width:${progressPct}%"></span></div>
        <div class="question-meta"><span>Question ${qState.qIndex + 1}</span>${q.page ? `<span>• Page ${esc(q.page)}</span>` : ""}</div>
        <div class="question" dir="auto">${esc(q.q)}</div>
        <div class="choices">
          ${q.options
            .map((opt, i) => {
              let cls = "choice";
              if (qState.answered) {
                if (i === q.answerIndex) cls += " correct";
                else if (i === qState.picked) cls += " incorrect";
              } else if (i === qState.picked) {
                cls += " picked";
              }
              return `
              <button class="${cls}" data-pick-choice="${i}" ${qState.answered ? "disabled" : ""} dir="auto">
                <b>${letters[i] || i + 1}</b>
                <span>${esc(opt)}</span>
              </button>`;
            })
            .join("")}
        </div>
        ${
          qState.answered
            ? `<div class="feedback ${qState.picked === q.answerIndex ? "" : "wrong"}">
                 <h3>${qState.picked === q.answerIndex ? "إجابة صحيحة ✓" : "إجابة غير صحيحة ✕"}</h3>
                 <p>${esc(q.explanation || "")}</p>
               </div>`
            : ""
        }
        <div class="row between quiz-actions">
          ${
            !qState.answered
              ? `<button class="primary" data-submit-answer ${qState.picked === null ? "disabled" : ""}>تحقق من الإجابة</button>`
              : `<button class="primary" data-next-question>${qState.qIndex + 1 < part.quiz.length ? "السؤال التالي" : "عرض النتيجة"}</button>`
          }
        </div>
      </div>
    </div>`
  );
}

function renderSettings() {
  return `
    <div class="page-heading">
      <div>
        <h1>الإعدادات</h1>
        <p>إعدادات الوصول وحفظ البيانات في جهازك</p>
      </div>
    </div>
    ${renderAlert()}
    <div class="settings-stack">
      <form class="panel" id="settingsForm">
        <h2>رمز الدخول (اختياري)</h2>
        <p class="muted">إذا طلب منك مشرف المادة رمز دخول، اكتبه هنا مرة واحدة وسيعمل الموقع مباشرة.</p>
        <label style="margin-bottom:18px">
          رمز الدخول (Access Code)
          <input type="text" id="setAccessCode" value="${esc(state.settings.accessCode)}" placeholder="اتركه فارغاً إذا كان الموقع مفتوحاً" dir="ltr" />
        </label>
        <div class="row wrap">
          <button class="primary" type="submit">حفظ</button>
          <button class="secondary" type="button" data-action="test-ai" ${state.busy ? "disabled" : ""}>
            ${state.busy ? "جاري الفحص..." : "فحص اتصال الذكاء الاصطناعي"}
          </button>
        </div>
      </form>
      <div class="panel">
        <h2>إدارة التخزين المحلي</h2>
        <p class="muted">المحاضرات والملخصات محفوظة في متصفحك لسرعة الفتح.</p>
        <button class="danger" type="button" data-action="clear-all">حذف جميع المحاضرات من جهازي</button>
      </div>
    </div>`;
}

function render() {
  applyLang();
  const root = document.getElementById("root");
  let content = "";
  if (state.view === "home") content = renderHome();
  else if (state.view === "upload") content = renderUpload();
  else if (state.view === "study") content = renderStudy();
  else if (state.view === "settings") content = renderSettings();

  root.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-icon">📖</div>
          <div><b>مساحة دراسة</b><small>Study Space</small></div>
        </div>
        <nav>
          <button class="${state.view === "home" || state.view === "study" ? "active" : ""}" data-nav="home">المكتبة</button>
          <button class="${state.view === "upload" ? "active" : ""}" data-nav="upload">رفع ملف</button>
          <button class="${state.view === "settings" ? "active" : ""}" data-nav="settings">الإعدادات</button>
        </nav>
        <div class="sidebar-bottom">
          <div class="local-status"><span></span> جاهز للطلاب</div>
        </div>
      </aside>
      <div class="workspace">
        <header class="topbar">
          <span class="desktop-location">مساحة دراسة • ملخصات واختبارات سريعة</span>
          <span class="mobile-brand">📖 مساحة دراسة</span>
          <div class="top-actions">
            <button class="language" data-action="toggle-lang">${state.settings.lang === "ar" ? "EN" : "عربي"}</button>
            <button class="icon-btn mobile-settings" data-nav="settings" aria-label="الإعدادات">⚙️</button>
          </div>
        </header>
        <main>${content}</main>
      </div>
      <footer class="ownership">Study Space • Fast AI Workspace</footer>
    </div>`;
}

/* ---------------- Events ---------------- */
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-nav],[data-action],[data-open-lecture],[data-delete-lecture],[data-tab],[data-generate-part],[data-view-summary],[data-start-quiz],[data-pick-choice],[data-submit-answer],[data-next-question]");
  if (!btn) return;

  if (btn.dataset.nav) {
    state.view = btn.dataset.nav;
    state.alert = null;
    render();
  } else if (btn.dataset.action === "dismiss-alert") {
    setAlert(null, null);
  } else if (btn.dataset.action === "toggle-lang") {
    state.settings.lang = state.settings.lang === "ar" ? "en" : "ar";
    saveSettings(state.settings);
    render();
  } else if (btn.dataset.action === "clear-all") {
    if (confirm("هل أنت متأكد من حذف جميع المحاضرات المحفوظة من جهازك؟")) {
      await clearAllLectures();
      state.lectures = [];
      state.activeLectureId = null;
      setAlert("notice", "تم مسح جميع المحاضرات من جهازك.");
    }
  } else if (btn.dataset.openLecture) {
    state.activeLectureId = btn.dataset.openLecture;
    const lec = getActiveLecture();
    state.activePartIndex = lec?.lastPart || 0;
    state.studyTab = "parts";
    state.view = "study";
    state.alert = null;
    render();
  } else if (btn.dataset.deleteLecture) {
    await deleteLecture(btn.dataset.deleteLecture);
    state.lectures = await getAllLectures();
    render();
  } else if (btn.dataset.tab) {
    state.studyTab = btn.dataset.tab;
    render();
  } else if (btn.dataset.generatePart !== undefined) {
    const idx = Number(btn.dataset.generatePart);
    const lec = getActiveLecture();
    if (!lec) return;
    state.activePartIndex = idx;
    state.busy = true;
    state.busyMessage = "جاري إنشاء الملخص والاختبار بالذكاء الاصطناعي...";
    state.alert = null;
    render();
    try {
      await generatePartContent(lec, idx);
      state.studyTab = "summary";
      setAlert("notice", "تم تجهيز الجزء وحفظه بنجاح!");
    } catch (err) {
      setAlert("error", err.message || "حدث خطأ أثناء الاتصال بالذكاء الاصطناعي");
    } finally {
      state.busy = false;
      render();
    }
  } else if (btn.dataset.viewSummary !== undefined) {
    state.activePartIndex = Number(btn.dataset.viewSummary);
    state.studyTab = "summary";
    render();
  } else if (btn.dataset.startQuiz !== undefined) {
    state.activePartIndex = Number(btn.dataset.startQuiz);
    resetQuiz();
    state.studyTab = "quiz";
    render();
  } else if (btn.dataset.pickChoice !== undefined) {
    state.quizState.picked = Number(btn.dataset.pickChoice);
    render();
  } else if ("submitAnswer" in btn.dataset) {
    const lec = getActiveLecture();
    const q = lec.parts[state.activePartIndex].quiz[state.quizState.qIndex];
    state.quizState.answered = true;
    if (state.quizState.picked === q.answerIndex) state.quizState.score++;
    render();
  } else if ("nextQuestion" in btn.dataset) {
    const lec = getActiveLecture();
    const quiz = lec.parts[state.activePartIndex].quiz;
    if (state.quizState.qIndex + 1 < quiz.length) {
      state.quizState.qIndex++;
      state.quizState.picked = null;
      state.quizState.answered = false;
    } else {
      state.quizState.finished = true;
    }
    render();
  } else if (btn.dataset.action === "test-ai") {
    state.busy = true;
    render();
    try {
      const res = await callAI('Return JSON: {"ok": true}');
      setAlert("notice", res?.ok ? "السيرفر والذكاء الاصطناعي شغالين 100%!" : "تم الاتصال.");
    } catch (err) {
      setAlert("error", err.message);
    } finally {
      state.busy = false;
      render();
    }
  }
});

document.addEventListener("change", (e) => {
  if (e.target.id === "fileInput" && e.target.files?.[0]) {
    const f = e.target.files[0];
    document.getElementById("fileNameLabel").textContent = f.name;
    const titleEl = document.getElementById("lecTitle");
    if (titleEl && !titleEl.value) titleEl.value = f.name.replace(/\.[^.]+$/, "");
  }
});

document.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (e.target.id === "uploadForm") {
    const file = document.getElementById("fileInput").files?.[0];
    if (!file) return setAlert("warning", "اختر ملفاً أولاً.");
    const title = document.getElementById("lecTitle").value.trim() || file.name;
    const subject = document.getElementById("lecSubject").value.trim();
    const perPart = Number(document.getElementById("pagesPerPart").value) || 8;

    state.busy = true;
    state.uploadProgress = { current: 0, total: 1, name: file.name };
    render();

    try {
      const pages = await extractPagesFromFile(file, (current, total) => {
        state.uploadProgress = { current, total, name: file.name };
        const prog = document.querySelector("progress");
        if (prog) {
          prog.value = current;
          prog.max = total;
        }
      });
      const lecture = {
        id: crypto.randomUUID(),
        title,
        subject,
        pages,
        parts: buildParts(pages, perPart),
        lastPart: 0,
        createdAt: Date.now(),
      };
      await saveLecture(lecture);
      state.lectures = await getAllLectures();
      state.activeLectureId = lecture.id;
      state.activePartIndex = 0;
      state.studyTab = "parts";
      state.view = "study";
      setAlert("notice", `تم استخراج ${pages.length} صفحة وتقسيمها إلى ${lecture.parts.length} أجزاء.`);
    } catch (err) {
      setAlert("error", "تعذر قراءة الملف: " + (err.message || err));
    } finally {
      state.busy = false;
      state.uploadProgress = null;
      render();
    }
  } else if (e.target.id === "settingsForm") {
    state.settings.accessCode = document.getElementById("setAccessCode").value.trim();
    state.needAccessCode = false;
    saveSettings(state.settings);
    setAlert("notice", "تم حفظ الرمز.");
  } else if (e.target.id === "quickCodeForm") {
    state.settings.accessCode = document.getElementById("quickAccessCode").value.trim();
    state.needAccessCode = false;
    saveSettings(state.settings);
    setAlert("notice", "تم حفظ رمز الدخول، اضغط الآن (تجهيز بالـ AI).");
  }
});

/* ---------------- Boot ---------------- */
(async function init() {
  state.lectures = await getAllLectures();
  render();
})();
