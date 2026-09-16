/**
 * Tra cứu: giải nghĩa một TỪ, hoặc dịch + giảng một ĐOẠN, bằng Gemini.
 *
 * Vì sao gọi lúc chạy chứ không dựng sẵn lúc build: nghĩa của một từ phụ thuộc
 * CÂU chứa nó và BÀI đang học. Dựng sẵn thì phải đoán trước mọi cặp (từ, câu) —
 * đo trên site hiện tại là 148.724 cặp.
 *
 * Ngữ cảnh (`ctx`) do TRÌNH DUYỆT gửi lên chứ không phải Worker tự dựng: trang
 * đã tải sẵn `study/{course}.json` rồi, bắt Worker tải lại và parse file ~200KB
 * cho MỖI lượt tra là đốt vô ích cái trần 10ms CPU của gói free. Đổi lại phải
 * kẹp độ dài `ctx` — client nói gì cũng không được dài quá.
 *
 * Chính ngữ cảnh đó là lý do dùng Gemini thay vì một máy dịch thường. Đo trên
 * cùng một câu: máy dịch trả "đá nham thạch" cho `igneous rock`; Gemini kèm
 * glossary của bài trả "đá mácma". Sai kiểu đó trôi chảy và tự nhiên, không có
 * dấu hiệu nào để nhận ra.
 *
 * Hàng rào — GĐ 1 cố ý chỉ có ba lớp, KHÔNG cache và KHÔNG đối chiếu học liệu:
 *   1. `x-progress-key`, cùng mã bí mật với /api/progress. Đây là hàng rào
 *      CHÍNH. Chuỗi trẻ bôi đen là thứ trẻ KHÔNG hiểu trong bài, tức một hồ sơ
 *      điểm yếu — nên nó theo luật của /api/study/stats (chặn), chứ không theo
 *      luật của /api/tts (công khai + danh sách trắng).
 *   2. Trần lượt gọi MỖI NGÀY trong D1. Đây là thứ duy nhất chặn được hoá đơn
 *      nếu mã bí mật lọt ra ngoài. Không có nó thì mã bí mật là điểm hỏng duy
 *      nhất, mà hỏng theo kiểu không ai biết cho tới lúc nhận hoá đơn.
 *   3. Giới hạn độ dài từng trường.
 *
 * ⚠️ `thinkingBudget: 0` phải đặt TƯỜNG MINH, đừng dựa vào mặc định. Model này
 * khai `thinking: true`. Hôm nay mặc định là TẮT — đo được: `vào + ra == tổng`
 * khớp từng token và không có trường `thoughtsTokenCount`. Nhưng mặc định là
 * thứ Google đổi được mà không báo ai, và khi nó đổi thì tiền tăng 47–83% còn
 * câu trả lời trông Y HỆT. Không nhìn ra được, nên phải ĐO: mỗi lượt gọi tự
 * kiểm `vào + ra == tổng` và báo ra `meta.thoughts` khi lệch.
 *
 * Secret: npx wrangler secret put GEMINI_API_KEY
 * ⚠️ Nhớ BẬT BILLING trên dự án Google. Gói free dùng dữ liệu để huấn luyện, mà
 * đây đúng là thứ không nên đưa vào đó.
 */

const MODEL = "gemini-3.1-flash-lite";
const ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

/** Trần lượt gọi mỗi ngày. Vượt thì 429 — mềm, không phải lỗi. */
export const CAP = 300;

/** Kẹp độ dài từng trường. Đầu ra mới là chỗ tốn tiền, nhưng đầu vào trôi nổi
 *  thì cũng kéo đầu ra dài theo. */
const MAX = { word: 40, sent: 300, text: 600, ctx: 1200 };

const json = (d, s = 200) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const HE = "Bạn là gia sư cho học sinh Việt Nam đang học môn này bằng tiếng Anh.\n" +
  "Viết như đang nói với một đứa trẻ: câu ngắn, từ dễ, không dùng từ Hán-Việt khó.\n" +
  "Bám đúng thuật ngữ đã cho bên dưới, đừng tự đặt cách gọi khác.";

/** Hai chế độ khác nhau ở ĐẦU RA, nên tách hẳn schema chứ đừng nhồi vào một. */
const SHAPE = {
  word:
    'Trả về JSON thuần, không rào đầu, đúng các khoá sau:\n' +
    '{"tu":"từ gốc","loai":"danh từ|động từ|tính từ|trạng từ|cụm từ",' +
    '"ipa":"phiên âm IPA","nghia":"nghĩa tiếng Việt, ngắn gọn",' +
    '"giai_thich":"1-2 câu giải thích nghĩa NÀY trong bài đang học",' +
    '"vi_du":"1 câu tiếng Anh ngắn dùng từ này","vi_du_vi":"bản dịch câu ví dụ"}\n' +
    "Giải nghĩa theo đúng nghĩa từ đó mang TRONG CÂU đã cho, không liệt kê nghĩa khác.",
  text:
    'Trả về JSON thuần, không rào đầu, đúng các khoá sau:\n' +
    '{"dich":"bản dịch tiếng Việt sát nghĩa","giai_thich":"2-3 câu giảng lại ý chính cho dễ hiểu",' +
    '"tu_kho":[{"en":"từ khó","vi":"nghĩa"}]}\n' +
    "tu_kho: tối đa 4 từ khó nhất trong đoạn; không có từ nào khó thì để mảng rỗng.",
};

const cut = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");

/**
 * Tăng bộ đếm của NGÀY HÔM NAY và trả về số lượt sau khi tăng.
 *
 * Tăng TRƯỚC khi gọi Gemini, không phải sau. Gọi hỏng thì Google vẫn có thể đã
 * tính tiền, và quan trọng hơn: đếm-sau biến mọi lỗi thành một lượt gọi miễn
 * phí để thử lại, tức đúng cái vòng lặp mà trần sinh ra để chặn.
 *
 * `INSERT … VALUES … ON CONFLICT` nên KHÔNG cần `WHERE true` — cái bẫy đó chỉ
 * xảy ra với `INSERT … SELECT … ON CONFLICT`, khi SQLite không phân biệt được
 * `ON` của JOIN với `ON` của CONFLICT.
 */
async function tieuThu(env, day) {
  const r = await env.STUDY_DB.prepare(
    "INSERT INTO lookup_budget (day, n) VALUES (?1, 1) " +
    "ON CONFLICT(day) DO UPDATE SET n = n + 1 RETURNING n"
  ).bind(day).first();
  return Number(r?.n || 0);
}

export async function handleLookup(request, env) {
  if (request.method !== "POST") return json({ error: "Method không hỗ trợ" }, 405);

  const secret = env.LMS_SECRET || "";
  if (!secret) return json({ error: "Chưa cấu hình LMS_SECRET" }, 503);
  if ((request.headers.get("x-progress-key") || "") !== secret) {
    return json({ error: "Mã bí mật không đúng" }, 401);
  }
  const key = env.GEMINI_API_KEY || "";
  if (!key) return json({ error: "Chưa cấu hình GEMINI_API_KEY" }, 503);
  if (!env.STUDY_DB) return json({ error: "Chưa cấu hình STUDY_DB" }, 503);

  let b;
  try { b = await request.json(); } catch { return json({ error: "Body không hợp lệ" }, 400); }

  const mode = b?.mode === "text" ? "text" : "word";
  const text = cut(b?.text, mode === "word" ? MAX.word : MAX.text);
  const sent = cut(b?.sent, MAX.sent);
  const ctx = cut(b?.ctx, MAX.ctx);
  if (!text) return json({ error: "Thiếu 'text'" }, 400);

  // Trần ngày. Theo giờ UTC cho khỏi phải mang múi giờ vào Worker — mốc reset
  // rơi vào 7 giờ sáng Việt Nam, tức trước giờ học, nên không ai để ý.
  const day = new Date().toISOString().slice(0, 10);
  const n = await tieuThu(env, day);
  if (n > CAP) {
    return json({ error: "Hôm nay đã tra nhiều rồi, mai nhé", cap: CAP, used: n }, 429);
  }

  const he = [HE, ctx && "Ngữ cảnh:\n" + ctx, SHAPE[mode]].filter(Boolean).join("\n\n");
  const nguoi = mode === "word"
    ? `Từ cần giải nghĩa: "${text}"` + (sent ? `\nCâu chứa từ đó: "${sent}"` : "")
    : text;

  let g;
  try {
    g = await fetch(`${ENDPOINT}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: nguoi }] }],
        systemInstruction: { parts: [{ text: he }] },
        generationConfig: {
          temperature: 0.3,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
  } catch (e) {
    return json({ error: "Không gọi được Gemini: " + String(e.message || e) }, 502);
  }
  if (!g.ok) {
    // In CÂU LỖI THẬT, đừng nuốt thành một mã trống. Cùng bài học với lượt sync
    // 2026-09-12: wrangler in dòng khác đè lên, câu 401 bị che, và mất nửa ngày.
    const t = await g.text().catch(() => "");
    return json({ error: `Gemini lỗi ${g.status}`, chi_tiet: t.slice(0, 300) }, 502);
  }

  const d = await g.json();
  const parts = d?.candidates?.[0]?.content?.parts || [];
  const raw = parts.map((p) => p.text || "").join("").trim();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return json({ error: "Gemini trả về không phải JSON", chi_tiet: raw.slice(0, 300) }, 502);
  }

  const u = d.usageMetadata || {};
  const vao = u.promptTokenCount || 0;
  const ra = u.candidatesTokenCount || 0;
  const tong = u.totalTokenCount || 0;
  // Lệch nghĩa là có token không nằm trong vào/ra — tức chế độ nghĩ đã bật.
  const nghi = (u.thoughtsTokenCount || 0) || Math.max(0, tong - vao - ra);

  return json({ mode, data, meta: { vao, ra, thoughts: nghi, used: n, cap: CAP } });
}
