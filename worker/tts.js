/**
 * Đọc to bằng Google Cloud Text-to-Speech, sinh LÚC BẤM, cache ở edge.
 *
 * Trình duyệt không được cầm khoá Google nên Worker làm proxy. Mỗi câu chỉ tốn
 * Google đúng một lần: kết quả vào Cache API của Cloudflare (miễn phí, không
 * tính vào 1.000 lượt ghi KV/ngày), khoá theo sha1(giọng + text). Hạn mức Google
 * free: 1 triệu ký tự/tháng cho cả Neural2 lẫn Chirp 3: HD (khác nhau ở giá VƯỢT
 * hạn mức — 16$ so với 30$ mỗi triệu); cả cuốn sách chưa tới 40.000 ký tự.
 *
 * ⚠️ Tên giọng PHẢI nằm trong khoá cache. MP3 trả về kèm `immutable, max-age=1
 * năm`, nên đổi giọng mà giữ nguyên khoá thì mọi câu đã đọc vẫn phát giọng cũ
 * suốt một năm — đổi giọng trông như không có tác dụng, mà không hề báo lỗi.
 *
 * Endpoint công khai nên phải chặn lạm dụng: chỉ đọc chuỗi CÓ TRONG HỌC LIỆU
 * (đối chiếu với study/{course}.json qua ASSETS — chính file trang đang tải),
 * và tối đa 200 ký tự. Ai đó muốn đốt hạn mức thì chỉ đốt được đúng ~100 câu
 * mà cache đã giữ sẵn.
 *
 * Secret: GOOGLE_TTS_API_KEY (API key chỉ bật Cloud Text-to-Speech):
 *     npx wrangler secret put GOOGLE_TTS_API_KEY
 */

const ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize";
const AUDIO = { audioEncoding: "MP3", speakingRate: 0.92 };
const MAX_LEN = 200;

/** Giọng đang dùng. Chirp 3: HD — thế hệ mới hơn Neural2, cùng hạn mức free. */
const VOICE = "en-US-Chirp3-HD-Leda";
/**
 * Danh sách trắng để nghe SO SÁNH bằng `?voice=` trên máy thật trước khi chốt.
 * Đây là knob tạm; chốt xong thì bỏ tham số và giữ lại đúng một hằng số.
 * Phải là danh sách trắng chứ không phải chuỗi tự do: endpoint công khai, thả
 * cho gọi giọng nào cũng được là mở đường đốt hạn mức bằng giọng đắt tiền.
 */
const VOICES = new Set([
  "en-US-Chirp3-HD-Leda",      // trẻ trung
  "en-US-Chirp3-HD-Aoede",     // nhẹ, thoáng
  "en-US-Chirp3-HD-Kore",      // chắc, rõ
  "en-US-Chirp3-HD-Zephyr",    // sáng
  "en-US-Chirp3-HD-Autonoe",   // ấm
  "en-US-Neural2-F",           // giọng cũ, để đối chứng
]);

async function sha1(s) {
  const b = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Mọi chuỗi trang được phép đọc to. KHÔNG bao giờ có đáp án.
 *
 * Danh sách này phải phủ ĐÚNG mọi chỗ gọi `speak()` trong `templates/study.html`.
 * Thiếu một nguồn thì nút loa ở đó trả 403 rồi trang **lặng lẽ** lùi về giọng
 * của hệ điều hành — vẫn kêu, nên nhìn như đang chạy, nhưng là giọng khác hẳn
 * và không có lỗi nào hiện ra. Đã dính đúng lỗi này: `words[]` (từ vựng ESL,
 * 317 từ) và `sounds[]` bị bỏ sót, mà môn ESL để `glossary` rỗng theo SPEC nên
 * gần như MỌI nút loa của môn đó đều rơi về giọng dự phòng.
 * `test_tts_routes.mjs` chốt hai bên khớp nhau.
 */
export function speakable(doc) {
  const set = new Set();
  const add = (s) => { const t = (s == null ? "" : String(s)).trim(); if (t) set.add(t); };
  for (const s of doc.summary || []) {
    for (const g of s.glossary || []) add(g.term);                                 // g.term
    for (const ws of s.words || []) for (const it of ws.items || []) add(it.word);  // w.word
    for (const sd of s.sounds || []) for (const wd of sd.words || []) add(wd.en);   // wd.en
  }
  for (const c of doc.flashcards || []) add(c.front_en);   // learnCard.front_en · q.front_en
  for (const q of doc.quiz || []) add(q.stem_en);          // q.stem_en
  return set;
}

async function allowed(env, request, user, course) {
  const url = new URL(`/${user}/study/${course}.json`, request.url);
  const r = await env.ASSETS.fetch(new Request(url, request));
  if (!r.ok) return null;
  return speakable(await r.json());
}

export async function handleTts(request, env, url) {
  if (request.method !== "GET") return new Response("Method không hỗ trợ", { status: 405 });
  const key = env.GOOGLE_TTS_API_KEY || "";
  if (!key) return new Response("Chưa cấu hình GOOGLE_TTS_API_KEY", { status: 503 });

  const user = url.searchParams.get("user") || "";
  const course = url.searchParams.get("course") || "";
  const text = (url.searchParams.get("text") || "").trim();
  if (!/^[\w-]{1,32}$/.test(user) || !/^[\w-]{1,64}$/.test(course)) return new Response("Sai user/course", { status: 400 });
  if (!text || text.length > MAX_LEN) return new Response("Thiếu hoặc quá dài", { status: 400 });
  const voice = url.searchParams.get("voice") || VOICE;
  if (!VOICES.has(voice)) return new Response("Giọng không hỗ trợ", { status: 400 });

  // Cache TRƯỚC khi đối chiếu học liệu: câu đã có thì không parse JSON, không gọi Google.
  const cache = caches.default;
  const ckey = new Request(new URL(`/__tts/${await sha1(voice + "|" + user + "|" + course + "|" + text)}`, url).toString());
  const hit = await cache.match(ckey);
  if (hit) return hit;

  const ok = await allowed(env, request, user, course);
  if (!ok) return new Response("Không có học liệu", { status: 404 });
  if (!ok.has(text)) return new Response("Chuỗi không thuộc học liệu", { status: 403 });

  const g = await fetch(`${ENDPOINT}?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: "en-US", name: voice },
      audioConfig: AUDIO,
    }),
  });
  if (!g.ok) return new Response("Google TTS lỗi " + g.status, { status: 502 });
  const { audioContent } = await g.json();
  const bytes = Uint8Array.from(atob(audioContent), (c) => c.charCodeAt(0));
  const res = new Response(bytes, {
    headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=31536000, immutable" },
  });
  await cache.put(ckey, res.clone());
  return res;
}
