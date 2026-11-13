/**
 * Bản thu Luyện nói ESL (ôn thi cuối kỳ I) — spec docs/superpowers/specs/2026-11-13-thu-am-luyen-noi-design.md.
 *
 *   GET    /api/noi/{user}/{course}                   → { ban: { cau: [{ts, dai, size}] } }, mới nhất trước
 *   PUT    /api/noi/{user}/{course}/{cau}/{ts}-{dai}  → thân = audio; ≤ 5 bản / câu (bản 6 → 409), ≤ 5 MB (413)
 *   GET    /api/noi/{user}/{course}/{cau}/{ts}-{dai}  → audio, private, no-store
 *   DELETE /api/noi/{user}/{course}/{cau}/{ts}-{dai}  → xoá một bản (404 nếu không có)
 *
 * Mọi đường đòi `x-progress-key` = LMS_SECRET: giọng trẻ là dữ liệu riêng tư, site CÔNG KHAI.
 * Không có D1: mỗi bản là MỘT tệp R2 `noi/{user}/{course}/{cau}/{ts}-{dai}` — tên tệp mang đủ
 * thông tin, danh sách = list tiền tố. `cau` phải là `speaking[].id` có thật trong
 * /{user}/study/{course}.json (đọc qua ASSETS như worker/tts.js), nên không ghi được khoá tuỳ ý.
 * Không bao giờ tự xoá: đủ 5 bản thì từ chối, để con tự chọn bản bỏ.
 */
import { khoGhi, khoDoc, khoDau, khoLietCo, khoXoa } from "./kho.js";

export const NOI = { BAN_MAX: 5, DAI_MAX: 180000, DAI_DU: 5000, BYTE_MAX: 5 * 1024 * 1024 };
const USER_RE = /^[\w-]{1,32}$/;
const COURSE_RE = /^[a-z0-9-]{1,48}$/;
const CAU_RE = /^[a-z0-9-]{3,40}$/;
// Dạng CHUẨN, không số 0 đứng đầu (hai chuỗi khác nhau cho cùng một bản = hai khoá R2).
const BAN_RE = /^([1-9]\d{12})-([1-9]\d{0,5})$/;
const LOAI_RE = /^audio\/(mp4|webm|ogg)$/;   // đúng LOAI_RE của worker/tapdoc.js

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function sai(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

async function cauCo(env, url, user, course) {
  const r = await env.ASSETS.fetch(new Request(new URL(`/${user}/study/${course}.json`, url)));
  if (!r.ok) return null;
  let doc;
  try { doc = await r.json(); } catch { return null; }
  const ids = new Set();
  for (const s of doc.summary || []) for (const sp of s.speaking || []) if (sp.id) ids.add(sp.id);
  return ids.size ? ids : null;
}

const tachBan = (ten) => {
  const m = BAN_RE.exec(ten || "");
  return m ? { ts: Number(m[1]), dai: Number(m[2]) } : null;
};

async function liet(env, user, course) {
  const tienTo = `noi/${user}/${course}/`;
  const ban = {};
  for (const o of await khoLietCo(env, tienTo)) {
    const [cau, ten] = o.khoa.slice(tienTo.length).split("/");
    const b = tachBan(ten);
    if (b) (ban[cau] ??= []).push({ ...b, size: o.size });
  }
  for (const k in ban) ban[k].sort((a, b) => b.ts - a.ts);
  return { ban };
}

async function ghi(request, env, user, course, cau, ten, b) {
  const loai = (request.headers.get("content-type") || "").split(";")[0].trim();
  if (!LOAI_RE.test(loai)) throw sai("Loại file không hỗ trợ");
  if (b.ts > Date.now() + 86400000) throw sai("Sai 'ts' (đồng hồ máy lệch quá 1 ngày)");
  if (b.dai > NOI.DAI_MAX + NOI.DAI_DU) throw sai("Bản thu dài quá 3 phút");
  if (Number(request.headers.get("content-length") || 0) > NOI.BYTE_MAX) throw sai("Bản thu quá lớn", 413);
  const than = await request.arrayBuffer();
  if (than.byteLength > NOI.BYTE_MAX) throw sai("Bản thu quá lớn", 413);
  if (!than.byteLength) throw sai("Bản thu rỗng");
  const khoa = `noi/${user}/${course}/${cau}/${ten}`;
  // Gửi lại ĐÚNG khoá (lần trước mất phản hồi) là ghi đè, không tính là bản mới.
  if (!(await khoDau(env, khoa))) {
    const co = await khoLietCo(env, `noi/${user}/${course}/${cau}/`);
    if (co.length >= NOI.BAN_MAX) throw sai(`Đã đủ ${NOI.BAN_MAX} bản — xoá bớt một bản rồi thu tiếp`, 409);
  }
  await khoGhi(env, khoa, than, loai);
  return { ok: true, ...b, size: than.byteLength };
}

export async function handleNoi(request, env, url) {
  const secret = env.LMS_SECRET || "";
  if (!secret) return json({ error: "Chưa cấu hình LMS_SECRET" }, 503);
  if ((request.headers.get("x-progress-key") || "") !== secret) return json({ error: "Mã bí mật không đúng" }, 401);
  if (!env.KHO) return json({ error: "Chưa cấu hình KHO (R2)" }, 503);
  const p = url.pathname.slice("/api/noi/".length).split("/").map((x) => {
    try { return decodeURIComponent(x); } catch { return "\u0000"; }
  });
  const m = request.method;
  try {
    if (p.length !== 2 && p.length !== 4) return json({ error: "Không có đường dẫn này" }, 404);
    const [user, course, cau, ten] = p;
    if (!USER_RE.test(user)) throw sai("Sai 'user'");
    if (!COURSE_RE.test(course)) throw sai("Sai 'course'");
    const ids = await cauCo(env, url, user, course);
    if (!ids) throw sai("Môn này không có Luyện nói", 404);
    if (p.length === 2) {
      if (m !== "GET") return json({ error: "Method không hỗ trợ" }, 405);
      return json(await liet(env, user, course));
    }
    if (!CAU_RE.test(cau)) throw sai("Sai 'cau'");
    if (!ids.has(cau)) throw sai("Không có câu hỏi này", 404);
    const b = tachBan(ten);
    if (!b) throw sai("Tên bản thu không hợp lệ");
    const khoa = `noi/${user}/${course}/${cau}/${ten}`;
    if (m === "PUT") return json(await ghi(request, env, user, course, cau, ten, b));
    if (m === "GET") {
      const o = await khoDoc(env, khoa);
      if (!o) return json({ error: "Không có bản thu này" }, 404);
      return new Response(o.body, {
        headers: { "content-type": o.httpMetadata?.contentType || "application/octet-stream", "cache-control": "private, no-store" },
      });
    }
    if (m === "DELETE") {
      if (!(await khoDau(env, khoa))) return json({ error: "Không có bản thu này" }, 404);
      await khoXoa(env, [khoa]);
      return json({ ok: true });
    }
    return json({ error: "Method không hỗ trợ" }, 405);
  } catch (e) {
    if (e.status && e.status < 500) return json({ error: e.message }, e.status);
    console.error("noi:", e);   // chi tiết (khoá R2) chỉ vào log
    return json({ error: "Lỗi máy chủ" }, 500);
  }
}
