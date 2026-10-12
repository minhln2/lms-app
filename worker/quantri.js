/**
 * Route quản trị của bố mẹ — gỡ đánh dấu (ADR 0063, spec 2026-10-09 go-danh-dau). MỌI đường dẫn ở đây đòi header
 * `x-quantri` (phiên bố mẹ 24 giờ, `kiemQuantri` của worker/diem.js), kiểm ngay sau khi khớp đường dẫn + method và TRƯỚC
 * body, TRƯỚC mọi tra cứu — người không có phiên không biết được học sinh / truyện nào có thật. `/api/quantri/phien` (mở phiên) KHÔNG ở đây: worker/diem.js.
 *
 *   POST /api/quantri/truyen/go {user, truyen} → gỡ CẢ truyện: trừ mọi sao của truyện, xoá td_truyen / td_quiz / td_thuam,
 *                                                ghi mốc td_go, xoá bản thu R2 → {ok, tru, du, r2_loi?}
 *   POST /api/quantri/on/go {user, mon, ngay}    → gỡ các lượt ôn của (học sinh, môn, ngày VN): trừ sao ôn của ngày đó, XOÁ
 *                                                attempt (ngoại lệ có chủ đích của "attempt chỉ thêm", migration 0001),
 *                                                dựng lại card bằng phatLai (worker/lich_on.js), giữ `known`
 *                                                → {ok, tru, du, the, luot}
 *   GET  /api/quantri/thuoc?user=                → [{mon, i, c}] các thẻ `known = 1` (gỡ = POST /api/study known v 0)
 *
 * Gỡ điểm và xoá hàng nguồn đi trong MỘT db.batch (một giao dịch D1), câu gỡ điểm đứng ĐẦU: hỏng giữa chừng là không gì bị
 * ghi; gọi lại an toàn (dòng `huy:` có khoá UNIQUE — gỡ không hai lần; xoá hàng không có là vô hại).
 */
import { kiemQuantri, cauHuy, ngayVN, soDu } from "./diem.js";
import { phatLai } from "./lich_on.js";
import { kiemUser, kiemTruyen } from "./tapdoc.js";
import { khoLietCo, khoXoa } from "./kho.js";

const giay = () => Math.floor(Date.now() / 1000);
const VN = 7 * 3600;
const USER_RE = /^[\w-]{1,32}$/;
const MON_RE = /^[\w-]{1,64}$/;     // slug môn — cùng luật /api/study
const NGAY_RE = /^\d{4}-\d{2}-\d{2}$/;
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

async function docBody(request) {
  let b;
  try { b = await request.json(); } catch { throw sai("Body không hợp lệ"); }
  if (!b || typeof b !== "object" || Array.isArray(b)) throw sai("Body không hợp lệ");
  return b;
}

/** Gỡ cả truyện `t` (hàng của tap-doc/index.json, kiemTruyen đã đọc) của `user`. */
export async function goTruyen(env, user, t) {
  const db = env.STUDY_DB;
  const now = giay();
  const kq = await db.batch([
    cauHuy(db, user, [`td:doc:${t.id}`, `td:thuam:${t.id}`, `td:quiz:${t.id}:`], now),
    db.prepare(`DELETE FROM td_truyen WHERE user_id = ?1 AND truyen = ?2`).bind(user, t.id),
    db.prepare(`DELETE FROM td_quiz WHERE user_id = ?1 AND truyen = ?2`).bind(user, t.id),
    db.prepare(`DELETE FROM td_thuam WHERE user_id = ?1 AND truyen = ?2`).bind(user, t.id),
    db.prepare(
      `INSERT INTO td_go (user_id, truyen, ts) VALUES (?1, ?2, ?3)
       ON CONFLICT (user_id, truyen) DO UPDATE SET ts = excluded.ts`
    ).bind(user, t.id, now),
    db.prepare(`SELECT COALESCE(SUM(diem), 0) AS du FROM diem WHERE user_id = ?1`).bind(user),
  ]);
  const tru = -(kq[0].results || []).reduce((s, x) => s + x.diem, 0);
  // Bản thu SAU D1: td_thuam đã không còn nên đoạn mồ côi (R2 lỗi) không ai đọc; route vẫn 200, báo r2_loi.
  let r2Loi = false;
  try {
    if (!env.KHO) throw new Error("Chưa cấu hình KHO (R2)");
    await khoXoa(env, (await khoLietCo(env, `thu-am/${user}/${t.id}/`)).map((o) => o.khoa));
  } catch (e) {
    console.error("quantri:r2", e);
    r2Loi = true;
  }
  return { ok: true, tru, du: kq[kq.length - 1].results[0].du, ...(r2Loi ? { r2_loi: true } : {}) };
}

async function routeGoTruyen(request, env, url) {
  const b = await docBody(request);
  const cm = await kiemUser(env, url, b.user);
  return goTruyen(env, b.user, kiemTruyen(cm, b.truyen));
}

/** "YYYY-MM-DD" (ngày lịch VN) → epoch giây lúc 00:00 giờ VN; sai dạng / ngày không có (2026-02-30) → null. */
export function dauNgayVN(ngay) {
  if (typeof ngay !== "string" || !NGAY_RE.test(ngay)) return null;
  const s = Date.parse(ngay + "T00:00:00Z") / 1000 - VN;
  return Number.isFinite(s) && ngayVN(s) === ngay ? s : null;
}

/**
 * Gỡ các lượt ôn của `user`, môn `mon`, ngày VN `ngay` (khoảng [00:00 VN, +24 h)). Hai lượt gọi D1:
 *   1. ĐỌC (một batch): thẻ có lượt trong khoảng (`I`), các lượt CÒN LẠI của chúng (ngoài khoảng, theo ts rồi id), `known`;
 *   2. GHI (một batch, gỡ điểm đứng đầu): gỡ khoá `on:<i>:<ngay>:*` đang hiệu lực, xoá attempt trong khoảng CỦA thẻ trong `I`, ghi card phát
 *      lại (giữ `known`), xoá card hết lượt mà known = 0, đọc số dư.
 * Bé ôn đúng lúc bố mẹ gỡ: lượt chen giữa hai lần gọi của thẻ TRONG `I` bị xoá cùng (card dựng lại không có nó, đồng bộ);
 * của thẻ NGOÀI `I` thì KHÔNG bị xoá (DELETE giới hạn theo `I`) — card / sao / lượt cùng còn. Card của thẻ trong `I` có thể
 * lệch một lượt, tự đúng lại ở lượt ôn kế tiếp (spec §5.1, chấp nhận). Ngày không có lượt nào → {the: 0}, không ghi gì.
 */
export async function goNgayOn(env, user, mon, ngay) {
  const tu = dauNgayVN(ngay), den = tu + 86400;
  const db = env.STUDY_DB;
  const TRONG = "user_id = ?1 AND course = ?2 AND ts >= ?3 AND ts < ?4";
  const [a, b, c] = await db.batch([
    db.prepare(`SELECT DISTINCT item_id FROM attempt WHERE ${TRONG}`).bind(user, mon, tu, den),
    db.prepare(
      `SELECT item_id, correct, grade, ts FROM attempt
        WHERE user_id = ?1 AND item_id IN (SELECT item_id FROM attempt WHERE ${TRONG})
          AND NOT (course = ?2 AND ts >= ?3 AND ts < ?4)
        ORDER BY ts, id`
    ).bind(user, mon, tu, den),
    db.prepare(
      `SELECT item_id, known FROM card WHERE user_id = ?1 AND item_id IN (SELECT item_id FROM attempt WHERE ${TRONG})`
    ).bind(user, mon, tu, den),
  ]);
  const I = (a.results || []).map((r) => r.item_id);
  if (!I.length) return { ok: true, tru: 0, du: await soDu(env, user), the: 0, luot: 0 };
  const con = {};
  for (const r of b.results || []) (con[r.item_id] ??= []).push({ g: r.grade, ok: r.correct, ts: r.ts });
  const thuoc = new Set((c.results || []).filter((r) => r.known).map((r) => r.item_id));
  const ghi = [], xoa = [];
  for (const i of I) {
    if (!con[i] && !thuoc.has(i)) { xoa.push(i); continue; }
    const k = phatLai(i, con[i] || []);
    ghi.push({ i, n: k.n, w: k.wrong, s: k.streak, b: k.box, e: k.ease, d: k.due, t: k.last_ts });
  }
  const kq = await db.batch([
    cauHuy(db, user, I.map((i) => `on:${i}:${ngay}:`)),
    // Chỉ xoá lượt của thẻ trong `I` (tập đã đọc): lượt của thẻ KHÁC chen giữa lần đọc và lần ghi không có card dựng lại nên
    // xoá nó là mất lượt mà card / sao vẫn còn; để lại thì lần gỡ sau (hoặc phát lại) mới gom được.
    db.prepare(`DELETE FROM attempt WHERE ${TRONG} AND item_id IN (SELECT value FROM json_each(?5)) RETURNING id`)
      .bind(user, mon, tu, den, JSON.stringify(I)),
    db.prepare(
      `UPDATE card SET n = json_extract(e.value, '$.n'), wrong = json_extract(e.value, '$.w'),
              streak = json_extract(e.value, '$.s'), box = json_extract(e.value, '$.b'), ease = json_extract(e.value, '$.e'),
              due = json_extract(e.value, '$.d'), last_ts = json_extract(e.value, '$.t')
         FROM json_each(?2) AS e
        WHERE card.user_id = ?1 AND card.item_id = json_extract(e.value, '$.i')`
    ).bind(user, JSON.stringify(ghi)),
    db.prepare(`DELETE FROM card WHERE user_id = ?1 AND known = 0 AND item_id IN (SELECT value FROM json_each(?2))`)
      .bind(user, JSON.stringify(xoa)),
    db.prepare(`SELECT COALESCE(SUM(diem), 0) AS du FROM diem WHERE user_id = ?1`).bind(user),
  ]);
  return { ok: true, tru: -(kq[0].results || []).reduce((s, x) => s + x.diem, 0), du: kq[4].results[0].du,
           the: I.length, luot: (kq[1].results || []).length };
}

async function routeGoOn(request, env) {
  const b = await docBody(request);
  if (typeof b.user !== "string" || !USER_RE.test(b.user)) throw sai("Thiếu hoặc sai 'user'");
  if (typeof b.mon !== "string" || !MON_RE.test(b.mon)) throw sai("Thiếu hoặc sai 'mon'");
  if (dauNgayVN(b.ngay) === null) throw sai("Thiếu hoặc sai 'ngay' (YYYY-MM-DD, ngày giờ Việt Nam)");
  return goNgayOn(env, b.user, b.mon, b.ngay);
}

/** Thẻ đã thuộc của một học sinh, mọi môn → [{mon, i, c}] (c = concept_id: POST /api/study known cần nó để gỡ). */
async function routeThuoc(request, env, url) {
  const user = url.searchParams.get("user") || "";
  if (!USER_RE.test(user)) throw sai("Thiếu hoặc sai 'user'");
  const r = await env.STUDY_DB.prepare(
    `SELECT course, item_id, concept_id FROM card WHERE user_id = ?1 AND known = 1 ORDER BY course, item_id`
  ).bind(user).all();
  return (r.results || []).map((x) => ({ mon: x.course, i: x.item_id, c: x.concept_id }));
}

const TUYEN = {
  "/api/quantri/truyen/go": { m: "POST", fn: routeGoTruyen },
  "/api/quantri/on/go": { m: "POST", fn: routeGoOn },
  "/api/quantri/thuoc": { m: "GET", fn: routeThuoc },
};

/** Định tuyến /api/quantri/* (trừ /api/quantri/phien). Lỗi máy chủ: chi tiết chỉ vào log. */
export async function handleQuantri(request, env, url) {
  const tuyen = TUYEN[url.pathname];
  if (!tuyen) return json({ error: "Không có đường dẫn này" }, 404);
  if (request.method !== tuyen.m) return json({ error: "Method không hỗ trợ" }, 405);
  const q = await kiemQuantri(request, env);
  if (!q.ok) return json({ error: q.loi }, q.status);
  if (!env.STUDY_DB) return json({ error: "Chưa cấu hình STUDY_DB" }, 503);
  try {
    return json(await tuyen.fn(request, env, url));
  } catch (e) {
    if (e.status && e.status < 500) return json({ error: e.message }, e.status);
    console.error("quantri:", e);
    return json({ error: "Lỗi máy chủ" }, 500);
  }
}
