/**
 * Tập đọc: tiến độ + quiz (D1), bản thu âm (R2). Spec 2026-10-02 §8.
 *
 * MỌI đường dẫn đòi mã bí mật, kể cả GET: tiến độ cho biết đứa trẻ đọc tới đâu và
 * sai câu nào; bản thu là giọng của nó. Cùng lý do /api/study/stats bị khoá.
 *
 * Bốn mốc "lần đầu" — start_ts, read_ts, dung_ts, xong_ts — chỉ ghi MỘT lần (COALESCE giữ giá
 * trị cũ). Điểm thưởng (ADR 0061, worker/diem.js) cộng ĐÚNG lượt read_ts / dung_ts / xong_ts chuyển NULL → có —
 * phát hiện bằng hàng đọc TRƯỚC khi ghi (`cu`, câu SELECT đầu batch quiz, `truoc`). Gọi theo cờ trình duyệt (`xong:true`
 * gửi lại mỗi lần mở truyện đã xong) là cộng cho việc làm trước hệ điểm. Mỗi route trả thêm `cong`.
 *
 * Truyện nào tồn tại, có mấy câu / trang (bố cục), đáp án đúng là gì: đọc từ file tĩnh qua ASSETS
 * (chính những file trang đang tải) — không tin số liệu trình duyệt gửi lên.
 *
 * Vị trí lưu theo MÃ CÂU (spec 2026-10-03 §6): td_truyen.vi_tri; da_thay không dùng nữa (ADR 0060 — cột còn, không
 * đọc / ghi). start_ts = "Đang đọc", read_ts = "Đọc xong" (cần start_ts + vi_tri ở trang cuối). Nhật ký lật của bản
 * thu `[[ms, mã câu]]` được ánh xạ sang trang của bố cục HIỆN HÀNH (tdAnhLat) rồi mới áp luật.
 */
import { TD, tdHoanThanh, tdAnhLat } from "./td_luat.js";
import { khoGhi, khoDoc, khoDau, khoLietCo, khoXoa } from "./kho.js";
import { an, congDoc, congQuiz, congThuam } from "./diem.js";

const USER_RE = /^[\w-]{1,32}$/;
const ID_RE = /^[a-z0-9-]{1,48}$/;
// Dạng CHUẨN, không số 0 đứng đầu: "07" và "7" là hai khoá R2 khác nhau cho cùng một
// đoạn — lọt vào thì phép cộng byte và phép dọn theo ts/n đếm sai.
const DOAN_RE = /^([1-9]\d{9,13})-(0|[1-9]\d?)$/;
const LOAI_RE = /^audio\/(mp4|webm|ogg)$/;

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

async function tinh(env, url, path) {
  const r = await env.ASSETS.fetch(new Request(new URL(path, url)));
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

async function kiemUser(env, url, user) {
  if (!USER_RE.test(user || "")) throw sai("Thiếu hoặc sai 'user'");
  const cm = await tinh(env, url, "/tap-doc/index.json");
  if (!cm || !(cm.hoc_sinh || []).includes(user)) throw sai("Học sinh này không có mục Tập đọc", 404);
  return cm;
}

function kiemTruyen(cm, id) {
  if (!ID_RE.test(id || "")) throw sai("Thiếu hoặc sai 'truyen'");
  const t = (cm.truyen || []).find((x) => x.id === id);
  if (!t) throw sai("Không có truyện này", 404);
  return t;
}

const mang = (s) => { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; } };
const giay = () => Math.floor(Date.now() / 1000);
// ts do đồng hồ của máy thu đặt. Máy chạy quá xa về tương lai thì bản đó là "mới nhất" mãi
// mãi: mọi bản sau, từ máy nào, đều 409 — truyện bị khoá, chỉ sửa tay D1 mới gỡ được.
// Cho lệch tối đa 1 ngày.
const tsTuongLai = (ts) => ts > Date.now() + 86400000;

async function docTrangThai(env, user) {
  const db = env.STUDY_DB;
  const [a, b, c] = await db.batch([
    db.prepare(`SELECT truyen, vi_tri, start_ts, read_ts, ts FROM td_truyen WHERE user_id = ?1`).bind(user),
    db.prepare(`SELECT truyen, cau, dung, lan FROM td_quiz WHERE user_id = ?1`).bind(user),
    db.prepare(`SELECT truyen, ts, dai, doan, lat, xong FROM td_thuam WHERE user_id = ?1`).bind(user),
  ]);
  const out = {};
  const o = (id) => (out[id] ??= { vi_tri: 0, ts: 0, bat_dau: false, doc_xong: false, quiz: {}, thu: null });
  for (const r of a.results || []) {
    // read_ts có mà start_ts NULL: hàng trước ADR 0060 chưa điền mốc — đọc xong thì đương nhiên đã bắt đầu.
    Object.assign(o(r.truyen), { vi_tri: r.vi_tri, ts: r.ts, bat_dau: r.start_ts != null || r.read_ts != null,
                                 doc_xong: r.read_ts != null });
  }
  for (const r of b.results || []) o(r.truyen).quiz[r.cau] = { dung: r.dung, lan: r.lan };
  for (const r of c.results || []) {
    o(r.truyen).thu = { ts: r.ts, dai: r.dai, doan: mang(r.doan), lat: mang(r.lat), xong: !!r.xong };
  }
  return { truyen: out };
}

async function ghiTrangThai(env, user, t, body) {
  // Số câu và bố cục lấy từ index tĩnh, không tin trình duyệt.
  const n = t.so_cau;
  if (!Number.isInteger(n) || n < 1) throw sai("Không đọc được truyện", 500);
  const viTri = Number.isInteger(body.vi_tri) ? Math.min(n - 1, Math.max(0, body.vi_tri)) : 0;
  const d = Array.isArray(t.trang_dau) && t.trang_dau.length ? t.trang_dau : [0];
  const db = env.STUDY_DB;
  const cu = await db.prepare(`SELECT start_ts, read_ts FROM td_truyen WHERE user_id = ?1 AND truyen = ?2`)
    .bind(user, t.id).first();
  const now = giay();
  const daBatDau = !!(cu && (cu.start_ts != null || cu.read_ts != null));
  const batDau = body.bat_dau === true ? now : null;
  // Đọc xong (ADR 0060): đã bắt đầu (trước đó hay CHÍNH lượt này) và vị trí ở trang cuối. Không đạt → bỏ cờ, không lỗi:
  // tab mở từ trước bản này vẫn gửi xong theo luật cũ.
  const xong = body.xong === true && (daBatDau || batDau != null) && viTri >= d[d.length - 1] ? now : null;
  // start_ts chưa có mà read_ts có (hàng đọc xong trước ADR 0060, chưa điền mốc): nhận read_ts, KHÔNG nhận "bây giờ" —
  // đã đọc xong thì không thể bắt đầu muộn hơn, và start_ts ghi MỘT lần nên mốc sai không sửa được nữa.
  await db.prepare(
    `INSERT INTO td_truyen (user_id, truyen, vi_tri, start_ts, read_ts, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (user_id, truyen) DO UPDATE SET
       vi_tri = excluded.vi_tri,
       start_ts = COALESCE(td_truyen.start_ts, td_truyen.read_ts, excluded.start_ts),
       read_ts = COALESCE(td_truyen.read_ts, excluded.read_ts), ts = excluded.ts`
  ).bind(user, t.id, viTri, batDau, xong, now).run();
  const docXong = (cu && cu.read_ts != null) || xong != null;
  // Điểm: CHỈ lượt làm read_ts chuyển NULL → có. Sổ hỏng → 0, tiến độ vẫn đã ghi.
  const cong = !(cu && cu.read_ts != null) && xong != null ? await an("doc", () => congDoc(env, user, t)) : 0;
  return { ok: true, bat_dau: daBatDau || batDau != null || docXong, doc_xong: docXong, cong };
}

async function ghiQuiz(env, url, user, t, traLoi) {
  const tr = await tinh(env, url, `/tap-doc/truyen/${t.id}.json`);
  if (!tr || !Array.isArray(tr.quiz)) throw sai("Không đọc được truyện", 500);
  const hang = [];
  for (const [k, v] of Object.entries(traLoi && typeof traLoi === "object" ? traLoi : {})) {
    const c = Number(k);
    // Chỉ nhận khoá dạng chuẩn: "0" và "00" cùng trỏ câu 0, nhận cả hai là đếm trùng một câu.
    if (!/^(0|[1-9]\d*)$/.test(k) || c >= tr.quiz.length || !Number.isInteger(v)) throw sai("Câu trả lời không hợp lệ");
    hang.push([c, v === tr.quiz[c].dung ? 1 : 0]);
  }
  if (!hang.length) throw sai("Thiếu 'tra_loi'");
  const db = env.STUDY_DB;
  const now = giay();
  const kq = await db.batch([
    // Câu đã đúng TRƯỚC lượt này (đọc trong CÙNG giao dịch, trước các câu ghi) — để biết câu nào dung_ts NULL → có.
    db.prepare(`SELECT cau FROM td_quiz WHERE user_id = ?1 AND truyen = ?2 AND dung_ts IS NOT NULL`).bind(user, t.id),
    ...hang.map(([c, d]) => db.prepare(
      `INSERT INTO td_quiz (user_id, truyen, cau, dung, dung_ts, lan)
       VALUES (?1, ?2, ?3, ?4, CASE WHEN ?4 = 1 THEN ?5 END, 1)
       ON CONFLICT (user_id, truyen, cau) DO UPDATE SET
         dung = excluded.dung, dung_ts = COALESCE(td_quiz.dung_ts, excluded.dung_ts), lan = td_quiz.lan + 1`
    ).bind(user, t.id, c, d, now)),
    db.prepare(`SELECT COALESCE(SUM(dung), 0) AS d FROM td_quiz WHERE user_id = ?1 AND truyen = ?2`).bind(user, t.id),
  ]);
  // Điểm: câu đúng ở lượt này mà trước đó chưa từng đúng. `cong` là TỔNG điểm (không nói câu nào).
  const daDung = new Set((kq[0].results || []).map((r) => r.cau));
  const moi = hang.filter(([c, d]) => d === 1 && !daDung.has(c)).map(([c]) => c);
  const cong = moi.length ? await an("quiz", () => congQuiz(env, user, t, moi)) : 0;
  // CHỈ trả tổng. Câu nào sai thì trang biết qua GET state để hỏi lại, không hiển thị.
  return { dung: kq[kq.length - 1].results[0].d, tong: tr.quiz.length, cong };
}

/** ts của bản đã chốt cho (học sinh, truyện); null = chưa chốt bản nào. */
async function tsDaChot(env, user, id) {
  const r = await env.STUDY_DB.prepare(`SELECT ts FROM td_thuam WHERE user_id = ?1 AND truyen = ?2`)
    .bind(user, id).first();
  return r ? r.ts : null;
}

/** Các đoạn thu dưới tiền tố → [{khoa, ts, n, size}]. Khoá sai mẫu thì bỏ qua, không đụng tới. */
async function lietDoan(env, tienTo) {
  return (await khoLietCo(env, tienTo)).flatMap(({ khoa, size }) => {
    const m = DOAN_RE.exec(khoa.slice(tienTo.length));
    return m ? [{ khoa, ts: Number(m[1]), n: Number(m[2]), size: size || 0 }] : [];
  });
}

// Trần dung lượng R2 của một truyện ≈ bản đã chốt + MỘT bản đang thu (mỗi bản ≤ 20 MB):
//   - không ghi vào ts ≤ bản đã chốt (bản đã chốt không bị sửa tại chỗ);
//   - tổng các đoạn cùng ts ≤ 20 MB ngay lúc PUT, không đợi tới lúc chốt;
//   - PUT một ts thì dọn các đoạn CHƯA CHỐT của ts cũ hơn (lượt thu bỏ dở).
async function ghiDoan(request, env, user, t, ts, n) {
  const loai = (request.headers.get("content-type") || "").split(";")[0].trim();
  if (!LOAI_RE.test(loai)) throw sai("Loại file không hỗ trợ");
  if (Number(request.headers.get("content-length") || 0) > TD.BYTE_MAX) throw sai("Đoạn thu quá lớn", 413);
  // Cùng khoảng với lúc chốt (0–98): đoạn PUT được thì phải chốt được.
  if (n > 98) throw sai("Số đoạn vượt 98");
  if (tsTuongLai(ts)) throw sai("Giờ trên máy đang chạy sai (quá xa về tương lai)");
  const chot = await tsDaChot(env, user, t.id);
  if (chot != null && ts <= chot) throw sai("Bản thu này đã chốt — hãy thu bản mới", 409);
  const than = await request.arrayBuffer();
  if (!than.byteLength) throw sai("Đoạn thu rỗng");
  if (than.byteLength > TD.BYTE_MAX) throw sai("Đoạn thu quá lớn", 413);
  const tienTo = `thu-am/${user}/${t.id}/`;
  const doan = await lietDoan(env, tienTo);
  let tong = than.byteLength;
  for (const d of doan) if (d.ts === ts && d.n !== n) tong += d.size;   // đoạn đang ghi đè: không cộng bản cũ
  if (tong > TD.BYTE_MAX) throw sai("Bản thu vượt 20 MB", 413);
  await khoGhi(env, `${tienTo}${ts}-${n}`, than, loai);
  // Đọc LẠI bản đã chốt ngay trước khi xoá: trong lúc tải thân lên, thiết bị khác có
  // thể vừa chốt một bản ts nằm giữa — `chot` đọc từ đầu đã cũ, dùng nó là xoá mất
  // bản vừa chốt.
  const chotMoi = await tsDaChot(env, user, t.id);
  await khoXoa(env, doan.filter((d) => d.ts < ts && d.ts !== chotMoi && d.ts !== chot).map((d) => d.khoa));
  return { ok: true, byte: than.byteLength };
}

async function chotBanThu(env, url, user, t, body) {
  const tienTo = `thu-am/${user}/${t.id}/`;
  const ts = body.ts;
  if (!Number.isInteger(ts) || !DOAN_RE.test(`${ts}-0`)) throw sai("Thiếu hoặc sai 'ts'");
  if (tsTuongLai(ts)) throw sai("Giờ trên máy đang chạy sai (quá xa về tương lai)");
  const doan = Array.isArray(body.doan) ? body.doan : [];
  if (!doan.length || doan.length > 99) throw sai("Thiếu 'doan'");
  // Bản cũ hơn bản đang giữ (thiết bị khác chốt muộn) → từ chối: ghi vào là D1 trỏ
  // về bản cũ, còn phép dọn bên dưới thì xoá mất bản mới. Cùng ts = thử lại, cho qua.
  const cu = await tsDaChot(env, user, t.id);
  if (cu != null && ts < cu) throw sai("Đã có bản thu mới hơn", 409);
  let dai = 0, byte = 0;
  const giu = new Set(), sach = [], soN = new Set();
  for (const d of doan) {
    if (!d || !Number.isInteger(d.n) || d.n < 0 || d.n > 98 || !Number.isInteger(d.dai) || d.dai <= 0) {
      throw sai("Đoạn thu sai định dạng");
    }
    // Một đoạn khai hai lần → từ chối (không tự gộp): cộng trùng thời lượng.
    if (soN.has(d.n)) throw sai(`Đoạn ${d.n} khai hai lần`);
    soN.add(d.n);
    const khoa = `${tienTo}${ts}-${d.n}`;
    const h = await khoDau(env, khoa);
    if (!h) throw sai(`Chưa nhận được đoạn ${d.n}`, 409);
    byte += h.size;
    dai += d.dai;
    giu.add(khoa);
    sach.push({ n: d.n, dai: d.dai, loai: h.httpMetadata?.contentType || "audio/webm" });
  }
  if (byte > TD.BYTE_MAX) throw sai("Bản thu vượt 20 MB", 413);
  // Dư 5 s: thời lượng do trình duyệt khai và làm tròn theo từng đoạn.
  if (dai > TD.DAI_MAX + 5000) throw sai("Bản thu vượt 30 phút", 413);
  const tr = await tinh(env, url, `/tap-doc/truyen/${t.id}.json`);
  if (!tr || !Array.isArray(tr.trang) || !tr.trang.length) throw sai("Không đọc được truyện", 500);
  // Nhật ký theo MÃ CÂU: giữ mục đúng hình (cả mã câu lạ — bố cục sau còn ánh xạ lại được).
  const lat = (Array.isArray(body.lat) ? body.lat : [])
    .filter((x) => Array.isArray(x) && Number.isFinite(x[0]) && Number.isInteger(x[1]) && x[1] >= 0)
    .slice(0, 2000)
    .map((x) => [Math.round(x[0]), x[1]]);
  // Tự tính "hoàn thành" — KHÔNG đọc body.xong. Ánh xạ câu → trang của bố cục HIỆN HÀNH rồi áp luật cũ.
  const kq = tdHoanThanh(tdAnhLat(lat, tr.trang), dai, tr.trang.length, tr.dai_ms);
  const db = env.STUDY_DB;
  // Giữ dòng cũ (hoặc biết là chưa có) để trả lại nguyên trạng nếu đoạn mất giữa chừng.
  const truoc = await db.prepare(
    `SELECT ts, dai, doan, lat, xong, xong_ts FROM td_thuam WHERE user_id = ?1 AND truyen = ?2`
  ).bind(user, t.id).first();
  await db.prepare(
    `INSERT INTO td_thuam (user_id, truyen, ts, dai, doan, lat, xong, xong_ts)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CASE WHEN ?7 = 1 THEN ?8 END)
     ON CONFLICT (user_id, truyen) DO UPDATE SET
       ts = excluded.ts, dai = excluded.dai, doan = excluded.doan, lat = excluded.lat,
       xong = excluded.xong, xong_ts = COALESCE(td_thuam.xong_ts, excluded.xong_ts)
     WHERE excluded.ts >= td_thuam.ts`
  ).bind(user, t.id, ts, dai, JSON.stringify(sach), JSON.stringify(lat), kq.xong ? 1 : 0, giay()).run();
  // Chốt WHERE chặn (thiết bị khác vừa chốt bản mới hơn) → không ghi gì, không dọn.
  if ((await tsDaChot(env, user, t.id)) !== ts) throw sai("Đã có bản thu mới hơn", 409);
  // Kiểm LẠI các đoạn giữ: giữa lúc head ở trên và lúc ghi D1, một PUT bản mới hơn có
  // thể đã dọn chúng (lúc đó bản này còn chưa chốt). Mất đoạn nào → trả D1 về nguyên
  // trạng, không dọn, 409 — đừng để D1 trỏ vào audio đã xoá.
  for (const khoa of giu) {
    if (await khoDau(env, khoa)) continue;
    if (truoc) {
      await db.prepare(
        `UPDATE td_thuam SET ts = ?3, dai = ?4, doan = ?5, lat = ?6, xong = ?7, xong_ts = ?8
         WHERE user_id = ?1 AND truyen = ?2 AND ts = ?9`
      ).bind(user, t.id, truoc.ts, truoc.dai, truoc.doan, truoc.lat, truoc.xong, truoc.xong_ts, ts).run();
    } else {
      await db.prepare(`DELETE FROM td_thuam WHERE user_id = ?1 AND truyen = ?2 AND ts = ?3`)
        .bind(user, t.id, ts).run();
    }
    throw sai("Bản thu đã bị thay trong lúc chốt", 409);
  }
  // Điểm: bản này hoàn thành và trước đó chưa có bản nào hoàn thành (xong_ts NULL → có). Cấp D: congThuam trả 0.
  // Cộng TRƯỚC khi dọn R2: bản đã chốt trong D1, nên R2 lỗi lúc dọn (route trả lỗi) cũng không được làm mất điểm —
  // thử lại sau đó thấy xong_ts đã có và không cộng nữa.
  const cong = kq.xong && !(truoc && truoc.xong_ts != null) ? await an("thuam", () => congThuam(env, user, t)) : 0;
  // Dọn SAU khi đã ghi DB: đoạn của bản cũ và đoạn gửi dở không được chốt — chỉ những
  // đoạn ts ≤ bản vừa chốt. Đoạn ts lớn hơn là của lượt thu khác đang dở: để yên.
  await khoXoa(env, (await lietDoan(env, tienTo)).filter((d) => d.ts <= ts && !giu.has(d.khoa)).map((d) => d.khoa));
  return { ok: true, dai, ...kq, cong };
}

export async function handleTapdoc(request, env, url) {
  const secret = env.LMS_SECRET || "";
  if (!secret) return json({ error: "Chưa cấu hình LMS_SECRET" }, 503);
  if ((request.headers.get("x-progress-key") || "") !== secret) {
    return json({ error: "Mã bí mật không đúng" }, 401);
  }
  const p = url.pathname.slice("/api/tapdoc/".length).split("/").map((x) => {
    try { return decodeURIComponent(x); } catch { return "\u0000"; }
  });
  const m = request.method;
  try {
    if (p[0] === "rec") {
      if (!env.KHO) return json({ error: "Chưa cấu hình KHO (R2)" }, 503);
      if (!env.STUDY_DB) return json({ error: "Chưa cấu hình STUDY_DB" }, 503);
      if (p.length !== 3 && p.length !== 4) return json({ error: "Không có đường dẫn này" }, 404);
      const cm = await kiemUser(env, url, p[1]);
      const t = kiemTruyen(cm, p[2]);
      if (p.length === 3) {
        if (m !== "POST") return json({ error: "Method không hỗ trợ" }, 405);
        let body;
        try { body = await request.json(); } catch { throw sai("Body không hợp lệ"); }
        return json(await chotBanThu(env, url, p[1], t, body || {}));
      }
      const md = DOAN_RE.exec(p[3]);
      if (!md) throw sai("Tên đoạn không hợp lệ");
      const khoa = `thu-am/${p[1]}/${t.id}/${p[3]}`;
      if (m === "PUT") return json(await ghiDoan(request, env, p[1], t, Number(md[1]), Number(md[2])));
      if (m === "GET") {
        const o = await khoDoc(env, khoa);
        if (!o) return json({ error: "Không có đoạn thu này" }, 404);
        return new Response(o.body, {
          headers: { "content-type": o.httpMetadata?.contentType || "application/octet-stream",
                     "cache-control": "private, no-store" },
        });
      }
      return json({ error: "Method không hỗ trợ" }, 405);
    }

    if (!env.STUDY_DB) return json({ error: "Chưa cấu hình STUDY_DB" }, 503);
    if (p.length === 1 && p[0] === "state" && m === "GET") {
      const user = url.searchParams.get("user") || "";
      await kiemUser(env, url, user);
      return json(await docTrangThai(env, user));
    }
    if (p.length === 1 && (p[0] === "state" || p[0] === "quiz") && m === "POST") {
      let body;
      try { body = await request.json(); } catch { throw sai("Body không hợp lệ"); }
      body = body || {};
      const cm = await kiemUser(env, url, body.user);
      const t = kiemTruyen(cm, body.truyen);
      return json(p[0] === "state" ? await ghiTrangThai(env, body.user, t, body)
                                   : await ghiQuiz(env, url, body.user, t, body.tra_loi));
    }
    return json({ error: "Không có đường dẫn này" }, 404);
  } catch (e) {
    if (e.status && e.status < 500) return json({ error: e.message }, e.status);
    // Lỗi máy chủ: chi tiết (câu lỗi D1, khoá R2) chỉ vào log, không ra thân trả lời.
    console.error("tapdoc:", e);
    return json({ error: "Lỗi máy chủ" }, 500);
  }
}
