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
 *   Khu quản trị bố mẹ (ADR 0069, spec 2026-10-15 quan-tri-bo-me):
 *   GET  /api/quantri/diem?user=[&gon=1]          → {du, lich_su} (500 dòng, loai/mon/huy; đối chiếu tick như /api/diem)
 *   GET  /api/quantri/diem/bieu-do?user=&muc=     → {muc, cot} — điểm CỘNG theo ngày (7) / tuần (8, Thứ Hai) / tháng (6), giờ VN
 *   POST /api/quantri/diem/huy {user, khoa}       → gỡ ĐÚNG một dòng (chỉ dòng `huyDuoc`) → {ok, tru, du}
 *   POST /api/quantri/diem/cong {user, diem, ghi_chu} → bố mẹ tự cộng, khoá them:<ms>:<8 hex> → {ok, cong, du}
 *   POST /api/quantri/tick/go {user, key}         → "về chưa học": xoá khoá KV rồi đối chiếu (gỡ tick: + nhom:) → {ok, tru, du}
 *   POST /api/quantri/thuoc/go {user, mon, i, c}  → bỏ cờ "đã thuộc" (writeKnown v 0, không dính ⭐) → {ok}
 *   GET  /api/quantri/hoc-tap?user=&phan=         → dong (≤ 30 ngày, ≤ 500 dòng) · tapdoc · on (thẻ) · tu (từ đã tra)
 *
 * Gỡ điểm và xoá hàng nguồn đi trong MỘT db.batch (một giao dịch D1), câu gỡ điểm đứng ĐẦU: hỏng giữa chừng là không gì bị
 * ghi; gọi lại an toàn (dòng `huy:` có khoá UNIQUE — gỡ không hai lần; xoá hàng không có là vô hại).
 */
import { kiemQuantri, cauHuy, ngayVN, soDu, an, docManifest, doiChieuKV, doiChieuTick, lichSu, huyDuoc, phanLoai, khoaThem,
         dangHieuLuc, huyDiem, kyBieuDo, cotBieuDo, BIEU_DO, LICH_SU_QT, GHI_CHU_MAX, TRU_MAX, KHOA_TIEN_DO } from "./diem.js";
import { phatLai } from "./lich_on.js";
import { writeKnown } from "./study.js";
import { kiemUser, kiemTruyen } from "./tapdoc.js";
import { khoLietCo, khoXoa } from "./kho.js";

const giay = () => Math.floor(Date.now() / 1000);
const VN = 7 * 3600;
const USER_RE = /^[\w-]{1,32}$/;
const MON_RE = /^[\w-]{1,64}$/;     // slug môn — cùng luật /api/study
const NGAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[\w-]+\/\d+\/[\w-]+$/;   // khoá tiến độ — cùng luật worker/index.js
const ID_RE = /^[\w.-]{1,64}$/;           // id thẻ / khái niệm — cùng luật worker/study.js
export const DONG_MAX = 500, DONG_NGAY = 30, ON_MAX = 2000, TU_MAX = 500;
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

const SUM = `SELECT COALESCE(SUM(diem), 0) AS du FROM diem WHERE user_id = ?1`;
const kiemU = (u) => { if (typeof u !== "string" || !USER_RE.test(u)) throw sai("Thiếu hoặc sai 'user'"); return u; };

/** Số dư + 500 dòng lịch sử; như /api/diem, mở trang là một lượt ĐỐI CHIẾU tick. `gon=1` → chỉ số dư (trang Tổng quan). */
async function routeDiem(request, env, url) {
  const user = kiemU(url.searchParams.get("user"));
  await an("tick", () => doiChieuKV(env, url, user), { cong: 0, nhom: [], tru: 0 });
  const du = await soDu(env, user);
  if (url.searchParams.get("gon")) return { du };
  const mf = await an("mf", () => docManifest(env, url, user), null);
  return { du, lich_su: await lichSu(env, user, LICH_SU_QT, mf) };
}

/** Điểm CỘNG theo kỳ: MỘT câu gộp theo ngày VN (25200 = UTC+7) từ đầu kỳ cũ nhất, gộp tiếp ở cotBieuDo. */
async function routeBieuDo(request, env, url) {
  const user = kiemU(url.searchParams.get("user"));
  const muc = url.searchParams.get("muc") || "";
  if (!Object.hasOwn(BIEU_DO, muc)) throw sai("Thiếu hoặc sai 'muc' (ngay | tuan | thang)");
  const ky = kyBieuDo(muc, giay());
  const r = await env.STUDY_DB.prepare(
    `SELECT date(ts + 25200, 'unixepoch') AS ngay, SUM(diem) AS tong FROM diem
      WHERE user_id = ?1 AND diem > 0 AND ts >= ?2 GROUP BY ngay ORDER BY ngay`
  ).bind(user, ky[0].tu_ts).all();
  return { muc, cot: cotBieuDo(ky, r.results || []) };
}

/**
 * Gỡ ĐÚNG một dòng `khoa` (khoá thật, kể cả lượt `#n`): chỉ dòng huyDuoc (tập đọc, tự cộng). Đọc trước để báo lỗi rõ (không có
 * / không có điểm / đã gỡ); ghi bằng cauHuy — hai lượt gỡ cùng lúc thì `huy:` có khoá UNIQUE, chỉ trừ một lần. Ghi sổ ở đây
 * LÀ thao tác chính: lỗi D1 → 500 (không nuốt thành tru 0).
 */
async function routeHuy(request, env) {
  const b = await docBody(request);
  const user = kiemU(b.user);
  const khoa = typeof b.khoa === "string" ? b.khoa : "";
  if (!huyDuoc(khoa)) throw sai("Dòng này không gỡ riêng được");
  const db = env.STUDY_DB;
  const [dong, go] = await db.batch([
    db.prepare(`SELECT diem FROM diem WHERE user_id = ?1 AND khoa = ?2`).bind(user, khoa),
    db.prepare(`SELECT 1 AS co FROM diem WHERE user_id = ?1 AND khoa = ?2`).bind(user, "huy:" + khoa),
  ]);
  const d = (dong.results || [])[0];
  if (!d) throw sai("Không có dòng này");
  if (!(d.diem > 0)) throw sai("Dòng này không có điểm để gỡ");
  if ((go.results || []).length) throw sai("Dòng này đã gỡ");
  const kq = await db.batch([cauHuy(db, user, [khoa], giay()), db.prepare(SUM).bind(user)]);
  return { ok: true, tru: -(kq[0].results || []).reduce((s, x) => s + x.diem, 0), du: kq[1].results[0].du };
}

/** Bố mẹ tự cộng: MỘT dòng them:<ms>:<8 hex>, nhãn = ghi chú. Đối xứng với trừ (truDiem): 1 … TRU_MAX, ghi chú bắt buộc. */
async function routeCong(request, env) {
  const b = await docBody(request);
  const user = kiemU(b.user);
  const diem = b.diem;
  const ghiChu = typeof b.ghi_chu === "string" ? b.ghi_chu.trim() : "";
  if (!Number.isInteger(diem) || diem < 1 || diem > TRU_MAX) throw sai("'diem' phải là số nguyên dương");
  if (!ghiChu || ghiChu.length > GHI_CHU_MAX) throw sai(`Cần ghi chú (tối đa ${GHI_CHU_MAX} ký tự)`);
  const db = env.STUDY_DB;
  const [ghi, du] = await db.batch([
    db.prepare(`INSERT INTO diem (user_id, khoa, diem, nhan, ts) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING diem`)
      .bind(user, khoaThem(), diem, ghiChu, giay()),
    db.prepare(SUM).bind(user),
  ]);
  return { ok: true, cong: ghi.results[0].diem, du: du.results[0].du };
}

/**
 * "Về chưa học" một mục trang môn (spec §4.4): xoá khoá KV `key` rồi đối chiếu với boTick = [key] → gỡ tick: + mọi nhom: chứa
 * mục (chonGo). Gỡ điểm suông thì khoá KV còn và lượt đối chiếu kế tiếp cộng lại — nên phải bỏ tick. KV + D1 không chung một
 * giao dịch: KV ghi trước; gỡ điểm hỏng (an → tru 0) thì dòng còn nút, bấm lại: khoá đã mất, chonGo vẫn gỡ. Chỉ GHI KV khi khoá
 * có thật — KV đọc ra rỗng / hỏng thì không ghi đè (cùng lý do POST /api/progress không gỡ theo KV rỗng).
 */
async function routeTickGo(request, env, url) {
  const b = await docBody(request);
  const user = kiemU(b.user);
  const key = typeof b.key === "string" ? b.key : "";
  if (!KEY_RE.test(key) || !key.startsWith(user + "/")) throw sai("Thiếu hoặc sai 'key'");
  if (!env.PROGRESS_KV) throw sai("Chưa cấu hình PROGRESS_KV", 503);
  const items = (await env.PROGRESS_KV.get(KHOA_TIEN_DO, { type: "json" })) || {};
  if (Object.hasOwn(items, key)) {
    delete items[key];
    await env.PROGRESS_KV.put(KHOA_TIEN_DO, JSON.stringify(items));
  }
  const r = await an("tick", () => doiChieuTick(env, url, user, items, [key]), { cong: 0, nhom: [], tru: 0 });
  const g = await an("huy", () => goTickThang(env, user, key), 0);
  return { ok: true, tru: (r.tru || 0) + g, du: await soDu(env, user) };
}

/**
 * Lưới sau chonGo: dòng `tick:<cid>/<iid>` mà chonGo KHÔNG thấy (mục đã bị prune khỏi manifest, môn mất cờ `diem` hay chưa có
 * cổng moc:tick:) vẫn có nút "Về chưa học" trên lịch sử — nguồn còn lượt HIỆU LỰC thì gỡ thẳng (cauHuy). Gỡ vĩnh viễn: chonTick
 * không bao giờ cộng lại mục ngoài manifest có cổng. chonGo đã gỡ rồi thì `huy:` có trong sổ → dangHieuLuc null → không gỡ hai
 * lần, tru không cộng dồn. Quét khoảng [S, S + '$') của nguồn và của `huy:` nguồn (không LIKE). → số ⭐ vừa trừ (≥ 0).
 */
async function goTickThang(env, user, key) {
  const [, cid, iid] = key.split("/");
  const t = `tick:${cid}/${iid}`;
  const co = await env.STUDY_DB.prepare(
    `SELECT khoa FROM diem WHERE user_id = ?1 AND ((khoa >= ?2 AND khoa < ?3) OR (khoa >= ?4 AND khoa < ?5))`
  ).bind(user, t, t + "$", "huy:" + t, "huy:" + t + "$").all();
  if (!dangHieuLuc(new Set((co.results || []).map((x) => x.khoa)), t)) return 0;
  return (await huyDiem(env, user, [t])).tru || 0;
}

/** Bỏ cờ "đã thuộc" của một thẻ — chỉ GỌI writeKnown (không thêm SQL vào study.js: test_study_sql chốt 6 câu). */
async function routeThuocGo(request, env) {
  const b = await docBody(request);
  const user = kiemU(b.user);
  if (typeof b.mon !== "string" || !MON_RE.test(b.mon)) throw sai("Thiếu hoặc sai 'mon'");
  if (typeof b.i !== "string" || !ID_RE.test(b.i) || typeof b.c !== "string" || !ID_RE.test(b.c)) throw sai("Thiếu hoặc sai 'i'/'c'");
  await writeKnown(env, user, b.mon, [{ i: b.i, c: b.c, v: 0 }]);
  return { ok: true };
}

/**
 * Dòng thời gian (spec §6): gộp sổ `diem` (trừ khoá ôn on:/huy:on: — lượt ôn lấy từ attempt, gộp theo môn + ngày VN),
 * `attempt` và `lookup_hist` trong DONG_NGAY ngày, mới nhất trước, ≤ DONG_MAX dòng. `loai`/`mon` theo phanLoai (§4.7).
 */
async function hocDong(env, url, user) {
  const tu = giay() - DONG_NGAY * 86400;
  const db = env.STUDY_DB;
  const [a, b, c] = await db.batch([
    db.prepare(
      `SELECT khoa, diem, nhan, ts FROM diem
        WHERE user_id = ?1 AND ts >= ?2 AND diem != 0
          AND NOT (khoa >= 'on:' AND khoa < 'on;') AND NOT (khoa >= 'huy:on:' AND khoa < 'huy:on;')
        ORDER BY ts DESC, id DESC LIMIT ?3`
    ).bind(user, tu, DONG_MAX),
    db.prepare(
      `SELECT course, date(ts + 25200, 'unixepoch') AS ngay, COUNT(*) AS so, SUM(correct) AS dung, MAX(ts) AS ts
         FROM attempt WHERE user_id = ?1 AND ts >= ?2 GROUP BY course, ngay ORDER BY ts DESC LIMIT ?3`
    ).bind(user, tu, DONG_MAX),
    db.prepare(
      `SELECT course, term, tu, last_ts FROM lookup_hist WHERE user_id = ?1 AND last_ts >= ?2 ORDER BY last_ts DESC LIMIT ?3`
    ).bind(user, tu, DONG_MAX),
  ]);
  const mf = await an("mf", () => docManifest(env, url, user), null);
  const ra = [
    ...(a.results || []).map((x) => ({ ts: x.ts, ...phanLoai(x.khoa, mf), chu: x.nhan || x.khoa, diem: x.diem })),
    ...(b.results || []).map((x) => ({ ts: x.ts, loai: "on", mon: x.course, chu: `Ôn tập: ${x.so} lượt, đúng ${x.dung || 0}`, so: x.so })),
    ...(c.results || []).map((x) => ({ ts: x.last_ts, loai: "tra", mon: x.course, chu: `Tra: ${x.tu || x.term}` })),
  ].filter((x) => x.loai);
  ra.sort((p, q) => q.ts - p.ts);
  return ra.slice(0, DONG_MAX);
}

/** Tập đọc: truyện ĐÃ đụng tới (có hàng td_*), mới nhất trước. Trang = số mốc trang_dau ≤ vi_tri. Không có Tập đọc → []. */
async function hocTapdoc(env, url, user) {
  let cm;
  try { cm = await kiemUser(env, url, user); } catch (e) { if (e.status === 404) return []; throw e; }
  const db = env.STUDY_DB;
  const [a, b, c] = await db.batch([
    db.prepare(`SELECT truyen, vi_tri, start_ts, read_ts, ts FROM td_truyen WHERE user_id = ?1`).bind(user),
    db.prepare(`SELECT truyen, SUM(dung) AS dung FROM td_quiz WHERE user_id = ?1 GROUP BY truyen`).bind(user),
    db.prepare(`SELECT truyen, xong FROM td_thuam WHERE user_id = ?1`).bind(user),
  ]);
  const o = {};
  const h = (id) => (o[id] ??= { vi_tri: 0, bat_dau: false, doc_xong: false, quiz_dung: 0, thuam: false, ts: 0 });
  for (const r of a.results || []) {
    Object.assign(h(r.truyen), { vi_tri: r.vi_tri, bat_dau: r.start_ts != null || r.read_ts != null, doc_xong: r.read_ts != null, ts: r.ts });
  }
  for (const r of b.results || []) h(r.truyen).quiz_dung = r.dung || 0;
  for (const r of c.results || []) h(r.truyen).thuam = !!r.xong;
  return (cm.truyen || []).filter((t) => o[t.id]).map((t) => ({
    truyen: t.id, ten: t.ten || t.id, cap: t.cap, ...o[t.id],
    trang: Math.max(1, (t.trang_dau || [0]).filter((x) => x <= o[t.id].vi_tri).length), so_trang: t.so_trang || 1,
    quiz_tong: t.so_hoi || 0,
  })).sort((p, q) => q.ts - p.ts);
}

// Trần ON_MAX lấy thẻ ĐÃ THUỘC trước (known DESC): thẻ đánh dấu thuộc mà chưa ôn lần nào có last_ts = 0, xếp theo last_ts thì bị
// cắt đầu tiên → không trang nào bỏ cờ của nó được nữa. Trả về vẫn xếp mới nhất trước (sắp lại sau khi cắt).
async function hocOn(env, url, user) {
  const r = await env.STUDY_DB.prepare(
    `SELECT item_id AS i, concept_id AS c, course AS mon, n, wrong, streak, box, due, known, last_ts
       FROM card WHERE user_id = ?1 ORDER BY known DESC, last_ts DESC, item_id LIMIT ?2`
  ).bind(user, ON_MAX).all();
  return (r.results || []).sort((p, q) => (q.last_ts || 0) - (p.last_ts || 0) || (p.i < q.i ? -1 : p.i > q.i ? 1 : 0));
}

async function hocTu(env, url, user) {
  const r = await env.STUDY_DB.prepare(
    `SELECT term, tu, nghia, course AS mon, n, last_ts FROM lookup_hist WHERE user_id = ?1 ORDER BY last_ts DESC LIMIT ?2`
  ).bind(user, TU_MAX).all();
  return r.results || [];
}

const PHAN = { dong: hocDong, tapdoc: hocTapdoc, on: hocOn, tu: hocTu };

/** Lịch sử học tập, nạp lười theo tab (spec §6). Tiến độ theo môn tính ở TRÌNH DUYỆT (dữ liệu nhúng + /api/progress). */
async function routeHocTap(request, env, url) {
  const user = kiemU(url.searchParams.get("user"));
  const phan = url.searchParams.get("phan") || "";
  if (!Object.hasOwn(PHAN, phan)) throw sai("Thiếu hoặc sai 'phan' (dong | tapdoc | on | tu)");
  return PHAN[phan](env, url, user);
}

const TUYEN = {
  "/api/quantri/truyen/go": { m: "POST", fn: routeGoTruyen },
  "/api/quantri/on/go": { m: "POST", fn: routeGoOn },
  "/api/quantri/thuoc": { m: "GET", fn: routeThuoc },
  "/api/quantri/diem": { m: "GET", fn: routeDiem },
  "/api/quantri/diem/bieu-do": { m: "GET", fn: routeBieuDo },
  "/api/quantri/diem/huy": { m: "POST", fn: routeHuy },
  "/api/quantri/diem/cong": { m: "POST", fn: routeCong },
  "/api/quantri/tick/go": { m: "POST", fn: routeTickGo },
  "/api/quantri/thuoc/go": { m: "POST", fn: routeThuocGo },
  "/api/quantri/hoc-tap": { m: "GET", fn: routeHocTap },
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
    if (e.status && (e.status < 500 || e.status === 503)) return json({ error: e.message }, e.status);
    console.error("quantri:", e);
    return json({ error: "Lỗi máy chủ" }, 500);
  }
}
