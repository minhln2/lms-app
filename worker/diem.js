/**
 * Điểm thưởng (Tập đọc #3) — spec docs/superpowers/specs/2026-10-08-diem-thuong-design.md, ADR 0061.
 *
 * MỘT ví mỗi học sinh, dùng chung toàn hệ thống: sổ `diem` trong D1 (migrations/0009_diem.sql), chỉ thêm, không sửa.
 * Toàn bộ LUẬT điểm nằm ở file này; các route chỉ gọi vào, bọc trong `an()` — ghi sổ lỗi KHÔNG BAO GIỜ làm hỏng thao
 * tác chính (lưu tiến độ, quiz, bản thu, tick): lỗi chỉ console.error, route trả `cong: 0`.
 *
 * "Lần đầu" và trần ôn tập do khoá UNIQUE (user_id, khoa) bảo đảm: mọi lượt cộng là MỘT câu
 * `INSERT OR IGNORE … SELECT … FROM json_each(?) RETURNING` — không đọc-rồi-ghi (không race giữa hai thiết bị), và
 * RETURNING nói đúng dòng nào vừa vào (= điểm vừa cộng). Một câu cho cả lô, như writeSession của study.js: batch hàng
 * trăm câu INSERT là chạm trần số câu mỗi lượt gọi của D1.
 *
 * Gỡ đánh dấu (ADR 0063): sổ VẪN chỉ thêm. Gỡ dòng K = thêm dòng `huy:K` điểm âm (`cauHuy` / `huyDiem`). Làm lại sau khi
 * gỡ được cộng lại theo LƯỢT: nguồn S có khoá S, S#2, S#3…; lượt kế = số dòng `huy:` của S + 1, tính ngay trong câu
 * INSERT của `ghiDiem`. Nguồn có dòng mốc 0 điểm (ghi_moc_diem.py) thì mọi lượt sau cũng 0 điểm.
 *
 * File này cũng chạy bằng node (scripts/ghi_moc_diem.py gọi `chonTick`): không import gì, không dùng API riêng của
 * Worker ngoài `crypto.subtle` / `crypto.randomUUID` / `btoa` / `atob` (node ≥ 20 có sẵn).
 */

export const DIEM = {
  DOC: { A: 30, B: 40, C: 50, D: 60 },   // đọc xong truyện — theo cấp
  THUAM: { A: 30, B: 40, C: 50 },        // thu âm hoàn thành = điểm đọc cùng cấp; cấp D không thu âm (ADR 0059)
  QUIZ: 10,                              // mỗi câu quiz tập đọc đúng LẦN ĐẦU
  TICK: 20,                              // tick một mục ở trang môn (tay hoặc tự tick)
  SHEET: 20,                             // tick một đầu mục bài tập ở bảng lớp (Lớp Ms Dung) — ADR 0068
  NHOM: 20,                              // thưởng khi đủ mọi mục của một section
  ON: 1,                                 // mỗi lượt ôn tập, trong ON_LUOT lượt đầu mỗi ngày của mỗi thẻ
  ON_NHO: 2,                             // thưởng lượt nhớ / đúng đầu tiên trong ON_LUOT lượt đó
  ON_LUOT: 3,
};
export const LICH_SU = 100;      // số dòng lịch sử GET /api/diem trả
export const GHI_CHU_MAX = 200;  // ghi chú khi bố mẹ trừ
export const TRU_MAX = 100000;   // một lần trừ tối đa (chặn số gõ nhầm)
export const PHIEN_S = 86400;    // phiên quản trị 24 giờ

const USER_RE = /^[\w-]{1,32}$/;
const VN = 7 * 3600;
const giay = () => Math.floor(Date.now() / 1000);
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** Ngày lịch giờ Việt Nam (UTC+7) của mốc epoch giây → "YYYY-MM-DD". 17:00 UTC là nửa đêm ở Việt Nam. */
export function ngayVN(ts) {
  return new Date((ts + VN) * 1000).toISOString().slice(0, 10);
}

/** Mốc của một lượt ôn tập, kẹp như câu INSERT attempt của writeSession: [now − 24 h, now]; thiếu / rác → now. */
export function kepTs(t, now) {
  return Math.min(Math.max(Number(t) || now, now - 86400), now);
}

/** Chạy một lượt ghi sổ; lỗi → console.error + trả `macDinh`. Thao tác chính của route KHÔNG được hỏng vì sổ điểm. */
export async function an(viec, fn, macDinh = 0) {
  try {
    return await fn();
  } catch (e) {
    console.error("diem:" + viec, e);
    return macDinh;
  }
}

/**
 * Ghi một lô dòng `{khoa, diem, nhan?, ts?}` của `user` bằng MỘT câu INSERT OR IGNORE (3 tham số, mọi cỡ lô).
 * `khoa` là NGUỒN S (ADR 0063): khoá thật = lượt kế tiếp của S — S nếu chưa gỡ lần nào, S#n nếu đã có n − 1 dòng `huy:`
 * của S — đếm ngay trong câu (khoảng khoá trên chỉ mục UNIQUE). Lượt đó đã có (đang hiệu lực, kể cả trùng ngay trong lô)
 * → bỏ qua. Dòng S có điểm 0 (mốc "trước hệ điểm") → lượt mới cũng 0 điểm.
 * → {cong: tổng điểm các dòng VỪA vào, khoa: [khoá thật vừa vào], nguon: [nguồn của chúng, cùng thứ tự]}.
 */
export async function ghiDiem(env, user, dong, now = giay()) {
  if (!dong.length) return { cong: 0, khoa: [], nguon: [] };
  const payload = JSON.stringify(dong.map((r) => ({ k: r.khoa, d: r.diem, n: r.nhan ?? null, t: r.ts ?? null })));
  const r = await env.STUDY_DB.prepare(
    `INSERT OR IGNORE INTO diem (user_id, khoa, diem, nhan, ts)
     SELECT ?1, CASE WHEN h.so = 0 THEN h.k ELSE h.k || '#' || (h.so + 1) END,
            CASE WHEN (SELECT g.diem FROM diem AS g WHERE g.user_id = ?1 AND g.khoa = h.k) = 0 THEN 0 ELSE h.d END,
            h.n, h.t
       FROM (SELECT json_extract(e.value, '$.k') AS k, json_extract(e.value, '$.d') AS d,
                    json_extract(e.value, '$.n') AS n, COALESCE(json_extract(e.value, '$.t'), ?2) AS t,
                    (SELECT COUNT(*) FROM diem AS x
                      WHERE x.user_id = ?1
                        AND x.khoa >= 'huy:' || json_extract(e.value, '$.k')
                        AND x.khoa < 'huy:' || json_extract(e.value, '$.k') || '$'
                        AND (x.khoa = 'huy:' || json_extract(e.value, '$.k')
                             OR substr(x.khoa, length(json_extract(e.value, '$.k')) + 5, 1) = '#')) AS so
               FROM json_each(?3) AS e) AS h
     RETURNING khoa, diem`
  ).bind(user, now, payload).all();
  const vao = r.results || [];
  return { cong: vao.reduce((s, x) => s + x.diem, 0), khoa: vao.map((x) => x.khoa), nguon: vao.map((x) => goc(x.khoa)) };
}

/** Số dư = SUM(diem) — kể cả dòng âm (bố mẹ trừ) và dòng 0 (mốc). */
export async function soDu(env, user) {
  const r = await env.STUDY_DB.prepare(`SELECT COALESCE(SUM(diem), 0) AS du FROM diem WHERE user_id = ?1`)
    .bind(user).first();
  return r ? r.du : 0;
}

/** Khoảng [`tien`, `tien` + 1 ở ký tự cuối) — quét tiền tố bằng `khoa >= ? AND khoa < ?` (đi được chỉ mục UNIQUE
 *  (user_id, khoa)), thay phép so mẫu tiền tố. Tiền tố kết thúc bằng ":" → cận trên ";". */
const khoang = (tien) => [tien, tien.slice(0, -1) + String.fromCharCode(tien.charCodeAt(tien.length - 1) + 1)];

// ── Lượt + dòng gỡ (ADR 0063) ────────────────────────────────────────────────
// `#` không có trong mọi khoá nguồn (id môn / mục Canvas là số, id truyện [a-z0-9-], id thẻ f.|q. + hex, ngày YYYY-MM-DD):
// S#n không bao giờ trùng một nguồn khác. Trong khoảng khoá, '#' (0x23) < '$' (0x24): [S, S + '$') chứa S và mọi S#n.
export const NHAN_GO = "↩ Gỡ · ";

/** Khoá của lượt `n` (≥ 1) của nguồn `s`: lượt 1 = s, lượt n ≥ 2 = s#n. */
export const khoaLuot = (s, n) => (n === 1 ? s : `${s}#${n}`);

/** Nguồn của một khoá lượt: bỏ hậu tố `#n`. */
export const goc = (k) => String(k).replace(/#\d+$/, "");

/** Số lượt của `s` đã bị gỡ — lượt luôn liền nhau (lượt n + 1 chỉ có sau khi lượt n bị gỡ). */
function soGo(daCo, s) {
  let n = 0;
  while (daCo.has("huy:" + khoaLuot(s, n + 1))) n++;
  return n;
}

/** Hàm thuần: khoá lượt KẾ TIẾP của `s` nếu `s` chưa có lượt đang hiệu lực trong tập khoá `daCo`; có rồi → null. */
export function luotKe(daCo, s) {
  const k = khoaLuot(s, soGo(daCo, s) + 1);
  return daCo.has(k) ? null : k;
}

/** Hàm thuần: khoá lượt ĐANG HIỆU LỰC của `s` (lượt lớn nhất có trong `daCo` mà chưa có `huy:`), không có → null. */
export function dangHieuLuc(daCo, s) {
  const k = khoaLuot(s, soGo(daCo, s) + 1);
  return daCo.has(k) ? k : null;
}

// Một nguồn → khoảng khoá phải quét: "…:" (kết thúc bằng ':') = MỌI khoá dưới tiền tố đó (quiz của một truyện, các lượt ôn
// của một thẻ trong một ngày); còn lại = s và s#n (l = 1: lọc đúng s hoặc ký tự ngay sau s là '#').
const khopNguon = (s) => (s.endsWith(":") ? { a: s, b: khoang(s)[1], l: 0 } : { a: s, b: s + "$", l: 1 });

/**
 * Câu gỡ (chưa chạy — để route quản trị đặt ĐẦU một db.batch): mỗi dòng của `nguon` mà CHƯA bị gỡ → thêm `huy:<khoá>`,
 * điểm âm, nhãn NHAN_GO + nhãn gốc, ts = now. Lượt đã gỡ thì `huy:` đã có → INSERT OR IGNORE bỏ: hai thiết bị gỡ cùng lúc
 * vẫn chỉ trừ một lần. Không đọc trước. CROSS JOIN giữ json_each ở vòng ngoài → mỗi nguồn là một lần quét khoảng trên chỉ
 * mục UNIQUE (user_id, khoa). RETURNING khoa, diem (diem âm).
 */
export function cauHuy(db, user, nguon, now = giay()) {
  return db.prepare(
    `INSERT OR IGNORE INTO diem (user_id, khoa, diem, nhan, ts)
     SELECT d.user_id, 'huy:' || d.khoa, -d.diem, ?4 || COALESCE(d.nhan, ''), ?2
       FROM json_each(?3) AS e CROSS JOIN diem AS d
      WHERE d.user_id = ?1
        AND d.khoa >= json_extract(e.value, '$.a') AND d.khoa < json_extract(e.value, '$.b')
        AND (json_extract(e.value, '$.l') = 0 OR d.khoa = json_extract(e.value, '$.a')
             OR substr(d.khoa, length(json_extract(e.value, '$.a')) + 1, 1) = '#')
     RETURNING khoa, diem`
  ).bind(user, now, JSON.stringify(nguon.map(khopNguon)), NHAN_GO);
}

/** Gỡ lượt đang hiệu lực của các nguồn (một câu). → {tru: tổng điểm vừa trừ (số dương), khoa: [khoá `huy:` vừa vào]}. */
export async function huyDiem(env, user, nguon, now = giay()) {
  if (!nguon.length) return { tru: 0, khoa: [] };
  const vao = (await cauHuy(env.STUDY_DB, user, nguon, now).all()).results || [];
  return { tru: -vao.reduce((s, x) => s + x.diem, 0), khoa: vao.map((x) => x.khoa) };
}

/**
 * Hàm thuần (ADR 0063): một dòng lịch sử (không phải nhóm ôn tập) gỡ được không, gỡ bằng gì. `daGo` = dòng này đã có `huy:`.
 *   tick:<course>/<item>[#n]                          → {loai: "tick", key: "<user>/<course>/<item>"} (POST /api/progress false)
 *   td:doc:<t>[#n] · td:thuam:<t>[#n] · td:quiz:<t>:<câu>[#n] → {loai: "truyen", truyen: t} (gỡ CẢ truyện)
 *   nhom: · doi: · huy: · moc: · dòng đã bị gỡ                → null (nhóm ôn tập: lichSu tự dựng {loai: "on", mon, ngay})
 */
export function cachGo(user, khoa, daGo) {
  if (daGo) return null;
  let m = /^tick:(\d+)\/([\w-]+)(?:#\d+)?$/.exec(khoa);
  if (m) return { loai: "tick", key: `${user}/${m[1]}/${m[2]}` };
  m = /^td:(?:doc|thuam):([a-z0-9-]+)(?:#\d+)?$/.exec(khoa) || /^td:quiz:([a-z0-9-]+):\d+(?:#\d+)?$/.exec(khoa);
  return m ? { loai: "truyen", truyen: m[1] } : null;
}

/**
 * `n` dòng gần nhất, mới nhất trước; dòng 0 điểm (ghi mốc) không hiện. Ôn tập (mỗi lượt một dòng `on:<thẻ>:<ngày>:<k>[#n]`,
 * hàng trăm dòng mỗi tối) GỘP thành MỘT dòng mỗi (ngày VN, môn) — để không đẩy dòng đọc truyện / tick ra khỏi `n` dòng:
 * khoa `on:<ngày>:<id>` (id = dòng mới nhất của nhóm — khoá duy nhất cho giao diện), diem = tổng RÒNG, nhan = nhãn
 * `Ôn tập · <tên môn>`, ts = lượt muộn nhất, `mon` = slug môn (từ bảng attempt theo thẻ của dòng mới nhất — thẻ lấy từ khoá của dòng đó bằng khoá chính `diem.id`, KHÔNG quay lại CTE `o` cho từng dòng nhóm; không thấy → null).
 * Ngày = đoạn thứ 3 của KHOÁ (mã thẻ không có ":"), không phải ngày của ts: dòng gỡ `huy:on:…` (ts = lúc gỡ, có thể ngày
 * khác) vào ĐÚNG nhóm của dòng gốc, bỏ tiền tố nhãn NHAN_GO để cùng nhãn — nhóm gỡ hết có tổng 0 và ẩn như dòng 0.
 * Dòng gỡ của nguồn khác (`huy:tick:…`, `huy:td:…`) hiện riêng, điểm âm. Mỗi dòng gỡ được kèm `go` (cachGo; nhóm ôn tập có
 * `mon` thì {loai: "on", mon, ngay}).
 */
export async function lichSu(env, user, n = LICH_SU) {
  const [on0, on1] = khoang("on:");
  const [ho0, ho1] = khoang("huy:on:");
  const r = await env.STUDY_DB.prepare(
    `WITH o AS (
       SELECT id, diem, ts, (khoa >= ?5 AND khoa < ?6) AS h,
              CASE WHEN khoa >= ?5 AND khoa < ?6 THEN substr(khoa, 5) ELSE khoa END AS k,
              CASE WHEN khoa >= ?5 AND khoa < ?6 THEN substr(nhan, length(?7) + 1) ELSE nhan END AS nh
         FROM diem WHERE user_id = ?1 AND ((khoa >= ?3 AND khoa < ?4) OR (khoa >= ?5 AND khoa < ?6))
     ), g AS (
       SELECT substr(k, instr(substr(k, 4), ':') + 4, 10) AS ngay, nh, SUM(diem) AS diem,
              MAX(CASE WHEN h = 0 THEN ts END) AS ts, MAX(CASE WHEN h = 0 THEN id END) AS id
         FROM o GROUP BY ngay, nh HAVING SUM(diem) != 0
     ), u AS (
       SELECT khoa, diem, nhan, ts, id, NULL AS ngay FROM diem
        WHERE user_id = ?1 AND diem != 0 AND NOT (khoa >= ?3 AND khoa < ?4) AND NOT (khoa >= ?5 AND khoa < ?6)
       UNION ALL
       SELECT 'on:' || ngay || ':' || id, diem, nh, ts, id, ngay FROM g
       ORDER BY ts DESC, id DESC LIMIT ?2
     )
     SELECT u.khoa, u.diem, u.nhan, u.ts, u.ngay,
            CASE WHEN u.ngay IS NULL
                 THEN EXISTS (SELECT 1 FROM diem AS x WHERE x.user_id = ?1 AND x.khoa = 'huy:' || u.khoa) ELSE 0 END AS da_go,
            CASE WHEN u.ngay IS NULL THEN NULL
                 ELSE (SELECT a.course FROM attempt AS a
                        WHERE a.user_id = ?1
                          AND a.item_id = (SELECT substr(z.k, 4, instr(substr(z.k, 4), ':') - 1)
                                             FROM (SELECT CASE WHEN substr(khoa, 1, 4) = 'huy:' THEN substr(khoa, 5) ELSE khoa END AS k
                                                     FROM diem WHERE id = u.id AND user_id = ?1) AS z)
                        ORDER BY a.ts DESC LIMIT 1) END AS mon
       FROM u ORDER BY u.ts DESC, u.id DESC`
  ).bind(user, n, on0, on1, ho0, ho1, NHAN_GO).all();
  return (r.results || []).map((x) => {
    const d = { khoa: x.khoa, diem: x.diem, nhan: x.nhan, ts: x.ts };
    if (x.ngay != null) {
      d.mon = x.mon ?? null;
      if (x.mon) d.go = { loai: "on", mon: x.mon, ngay: x.ngay };
    } else {
      const go = cachGo(user, x.khoa, !!x.da_go);
      if (go) d.go = go;
    }
    return d;
  });
}

// ── Phiên quản trị (bố mẹ) ──────────────────────────────────────────────────
// Token = base64url(het) + "." + base64url(HMAC-SHA256(PARENT_SECRET, "quantri|" + het)), het = now + 24 h (giây).
// Đổi PARENT_SECRET là mọi token cũ mất hiệu lực. `kiemQuantri` xuất ra để route quản trị sau này dùng lại.
// Nhập sai mã không có trần đếm lượt (hai bé, mã do bố mẹ đặt dài) — spec §7.1, cố ý không làm.
const enc = new TextEncoder();
const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function tuB64u(s) {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const b = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
const khoaHmac = (secret) =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export async function taoToken(secret, het) {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await khoaHmac(secret), enc.encode("quantri|" + het)));
  return b64u(enc.encode(String(het))) + "." + b64u(sig);
}

/** Header `x-quantri` hợp lệ? → {ok: true, het} | {ok: false, status, loi}. So chữ ký bằng crypto.subtle.verify (thời gian hằng). */
export async function kiemQuantri(request, env) {
  const secret = env.PARENT_SECRET || "";
  if (!secret) return { ok: false, status: 503, loi: "Chưa cấu hình PARENT_SECRET" };
  const sai = { ok: false, status: 401, loi: "Phiên bố mẹ không hợp lệ hoặc đã hết hạn" };
  const m = /^([\w-]{1,24})\.([\w-]{43})$/.exec(request.headers.get("x-quantri") || "");
  if (!m) return sai;
  let hetChu, sig;
  try {
    hetChu = new TextDecoder().decode(tuB64u(m[1]));
    sig = tuB64u(m[2]);
  } catch {
    return sai;
  }
  if (!/^[1-9]\d{8,10}$/.test(hetChu)) return sai;
  const het = Number(hetChu), now = giay();
  // het do CHÍNH máy chủ đặt = lúc mở + 24 h; xa hơn thế (+60 s lệch) là token không do phiên này cấp.
  if (het <= now || het > now + PHIEN_S + 60) return sai;
  const dung = await crypto.subtle.verify("HMAC", await khoaHmac(secret), sig, enc.encode("quantri|" + hetChu));
  return dung ? { ok: true, het } : sai;
}

async function docBody(request) {
  try { return (await request.json()) || {}; } catch { return null; }
}

async function moPhien(request, env) {
  const secret = env.PARENT_SECRET || "";
  if (!secret) return json({ error: "Chưa cấu hình PARENT_SECRET" }, 503);
  const b = await docBody(request);
  if (!b) return json({ error: "Body không hợp lệ" }, 400);
  if (typeof b.ma !== "string" || b.ma !== secret) return json({ error: "Mã bố mẹ không đúng" }, 401);
  const het = giay() + PHIEN_S;
  return json({ token: await taoToken(secret, het), het });
}

// Bố mẹ trừ: kiểm "≤ số dư" ngay trong MỘT câu INSERT … SELECT … WHERE (SELECT SUM…) >= ? — không đọc-rồi-ghi, hai
// thiết bị trừ cùng lúc thì câu sau thấy số dư đã giảm. Khoá doi:<ms>:<8 hex>: phần ngẫu nhiên để hai lượt trừ cùng
// mili-giây không đụng khoá UNIQUE.
async function truDiem(request, env) {
  const q = await kiemQuantri(request, env);
  if (!q.ok) return json({ error: q.loi }, q.status);
  if (!env.STUDY_DB) return json({ error: "Chưa cấu hình STUDY_DB" }, 503);
  const b = await docBody(request);
  if (!b) return json({ error: "Body không hợp lệ" }, 400);
  const user = b.user, diem = b.diem;
  const ghiChu = typeof b.ghi_chu === "string" ? b.ghi_chu.trim() : "";
  if (typeof user !== "string" || !USER_RE.test(user)) return json({ error: "Thiếu hoặc sai 'user'" }, 400);
  if (!Number.isInteger(diem) || diem < 1 || diem > TRU_MAX) return json({ error: "'diem' phải là số nguyên dương" }, 400);
  if (!ghiChu || ghiChu.length > GHI_CHU_MAX) return json({ error: `Cần ghi chú (tối đa ${GHI_CHU_MAX} ký tự)` }, 400);
  const db = env.STUDY_DB;
  const khoa = `doi:${Date.now()}:${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const [ghi, du] = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO diem (user_id, khoa, diem, nhan, ts)
       SELECT ?1, ?2, -?3, ?4, ?5
        WHERE (SELECT COALESCE(SUM(diem), 0) FROM diem WHERE user_id = ?1) >= ?3
       RETURNING diem`
    ).bind(user, khoa, diem, ghiChu, giay()),
    db.prepare(`SELECT COALESCE(SUM(diem), 0) AS du FROM diem WHERE user_id = ?1`).bind(user),
  ]);
  const conLai = du.results[0].du;
  if (!(ghi.results || []).length) return json({ error: `Không đủ điểm để trừ (còn ${conLai})`, du: conLai }, 400);
  return json({ ok: true, du: conLai });
}

// Số dư + lịch sử: chặn bằng mã bí mật (dữ liệu của một đứa trẻ có tên — như /api/study/stats). `gon=1`: chỉ số dư
// (ô ⭐ ở trang riêng và Tập đọc không cần 100 dòng lịch sử).
async function xemDiem(request, env, url) {
  const secret = env.LMS_SECRET || "";
  if (!secret) return json({ error: "Chưa cấu hình LMS_SECRET" }, 503);
  if ((request.headers.get("x-progress-key") || "") !== secret) return json({ error: "Mã bí mật không đúng" }, 401);
  if (!env.STUDY_DB) return json({ error: "Chưa cấu hình STUDY_DB" }, 503);
  const user = url.searchParams.get("user") || "";
  if (!USER_RE.test(user)) return json({ error: "Thiếu hoặc sai 'user'" }, 400);
  // Mở trang điểm là một lượt ĐỐI CHIẾU tick (spec §4.1): bài tự tick (src/main.py ghi thẳng KV) được cộng ở đây.
  if (env.PROGRESS_KV) {
    await an("tick", async () => doiChieuTick(env, url, user,
      (await env.PROGRESS_KV.get(KHOA_TIEN_DO, { type: "json" })) || {}), { cong: 0, nhom: [] });
  }
  const du = await soDu(env, user);
  if (url.searchParams.get("gon")) return json({ du });
  return json({ du, lich_su: await lichSu(env, user) });
}

/** Ba đường của điểm thưởng: /api/quantri/phien · /api/diem/doi · /api/diem. Lỗi máy chủ: chi tiết chỉ vào log. */
export async function handleDiem(request, env, url) {
  const p = url.pathname, m = request.method;
  const sai = () => json({ error: "Method không hỗ trợ" }, 405);
  try {
    if (p === "/api/quantri/phien") return m === "POST" ? await moPhien(request, env) : sai();
    if (p === "/api/diem/doi") return m === "POST" ? await truDiem(request, env) : sai();
    if (p === "/api/diem") return m === "GET" ? await xemDiem(request, env, url) : sai();
    return json({ error: "Không có đường dẫn này" }, 404);
  } catch (e) {
    console.error("diem:", e);
    return json({ error: "Lỗi máy chủ" }, 500);
  }
}

// ── Tập đọc ───────────────────────────────────────────────────────────────
// Route (worker/tapdoc.js) CHỈ gọi khi lượt đó làm mốc "lần đầu" chuyển NULL → có (read_ts / dung_ts / xong_ts): việc làm
// trước hệ điểm không bao giờ được cộng, nên tập đọc không cần ghi mốc. Hai máy cùng chuyển: khoá chặn lần hai.
// `t` = hàng của truyện trong tap-doc/index.json (cùng `cap` với truyen.json — kiemTruyen đã đọc sẵn).
export async function congDoc(env, user, t) {
  const d = DIEM.DOC[t.cap];
  if (!d) return 0;
  return (await ghiDiem(env, user, [{ khoa: `td:doc:${t.id}`, diem: d, nhan: `Đọc xong · ${t.ten || t.id}` }])).cong;
}

export async function congQuiz(env, user, t, caus) {
  const dong = caus.map((c) => ({ khoa: `td:quiz:${t.id}:${c}`, diem: DIEM.QUIZ, nhan: `Quiz · ${t.ten || t.id} · câu ${c + 1}` }));
  return (await ghiDiem(env, user, dong)).cong;
}

export async function congThuam(env, user, t) {
  const d = DIEM.THUAM[t.cap];
  if (!d) return 0;
  return (await ghiDiem(env, user, [{ khoa: `td:thuam:${t.id}`, diem: d, nhan: `Thu âm · ${t.ten || t.id}` }])).cong;
}

// ══ Task 4: ôn tập ═══════════════════════════════════════════════════════════
// ── Manifest (dist/diem/<user>.json, src/builder.py) ───────────────────────
/**
 * {mon: {<course_id>: {slug, ten, muc: {<item_id>: tên}, nhom: {<sechead_id>: {ten, muc: [item_id]}}}}} — CHỈ môn có cờ
 * `diem`. Không có / 404 / JSON vỡ / thiếu `mon` → null: coi như không môn nào có cờ (cộng 0). ASSETS ném lỗi → ném
 * (nơi gọi bọc an()).
 */
export async function docManifest(env, url, user) {
  if (!USER_RE.test(user || "")) return null;
  const r = await env.ASSETS.fetch(new Request(new URL(`/diem/${user}.json`, url)));
  if (!r.ok) return null;
  let d;
  try { d = await r.json(); } catch { return null; }
  return d && typeof d.mon === "object" && d.mon !== null && !Array.isArray(d.mon) ? d : null;
}

// ── Ôn tập ───────────────────────────────────────────────────────────────
// Mỗi thẻ / câu, mỗi ngày (UTC+7, theo mốc đã kẹp): tập khoá CỐ ĐỊNH :1 :2 :3 :nho → tối đa 3 + 2 = 5 điểm. Hai thiết bị
// ghi chồng: khoá trùng bị INSERT OR IGNORE bỏ — tổng KHÔNG BAO GIỜ vượt trần 5 điểm / thẻ / ngày (tập khoá cố định), cùng
// lắm một lượt bị tính thiếu; nhưng `:nho` có thể rơi vào lượt thực tế thứ tư (mỗi máy thấy lượt nhớ của mình là một trong
// ba lượt đầu, còn khoá :k của nó thì đã bị máy kia chiếm). Bố mẹ gỡ ngày ôn (ADR 0063) → các ô trống lại, lượt sau lấy ô
// đó ở lượt `#n` — trần 5 tính trên các khoá đang hiệu lực.

/** Tiền tố khoá ôn `on:<thẻ>:<ngày>:` mà các lượt `rows` có thể đụng tới — để đọc MỘT lần mọi khoá đã có của chúng
 *  (cả lượt `#n` lẫn dòng gỡ `huy:`, ADR 0063). */
export function tienToOn(rows, now) {
  return [...new Set(rows.map((a) => `on:${a.i}:${ngayVN(kepTs(a.t, now))}:`))];
}

/**
 * Hàm thuần: duyệt các lượt theo mốc (đã kẹp; cùng mốc giữ thứ tự gửi). Lượt được tính lấy ô :k nhỏ nhất (k ≤ ON_LUOT)
 * CHƯA có lượt đang hiệu lực (`luotKe`, ADR 0063 — ô đã bị bố mẹ gỡ thì trống lại) → +1; lượt nhớ / đúng (`ok`) đầu tiên
 * trong số lượt được tính lấy thêm :nho nếu ô đó trống → +2. Lượt không còn ô :k thì bỏ (kể cả đúng). Trần 5 điểm / thẻ /
 * ngày vì thế tính trên các khoá ĐANG HIỆU LỰC. → [{khoa: NGUỒN (ghiDiem đổi ra khoá lượt), diem, nhan, ts}].
 */
export function chonOn(rows, daCo, now, nhan = "Ôn tập") {
  const co = new Set(daCo);
  const ra = [];
  const ds = rows.map((a, i) => ({ a, i, t: kepTs(a.t, now) })).sort((p, q) => p.t - q.t || p.i - q.i);
  for (const { a, t } of ds) {
    const g = `on:${a.i}:${ngayVN(t)}:`;
    let k = 1, lu = null;
    while (k <= DIEM.ON_LUOT && !(lu = luotKe(co, g + k))) k++;
    if (!lu) continue;
    co.add(lu);
    ra.push({ khoa: g + k, diem: DIEM.ON, nhan, ts: t });
    const ln = a.ok ? luotKe(co, g + "nho") : null;
    if (ln) {
      co.add(ln);
      ra.push({ khoa: g + "nho", diem: DIEM.ON_NHO, nhan, ts: t });
    }
  }
  return ra;
}

/** Lô lượt ôn của writeSession (`rows` đã lọc, `t` thiếu → now) → điểm vừa cộng. Môn (slug) không có trong manifest → 0. */
export async function congOn(env, url, user, course, rows, now = giay()) {
  if (!rows.length) return 0;
  const mf = await docManifest(env, url, user);
  const mon = mf && Object.values(mf.mon).find((m) => m && m.slug === course);
  if (!mon) return 0;
  // Mỗi tiền tố hai khoảng: khoá ôn (mọi lượt) và dòng gỡ của chúng. CROSS JOIN: json_each ở vòng ngoài, mỗi khoảng một lần
  // quét trên chỉ mục UNIQUE (user_id, khoa).
  const kh = tienToOn(rows, now).flatMap((t) => [khoang(t), khoang("huy:" + t)]);
  const co = await env.STUDY_DB.prepare(
    `SELECT d.khoa FROM json_each(?2) AS e CROSS JOIN diem AS d
      WHERE d.user_id = ?1 AND d.khoa >= json_extract(e.value, '$[0]') AND d.khoa < json_extract(e.value, '$[1]')`
  ).bind(user, JSON.stringify(kh)).all();
  const moi = chonOn(rows, new Set((co.results || []).map((r) => r.khoa)), now, `Ôn tập · ${mon.ten || course}`);
  return (await ghiDiem(env, user, moi, now)).cong;
}
// ══ Hết Task 4 ═══════════════════════════════════════════════════════════════

// ══ Task 6: tick ═════════════════════════════════════════════════════════════
// ── Tick (trang môn) ───────────────────────────────────────────────────────
// Tự tick ghi THẲNG vào KV từ src/main.py (ADR 0006), không qua Worker — nên điểm tick không theo từng lượt POST mà bằng
// ĐỐI CHIẾU tài liệu KV `progress` với manifest: tick tay và tự tick đi chung một đường, luật thưởng nhóm ở một chỗ.
const KHOA_TIEN_DO = "progress";   // khoá KV của tiến độ — cùng hằng KEY trong worker/index.js

/**
 * Hàm thuần — MỘT bản luật cho Worker (doiChieuTick) và lệnh ghi mốc (scripts/ghi_moc_diem.py gọi bằng node):
 *   - tick: mục có trong manifest (`muc` — đã theo _countable) và có khoá KV `<user>/<course_id>/<item_id>` (tay hay
 *     tự tick; kể cả đang `redo` — mục đó ĐÃ được tick, ADR 0007);
 *   - nhom: section mà MỌI thành viên có khoá KV và KHÔNG `redo` (đúng như ô tick nhóm `syncSecBox`); section rỗng không
 *     bao giờ được thưởng.
 * Bỏ nguồn đang có lượt HIỆU LỰC trong `daCo` (`luotKe`, ADR 0063 — đã bị gỡ thì được cộng lại ở lượt #n; `daCo` phải có
 * cả dòng `huy:tick:` / `huy:nhom:`). → [{khoa: NGUỒN, diem, nhan, nhom?}] — `nhom` = tên section (trang môn bật
 * "hoàn thành <section>").
 */
export function chonTick(mf, items, user, daCo) {
  const it = items && typeof items === "object" ? items : {};
  const ra = [];
  for (const [cid, mon] of Object.entries((mf && mf.mon) || {})) {
    if (!mon || typeof mon !== "object") continue;
    const muc = mon.muc || {};
    const kv = (iid) => it[`${user}/${cid}/${iid}`];
    const xong = (iid) => { const v = kv(iid); return !!v && !v.redo; };
    for (const iid of Object.keys(muc)) {
      const khoa = `tick:${cid}/${iid}`;
      if (kv(iid) && luotKe(daCo, khoa)) ra.push({ khoa, diem: DIEM.TICK, nhan: `${mon.ten || cid} · ${muc[iid]}` });
    }
    for (const [sid, g] of Object.entries(mon.nhom || {})) {
      const khoa = `nhom:${cid}/${sid}`;
      const ds = g && Array.isArray(g.muc) ? g.muc : [];
      if (ds.length && ds.every(xong) && luotKe(daCo, khoa)) {
        ra.push({ khoa, diem: DIEM.NHOM, nhan: `${mon.ten || cid} · hoàn thành ${g.ten || sid}`, nhom: g.ten || sid });
      }
    }
  }
  return ra;
}

/**
 * Hàm thuần (ADR 0063): khoá tiến độ vừa BỎ TICK RÕ RÀNG (`keys`, dạng `<user>/<course_id>/<item_id>`) → các nguồn phải gỡ:
 * `tick:<course_id>/<item_id>` và `nhom:<course_id>/<sid>` của MỌI section chứa mục đó — chỉ nguồn đang có lượt hiệu lực
 * trong `daCo`. Khoá của học sinh khác, môn không có trong `mf` (nơi gọi đã lọc môn chưa có cổng), mục không có trong
 * `muc` (bị prune, không _countable) → bỏ qua. → [nguồn], không trùng.
 */
export function chonGo(mf, keys, user, daCo) {
  const ra = new Set();
  for (const k of keys || []) {
    const m = /^([\w-]+)\/(\d+)\/([\w-]+)$/.exec(k);
    if (!m || m[1] !== user) continue;
    const [, , cid, iid] = m;
    const mon = mf && mf.mon && mf.mon[cid];
    if (!mon || typeof mon !== "object" || !Object.hasOwn(mon.muc || {}, iid)) continue;
    const t = `tick:${cid}/${iid}`;
    if (dangHieuLuc(daCo, t)) ra.add(t);
    for (const [sid, g] of Object.entries(mon.nhom || {})) {
      const s = `nhom:${cid}/${sid}`;
      if (g && Array.isArray(g.muc) && g.muc.includes(iid) && dangHieuLuc(daCo, s)) ra.add(s);
    }
  }
  return [...ra];
}

/**
 * Tiền tố dòng 0 điểm "cổng" THEO MÔN: `moc:tick:<course_id>` — scripts/ghi_moc_diem.py --ap ghi một dòng cho mỗi môn có
 * cờ trong manifest của học sinh, SAU mọi dòng mốc tick:/nhom: (tên này được test_ghi_moc_diem.py đối chiếu với bản Python).
 * Môn chưa có dòng cổng = chưa được "bắt đầu từ 0" → doiChieuTick bỏ qua môn đó. Nhờ vậy deploy Worker trước --ap, hay thêm
 * cờ `diem` cho môn mới rồi để lượt publish tự động lên trước --ap, đều không phát 20 điểm cho mỗi mục đã tick từ trước.
 */
export const KHOA_MOC = "moc:tick:";

/**
 * Đối chiếu tiến độ `items` (tài liệu KV progress) của `user` với manifest → cộng phần còn THIẾU trong sổ. `boTick` = khoá BỎ
 * TICK RÕ RÀNG của lượt POST /api/progress (ADR 0063) → gỡ lượt đang hiệu lực của tick: + nhom: tương ứng (chonGo + huyDiem,
 * bọc an("huy")) TRƯỚC khi chọn phần cộng. Tối đa ba câu D1: đọc các khoá tick:/nhom: đã có (mọi lượt + dòng gỡ
 * huy:tick:/huy:nhom:; cùng câu đó đọc luôn các dòng cổng `moc:tick:<course_id>`), câu gỡ (chỉ khi có gì để gỡ), rồi MỘT câu
 * chèn phần thiếu. Chỉ môn ĐÃ có dòng cổng mới vào chonGo / chonTick. Manifest không có, hoặc không môn nào có cổng →
 * {cong: 0, nhom: [], tru: 0}, không ghi gì.
 */
export async function doiChieuTick(env, url, user, items, boTick = []) {
  const mf = await docManifest(env, url, user);
  if (!mf) return { cong: 0, nhom: [], tru: 0 };
  const co = await env.STUDY_DB.prepare(
    `SELECT khoa FROM diem WHERE user_id = ?1
        AND ((khoa >= ?2 AND khoa < ?3) OR (khoa >= ?4 AND khoa < ?5) OR (khoa >= ?6 AND khoa < ?7)
             OR (khoa >= ?8 AND khoa < ?9) OR (khoa >= ?10 AND khoa < ?11))`
  ).bind(user, ...khoang("tick:"), ...khoang("nhom:"), ...khoang(KHOA_MOC), ...khoang("huy:tick:"), ...khoang("huy:nhom:")).all();
  const daCo = new Set((co.results || []).map((r) => r.khoa));
  const mon = Object.fromEntries(Object.entries(mf.mon).filter(([cid]) => daCo.has(KHOA_MOC + cid)));
  if (!Object.keys(mon).length) return { cong: 0, nhom: [], tru: 0 };
  const mfMo = { ...mf, mon };
  // Bỏ tick RÕ RÀNG (ADR 0063) → gỡ TRƯỚC khi chọn phần cộng. Gỡ hỏng: log diem:huy, tru 0, phần cộng vẫn chạy (sao không
  // tự gỡ bù — bố mẹ thấy dòng còn trong lịch sử và bấm "Gỡ" lại).
  let tru = 0;
  const go = chonGo(mfMo, boTick, user, daCo);
  if (go.length) {
    const h = await an("huy", () => huyDiem(env, user, go), { tru: 0, khoa: [] });
    tru = h.tru || 0;   // huyDiem có thể trả -0 khi không gỡ được gì
    for (const k of h.khoa) daCo.add(k);
  }
  const moi = chonTick(mfMo, items, user, daCo);
  if (!moi.length) return { cong: 0, nhom: [], tru };
  const g = await ghiDiem(env, user, moi);
  const vua = new Set(g.nguon);   // khoá thật có thể là lượt #n — so theo NGUỒN
  return { cong: g.cong, nhom: moi.filter((r) => r.nhom !== undefined && vua.has(r.khoa)).map((r) => r.nhom), tru };
}
// ══ Hết Task 6 ═══════════════════════════════════════════════════════════════

// ══ Điểm bảng lớp (Lớp Ms Dung) — ADR 0068 ═══════════════════════════════════
// Bảng được tick CẢ trong Google Sheet lẫn trên web → đối chiếu (không theo lượt POST) như tick trang môn. Khoá theo
// NỘI DUNG (buổi·môn·nhóm·nhãn) chứ không theo số dòng: bảng lớn dần, chèn/xoá dòng làm số dòng dịch.
export const KHOA_MOC_SHEET = "moc:sheet:";   // cổng "trước hệ điểm" theo bảng — PHẢI khớp bản trong test/route

/** Hàm thuần: mọi đầu mục của mọi buổi → [{dinh, nhan, done, row}]. `dinh` = định danh nội dung (4 trường, ngăn \u0001). */
export function mucSheet(sessions) {
  const ra = [];
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const buoi = String(s?.title || "").trim();
    for (const g of s?.groups || []) {
      const nhom = String(g?.name || "").trim();
      for (const it of g?.items || []) {
        const mon = String(it?.subject || "").trim();
        const ten = String(it?.label || "").trim();
        ra.push({
          dinh: [buoi, mon, nhom, ten].join("\u0001"),
          nhan: (mon ? mon + " · " : "") + (ten || "(không tên)"),
          done: !!it?.done,
          row: it?.row,
        });
      }
    }
  }
  return ra;
}

/** Khoá NGUỒN của một đầu mục: sheet:<slug>:<12 hex đầu SHA-256 của định danh nội dung>. */
export async function khoaSheet(slug, dinh) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(dinh))).subarray(0, 6);
  return `sheet:${slug}:` + [...h].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Hàm thuần: bản sao `sessions` với đúng mục có `row` đổi `done` (để POST suy trạng thái sau khi ghi ô, khỏi đọc lại Sheet). */
export function doiTrangThai(sessions, row, done) {
  return (sessions || []).map((s) => ({ ...s, groups: (s.groups || []).map((g) => ({
    ...g, items: (g.items || []).map((it) => (it.row === row ? { ...it, done } : it)) })) }));
}

/** Hàm thuần: mục (đã có `khoa`) + tập khoá sổ → phần CẦN CỘNG và nguồn CẦN GỠ (như `chonTick` + `chonGo`). */
export function chonSheet(muc, daCo) {
  const done = new Set(muc.filter((x) => x.done).map((x) => x.khoa));
  const go = [], thay = new Set();
  for (const k of daCo) {
    if (k.startsWith("huy:") || k.startsWith("moc:")) continue;
    const s = goc(k);
    if (done.has(s) || thay.has(s)) continue;
    if (dangHieuLuc(daCo, s)) { go.push(s); thay.add(s); }
  }
  const cong = [];
  for (const x of muc) if (x.done && luotKe(daCo, x.khoa)) cong.push({ khoa: x.khoa, diem: DIEM.SHEET, nhan: x.nhan });
  return { go, cong };
}

/**
 * Đối chiếu bảng lớp `sessions` với sổ: cổng lazy, gỡ phần bỏ tick, cộng phần thiếu. Chỉ chạy khi manifest của `user`
 * có `slug` trong `sheet`. → {cong, tru, moc?}. Nơi gọi bọc `an()`.
 */
export async function doiChieuSheet(env, url, user, slug, sessions, now = giay()) {
  if (!USER_RE.test(user || "") || !/^[\w-]{1,64}$/.test(slug || "")) return { cong: 0, tru: 0 };
  const mf = await docManifest(env, url, user);
  if (!mf || !Array.isArray(mf.sheet) || !mf.sheet.includes(slug)) return { cong: 0, tru: 0 };
  const muc = await Promise.all(mucSheet(sessions).map(async (x) => ({ ...x, khoa: await khoaSheet(slug, x.dinh) })));
  const co = await env.STUDY_DB.prepare(
    `SELECT khoa FROM diem WHERE user_id = ?1
        AND ((khoa >= ?2 AND khoa < ?3) OR (khoa >= ?4 AND khoa < ?5) OR khoa = ?6)`
  ).bind(user, ...khoang(`sheet:${slug}:`), ...khoang(`huy:sheet:${slug}:`), KHOA_MOC_SHEET + slug).all();
  const daCo = new Set((co.results || []).map((r) => r.khoa));
  const gate = KHOA_MOC_SHEET + slug;
  if (!daCo.has(gate)) {
    // Cổng lazy: chốt "trước hệ điểm" cho mọi mục đang xong + cổng, MỘT lô, cổng SAU CÙNG.
    const base = muc.filter((x) => x.done).map((x) => ({ khoa: x.khoa, diem: 0, nhan: "trước hệ điểm" }));
    base.push({ khoa: gate, diem: 0, nhan: "trước hệ điểm" });
    await ghiDiem(env, user, base, now);
    return { cong: 0, tru: 0, moc: true };
  }
  const { go, cong: moi } = chonSheet(muc, daCo);
  let tru = 0;
  // `muc.length` = 0 nghĩa là BẢNG ĐỌC RA TRỐNG (parse hỏng / buổi đổi tên / cột trạng thái lệch), không phải "bé bỏ hết
  // tick" — gỡ theo đối chiếu lúc đó là xoá sạch sao (đúng lý do `POST /api/progress` KHÔNG gỡ theo KV rỗng). Không gỡ.
  if (go.length && muc.length) {
    const h = await an("huy", () => huyDiem(env, user, go, now), { tru: 0, khoa: [] });
    tru = h.tru || 0;
    for (const k of h.khoa) daCo.add(k);
  }
  let cong = 0;
  if (moi.length) cong = (await ghiDiem(env, user, moi, now)).cong;
  return { cong, tru };
}

