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
 * File này cũng chạy bằng node (scripts/ghi_moc_diem.py gọi `chonTick`): không import gì, không dùng API riêng của
 * Worker ngoài `crypto.subtle` / `crypto.randomUUID` / `btoa` / `atob` (node ≥ 20 có sẵn).
 */

export const DIEM = {
  DOC: { A: 30, B: 40, C: 50, D: 60 },   // đọc xong truyện — theo cấp
  THUAM: { A: 30, B: 40, C: 50 },        // thu âm hoàn thành = điểm đọc cùng cấp; cấp D không thu âm (ADR 0059)
  QUIZ: 10,                              // mỗi câu quiz tập đọc đúng LẦN ĐẦU
  TICK: 20,                              // tick một mục ở trang môn (tay hoặc tự tick)
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
 * Khoá đã có (kể cả trùng ngay trong lô) bị bỏ qua. → {cong: tổng điểm các dòng VỪA vào, khoa: [khoá vừa vào]}.
 */
export async function ghiDiem(env, user, dong, now = giay()) {
  if (!dong.length) return { cong: 0, khoa: [] };
  const payload = JSON.stringify(dong.map((r) => ({ k: r.khoa, d: r.diem, n: r.nhan ?? null, t: r.ts ?? null })));
  const r = await env.STUDY_DB.prepare(
    `INSERT OR IGNORE INTO diem (user_id, khoa, diem, nhan, ts)
     SELECT ?1, json_extract(e.value,'$.k'), json_extract(e.value,'$.d'), json_extract(e.value,'$.n'),
            COALESCE(json_extract(e.value,'$.t'), ?2)
       FROM json_each(?3) AS e
     RETURNING khoa, diem`
  ).bind(user, now, payload).all();
  const vao = r.results || [];
  return { cong: vao.reduce((s, x) => s + x.diem, 0), khoa: vao.map((x) => x.khoa) };
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

/**
 * `n` dòng gần nhất, mới nhất trước; dòng 0 điểm (ghi mốc) không hiện. Ôn tập (mỗi lượt một dòng `on:<thẻ>:<ngày>:<k>`,
 * hàng trăm dòng mỗi tối) GỘP thành MỘT dòng mỗi ngày VN — khoa `on:<ngày>`, diem = tổng, nhan "Ôn tập", ts = lượt muộn
 * nhất — để không đẩy dòng đọc truyện / tick ra khỏi `n` dòng. Ngày = đoạn thứ 3 của khoá (mã thẻ không có ":").
 */
export async function lichSu(env, user, n = LICH_SU) {
  const [on0, on1] = khoang("on:");
  const r = await env.STUDY_DB.prepare(
    `SELECT khoa, diem, nhan, ts FROM (
       SELECT khoa, diem, nhan, ts, id FROM diem
        WHERE user_id = ?1 AND diem != 0 AND NOT (khoa >= ?3 AND khoa < ?4)
       UNION ALL
       SELECT 'on:' || substr(khoa, instr(substr(khoa, 4), ':') + 4, 10) AS ngay, SUM(diem), 'Ôn tập', MAX(ts), MAX(id)
         FROM diem WHERE user_id = ?1 AND khoa >= ?3 AND khoa < ?4
        GROUP BY ngay HAVING SUM(diem) != 0
     ) ORDER BY ts DESC, id DESC LIMIT ?2`
  ).bind(user, n, on0, on1).all();
  return (r.results || []).map((x) => ({ khoa: x.khoa, diem: x.diem, nhan: x.nhan, ts: x.ts }));
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
// ba lượt đầu, còn khoá :k của nó thì đã bị máy kia chiếm).
const ON_SO = [...Array.from({ length: DIEM.ON_LUOT }, (_, k) => String(k + 1)), "nho"];

/** Mọi khoá ôn tập mà các lượt `rows` có thể đụng tới — để đọc MỘT lần những khoá đã có. */
export function khoaOn(rows, now) {
  const s = new Set();
  for (const a of rows) {
    const g = `on:${a.i}:${ngayVN(kepTs(a.t, now))}:`;
    for (const k of ON_SO) s.add(g + k);
  }
  return [...s];
}

/**
 * Hàm thuần: duyệt các lượt theo mốc (đã kẹp; cùng mốc giữ thứ tự gửi). Lượt được tính lấy khoá :k nhỏ nhất còn trống
 * (k ≤ ON_LUOT) → +1; lượt nhớ / đúng (`ok`) đầu tiên trong số lượt được tính lấy thêm :nho nếu chưa có → +2. Lượt không
 * còn :k thì bỏ (kể cả đúng). → [{khoa, diem, nhan, ts}].
 */
export function chonOn(rows, daCo, now, nhan = "Ôn tập") {
  const co = new Set(daCo);
  const ra = [];
  const ds = rows.map((a, i) => ({ a, i, t: kepTs(a.t, now) })).sort((p, q) => p.t - q.t || p.i - q.i);
  for (const { a, t } of ds) {
    const g = `on:${a.i}:${ngayVN(t)}:`;
    let k = 1;
    while (k <= DIEM.ON_LUOT && co.has(g + k)) k++;
    if (k > DIEM.ON_LUOT) continue;
    co.add(g + k);
    ra.push({ khoa: g + k, diem: DIEM.ON, nhan, ts: t });
    if (a.ok && !co.has(g + "nho")) {
      co.add(g + "nho");
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
  const co = await env.STUDY_DB.prepare(
    `SELECT khoa FROM diem WHERE user_id = ?1 AND khoa IN (SELECT value FROM json_each(?2))`
  ).bind(user, JSON.stringify(khoaOn(rows, now))).all();
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
 * Bỏ khoá đã có trong `daCo`. → [{khoa, diem, nhan, nhom?}] — `nhom` = tên section (trang môn bật "hoàn thành <section>").
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
      if (kv(iid) && !daCo.has(khoa)) ra.push({ khoa, diem: DIEM.TICK, nhan: `${mon.ten || cid} · ${muc[iid]}` });
    }
    for (const [sid, g] of Object.entries(mon.nhom || {})) {
      const khoa = `nhom:${cid}/${sid}`;
      const ds = g && Array.isArray(g.muc) ? g.muc : [];
      if (ds.length && ds.every(xong) && !daCo.has(khoa)) {
        ra.push({ khoa, diem: DIEM.NHOM, nhan: `${mon.ten || cid} · hoàn thành ${g.ten || sid}`, nhom: g.ten || sid });
      }
    }
  }
  return ra;
}

/**
 * Tiền tố dòng 0 điểm "cổng" THEO MÔN: `moc:tick:<course_id>` — scripts/ghi_moc_diem.py --ap ghi một dòng cho mỗi môn có
 * cờ trong manifest của học sinh, SAU mọi dòng mốc tick:/nhom: (tên này được test_ghi_moc_diem.py đối chiếu với bản Python).
 * Môn chưa có dòng cổng = chưa được "bắt đầu từ 0" → doiChieuTick bỏ qua môn đó. Nhờ vậy deploy Worker trước --ap, hay thêm
 * cờ `diem` cho môn mới rồi để lượt publish tự động lên trước --ap, đều không phát 20 điểm cho mỗi mục đã tick từ trước.
 */
export const KHOA_MOC = "moc:tick:";

/**
 * Đối chiếu tiến độ `items` (tài liệu KV progress) của `user` với manifest → cộng phần còn THIẾU trong sổ.
 * Hai câu D1 tối đa: đọc các khoá tick:/nhom: đã có (cùng câu đó đọc luôn các dòng cổng `moc:tick:<course_id>`), rồi MỘT
 * câu chèn phần thiếu (lượt bình thường: 0–vài dòng). Chỉ môn ĐÃ có dòng cổng mới vào chonTick. Manifest không có, hoặc
 * không môn nào có cổng → {cong: 0, nhom: []}, không ghi gì.
 */
export async function doiChieuTick(env, url, user, items) {
  const mf = await docManifest(env, url, user);
  if (!mf) return { cong: 0, nhom: [] };
  const co = await env.STUDY_DB.prepare(
    `SELECT khoa FROM diem WHERE user_id = ?1
        AND ((khoa >= ?2 AND khoa < ?3) OR (khoa >= ?4 AND khoa < ?5) OR (khoa >= ?6 AND khoa < ?7))`
  ).bind(user, ...khoang("tick:"), ...khoang("nhom:"), ...khoang(KHOA_MOC)).all();
  const daCo = new Set((co.results || []).map((r) => r.khoa));
  const mon = Object.fromEntries(Object.entries(mf.mon).filter(([cid]) => daCo.has(KHOA_MOC + cid)));
  if (!Object.keys(mon).length) return { cong: 0, nhom: [] };
  const moi = chonTick({ ...mf, mon }, items, user, daCo);
  if (!moi.length) return { cong: 0, nhom: [] };
  const g = await ghiDiem(env, user, moi);
  const vua = new Set(g.khoa);
  return { cong: g.cong, nhom: moi.filter((r) => r.nhom !== undefined && vua.has(r.khoa)).map((r) => r.nhom) };
}
// ══ Hết Task 6 ═══════════════════════════════════════════════════════════════
