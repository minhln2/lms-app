/**
 * /api/stt-token — cấp MÃ TẠM cho 🎤 của popup tra cứu (Gemini 3.5 Transcribe Live).
 *
 * Trình duyệt mở WebSocket THẲNG tới Google bằng mã tạm; Worker không đứng giữa luồng
 * âm thanh (đỡ thời gian chạy Worker, đỡ một chặng trễ). Khoá Gemini không bao giờ rời
 * Worker: mã tạm dùng MỘT lần (`uses: 1`), phải mở phiên trong 60 s, sống 2 phút, và
 * ĐÃ KHOÁ cấu hình phiên (`bidiGenerateContentSetup`) — trình duyệt không đổi được model
 * hay bật chế độ khác bằng mã này.
 *
 * ⚠ Tên trường REST là `bidiGenerateContentSetup`. Tài liệu (và SDK) viết
 * `liveConnectConstraints` — gửi tên đó lên REST thì 400 "Unknown name". Đường WS của mã
 * tạm là `…BidiGenerateContentConstrained?access_token=…` (đo 2026-10-13).
 *
 * Mỗi mã = MỘT lượt trong trần ngày chung với /api/lookup (`tieuThu`). Một lượt nói tốn
 * ~16 đ (âm thanh vào $3,50/1M token, 25 token/s; chữ ra $21/1M) — cùng cỡ một lượt tra,
 * nên đếm chung là đủ, không cần trần riêng. Trình duyệt tự cắt mỗi lượt ở 20 s.
 *
 * Từ vựng gợi ý (`customVocabulary`) do trình duyệt gửi: thuật ngữ của bài đang mở. Đo
 * được: không gợi ý thì "ought" ra "Odd"/"Art"; có thì đúng 7/7 câu thử.
 */
import { tieuThu, CAP } from "./lookup.js";

const MODEL = "models/gemini-3.5-transcribe-live";
const TOKENS = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";
export const WS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
/** Tài liệu: tốt nhất ≤ 100 từ. Mỗi từ ≤ 60 ký tự — thuật ngữ, không phải câu. */
export const TU_VUNG = { so: 100, dai: 60 };

const json = (d, s = 200) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** Lọc danh sách từ vựng: chuỗi, cắt khoảng trắng, bỏ trùng (không phân biệt hoa thường), kẹp số lượng. */
export function locTuVung(ds) {
  const out = [], gap = new Set();
  for (const x of Array.isArray(ds) ? ds : []) {
    const t = typeof x === "string" ? x.replace(/\s+/g, " ").trim() : "";
    if (!t || t.length > TU_VUNG.dai || gap.has(t.toLowerCase())) continue;
    gap.add(t.toLowerCase());
    out.push(t);
    if (out.length >= TU_VUNG.so) break;
  }
  return out;
}

export async function handleSttToken(request, env) {
  if (request.method !== "POST") return json({ error: "Method không hỗ trợ" }, 405);
  const secret = env.LMS_SECRET || "";
  if (!secret) return json({ error: "Chưa cấu hình LMS_SECRET" }, 503);
  if ((request.headers.get("x-progress-key") || "") !== secret) {
    return json({ error: "Mã bí mật không đúng" }, 401);
  }
  const key = env.GEMINI_API_KEY || "";
  if (!key) return json({ error: "Chưa cấu hình GEMINI_API_KEY" }, 503);
  if (!env.STUDY_DB) return json({ error: "Chưa cấu hình STUDY_DB" }, 503);

  const b = await request.json().catch(() => ({}));
  const tu = locTuVung(b?.tu_vung);

  // Đếm TRƯỚC khi gọi Google — cùng lý do với /api/lookup (lỗi không thành lượt miễn phí).
  const n = await tieuThu(env, new Date().toISOString().slice(0, 10));
  if (n > CAP) return json({ error: "Hôm nay đã hỏi nhiều rồi, mai nhé", cap: CAP, used: n }, 429);

  // Trình duyệt gửi lại ĐÚNG khối này làm tin `setup` — khớp ràng buộc của mã.
  const setup = {
    model: MODEL,
    generationConfig: { responseModalities: ["TEXT"] },
    inputAudioTranscription: {
      // Học sinh hỏi bằng tiếng Việt chen từ tiếng Anh. Để trống (tự nhận) thì đo kém hơn.
      languageCodes: ["vi-VN", "en-US"],
      ...(tu.length ? { customVocabulary: tu } : {}),
    },
  };
  const bay = Date.now();
  let r;
  try {
    r = await fetch(TOKENS, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(bay + 2 * 60e3).toISOString(),
        newSessionExpireTime: new Date(bay + 60e3).toISOString(),
        bidiGenerateContentSetup: setup,
      }),
    });
  } catch (e) {
    return json({ error: "Không gọi được Google", chi_tiet: String(e.message || e) }, 502);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.name) {
    return json({ error: "Không cấp được mã ghi âm", ma: r.status, chi_tiet: JSON.stringify(j).slice(0, 300) }, 502);
  }
  return json({ token: j.name, ws: WS, setup });
}
