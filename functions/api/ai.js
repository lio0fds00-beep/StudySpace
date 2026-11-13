export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    if (env.ACCESS_CODE) {
      const code = (request.headers.get("x-access-code") || "").trim();
      if (code !== env.ACCESS_CODE.trim()) {
        return json({ error: "رمز الدخول غير صحيح أو غير مدخل. أدخل رمز المادة من الإعدادات." }, 401);
      }
    }

    const body = await request.json();
    const prompt = String(body?.prompt || "").trim();
    if (!prompt) return json({ error: "النص فارغ." }, 400);
    if (prompt.length > 35000) return json({ error: "حجم الجزء كبير جداً." }, 400);

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return json({ error: "مفتاح السيرفر GEMINI_API_KEY غير مضاف في إعدادات Cloudflare." }, 500);
    }

    const model = env.GEMINI_MODEL || "gemini-3.8-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          responseMimeType: "application/json",
        },
      }),
    });

    const data = await res.json();
    if (res.status === 429) {
      return json({ error: "ضغط مؤقت على الذكاء الاصطناعي، انتظر 10 ثواني وحاول مرة أخرى." }, 429);
    }
    if (!res.ok) {
      return json({ error: data?.error?.message || `Gemini HTTP ${res.status}` }, res.status);
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return json({ error: "لم يرجع الذكاء الاصطناعي نتيجة." }, 502);

    const cleaned = text
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim();

    return json(JSON.parse(cleaned), 200);
  } catch (err) {
    return json({ error: err?.message || "حدث خطأ في السيرفر." }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
