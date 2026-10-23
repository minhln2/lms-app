/**
 * Điểm thưởng của Ôn tập Toán 6 — luật RIÊNG thay cho luật ôn (ON / ON_NHO) của worker/diem.js với môn `toan-6`
 * (chủ dự án duyệt 2026-10-23, ADR 0070). Số điểm nằm ở `DIEM.TOAN` (worker/diem.js, MỘT chỗ); file này là hàm chọn dòng + đường vào.
 *
 * Luật (mỗi dòng sổ có khoá UNIQUE — "một lần" do khoá bảo đảm, như mọi điểm khác; nguồn S có thể ra lượt S#n sau khi bố mẹ gỡ, ADR 0063):
 *   - BÀI (luyện, Ôn hôm nay, kiểm tra chuyên đề — mọi lượt có id là bài trong kho, KHÔNG phải bước / ô của bài giảng), theo `muc`:
 *       mo-khoa 5/3 · tang-toc 10/5 · chinh-phuc 15/8 · thu-thach 20/10 (đủ g 3 / nửa g 2). g 0 (xem lời giải) và g 1 (sai) = 0.
 *       Mỗi bài cộng tối đa ĐỦ điểm của mức MỘT lần trong đời:  g 3 chưa có điểm → `toan:bai:<id>:du` · g 2 chưa có điểm →
 *       `toan:bai:<id>:nua` · bài đã có NỬA, một lượt g 3 ở NGÀY VN SAU ngày được nửa → `toan:bai:<id>:bu` (đủ − nửa), một lần
 *       (cùng ngày thì không bù, vẫn còn suất bù). Lượt sau khi đã xem lời giải trong ngày ghi g 0 (RB-08) nên không được điểm.
 *   - BÀI GIẢNG: +20 một lần khi xong bài giảng một dạng (`toan:giang:<dạng>`) và +20 một lần khi xong phần Kiến thức của chuyên đề
 *       (`toan:giang:<cd>.kien-thuc`) — "xong" là `daHocDang` / `daHocKienThuc` của toan_muc.js (mọi bước có lượt, cùng định nghĩa 🟡).
 *       Từng bước / ô của bài giảng: 0. Hai đường học cho CÙNG suất: trang chữ ghi lượt từng bước khi con xong bước; trang bài giảng
 *       động ghi lượt MỌI bước của bài lúc con tới màn kết thúc (templates/toan_giang.html `ghiXongBai`) — cùng id bước, cùng khuôn lượt,
 *       nên cùng khoá `toan:giang:*`: học chữ xong thì xem động không cộng thêm, và ngược lại (chủ dự án 2026-10-24; test T5b).
 *   - MỐC: dạng lên 🟢 +20 · 🔵 +40 · ⭐ +60 (`toan:moc:<dạng>:2|3|4`, một lần mỗi mốc mỗi dạng, kể cả tụt rồi lên lại; nhảy
 *       qua nhiều mốc một lượt thì được từng mốc); chuyên đề Đạt +100 (`toan:dat:<cd>`). Mức tính bằng CHÍNH toan_muc.js.
 *
 * Nguồn dữ liệu: cấu trúc chuyên đề / dạng / bài nhúng trong manifest điểm (`mon["toan-6"].toan`, src/toan.py `diem_toan`, builder
 * `_mon_toan`) — cùng khuôn `kho.cd` mà toan_muc.js đọc, thêm `ten` (nhãn dòng lịch sử) và `kt` = {id bài kiểm tra: muc}. Lịch sử làm
 * bài đọc từ bảng `attempt` (khoảng id, đi theo chỉ mục attempt_item) CHỈ của phần lô chạm tới — Worker Free có 10 ms CPU, nên không
 * đọc cả sổ Toán (~3000 lượt) mỗi lần: mốc / bài giảng chỉ tính cho dạng (và phần Kiến thức) mà lô có lượt; "Đạt" chỉ khi dòng tổng kiểm
 * tra mới nhất g 3 và (lô có dòng tổng, hoặc một dạng cơ bản của lô đã ≥ 🟢) — lúc đó mới đọc thêm các dạng còn lại. Lô chỉ có lượt sai /
 * xem lời giải không đọc gì. Ghi sổ lỗi KHÔNG làm hỏng thao tác chính: nơi gọi (study.js) bọc `an()`.
 *
 * Không có cổng "bắt đầu từ 0" (như ôn tập và tập đọc, ADR 0061): điểm chỉ phát sinh lúc route ghi một lượt, và Toán chưa có sổ
 * nào ngoài bản xem thử (không POST). Muốn bật Toán cho học sinh đã có sổ attempt `toan-6` thì phải thêm mốc trước (chưa có việc đó).
 */
import { DIEM, ghiDiem, docManifest, kepTs, ngayVN, luotKe, dangHieuLuc, khoang } from "./diem.js";
import { diemDang, daHocKienThuc, mucChuyenDe, laBuoc } from "./toan_muc.js";

const giay = () => Math.floor(Date.now() / 1000);
const NHAN_MUC = { "mo-khoa": "Mở khoá", "tang-toc": "Tăng tốc", "chinh-phuc": "Chinh phục", "thu-thach": "Thử thách" };
const MUC_ICON = ["⚪", "🟡", "🟢", "🔵", "⭐"];
const MUC_TEN = ["Chưa học", "Đang học", "Làm được", "Thành thạo", "Vững"];
const tiengCD = (id) => String(id).split(".")[0];   // id chuyên đề không có dấu chấm; mọi id con bắt đầu bằng `<cd>.`

/** g thô của lượt → 0..3 (writeSession kẹp lại ở SQL nhưng giữ nguyên số client gửi trong `rows`). */
const kepG = (g) => Math.min(Math.max(Math.trunc(Number(g)) || 0, 0), 3);

/**
 * Tra một id bài → {muc, nhan} hoặc null: bài luyện (`cd.dang[].bai`) hoặc bài kiểm tra chuyên đề (`T.kt`). `nhan` = đầu nhãn
 * "Toán: <chuyên đề> · <dạng | kiểm tra chuyên đề> · bài <Mức>". Bước / ô / câu của bài giảng và dòng tổng không có trong kho bài → null.
 */
export function traBai(T, id) {
  const cd = T && T.cd && T.cd[tiengCD(id)];
  if (!cd) return null;
  const ten = cd.ten || cd.id;
  for (const d of cd.dang || []) {
    const b = (d.bai || []).find((x) => x.id === id);
    if (b) return NHAN_MUC[b.muc] ? { muc: b.muc, nhan: `Toán: ${ten} · ${d.ten || d.id} · bài ${NHAN_MUC[b.muc]}` } : null;
  }
  const m = T.kt && T.kt[id];
  return NHAN_MUC[m] ? { muc: m, nhan: `Toán: ${ten} · kiểm tra chuyên đề · bài ${NHAN_MUC[m]}` } : null;
}

/**
 * Hàm thuần: các lượt của lô (`rows` = [{i, g, t}] như writeSession) → dòng điểm BÀI cần ghi [{khoa: NGUỒN, diem, nhan, ts}].
 * `T` = cấu trúc Toán của manifest; `daCo` = tập khoá sổ đã có (`toan:bai:…` và `huy:toan:bai:…`, kể cả lượt #n); `tsNua` = Map khoá THẬT
 * của dòng nửa → ts của nó (để biết "ngày được nửa"). Duyệt theo mốc đã kẹp (cùng mốc: thứ tự gửi) với trạng thái cục bộ, nên một lô
 * có nhiều lượt của cùng bài (g 2 rồi g 3 cùng ngày) cũng đúng: không bù trong ngày, không cộng đủ hai lần.
 */
export function chonBai(rows, T, daCo, tsNua, now) {
  const co = new Set(daCo);
  const nua = new Map(tsNua);
  const ra = [];
  const ds = rows.map((a, i) => ({ a, i, t: kepTs(a.t, now) })).sort((p, q) => p.t - q.t || p.i - q.i);
  for (const { a, t } of ds) {
    const g = kepG(a.g);
    if (g < 2) continue;
    const b = traBai(T, a.i);
    if (!b) continue;
    const [du, nuaD] = DIEM.TOAN.BAI[b.muc];
    const kDu = `toan:bai:${a.i}:du`, kNua = `toan:bai:${a.i}:nua`, kBu = `toan:bai:${a.i}:bu`;
    if (dangHieuLuc(co, kDu) || dangHieuLuc(co, kBu)) continue;   // đã được ĐỦ điểm của mức — một lần trong đời
    const them = (nguon, diem, nhan) => {
      const k = luotKe(co, nguon);
      if (!k) return null;
      co.add(k);
      ra.push({ khoa: nguon, diem, nhan, ts: t });
      return k;
    };
    const kn = dangHieuLuc(co, kNua);   // khoá THẬT của dòng nửa đang hiệu lực
    if (g === 3) {
      if (!kn) them(kDu, du, b.nhan);
      else if (ngayVN(t) > ngayVN(nua.get(kn) ?? t)) them(kBu, du - nuaD, `${b.nhan} · bù (làm lại không gợi ý)`);
    } else if (!kn) {
      const k = them(kNua, nuaD, `${b.nhan} · có gợi ý`);
      if (k) nua.set(k, t);
    }
  }
  return ra;
}

/**
 * Hàm thuần: bài giảng + mốc của phần lô chạm tới → [{khoa, diem, nhan}]. `viec` = Map id chuyên đề → {dang: Set id dạng có lượt trong lô,
 * kt: lô có bước Kiến thức}; `luot` = lượt làm đã nạp của các phần đó (đã gồm cả lô vừa ghi). Chỉ nguồn CHƯA có lượt hiệu lực trong `daCo`
 * (`luotKe`): nhờ khoá UNIQUE, tính lại ở mọi lô là vô hại — và nếu một lần ghi sổ trước bị lỗi thì lô kế tiếp của dạng đó tự nhặt lại.
 * Dạng nâng cao (`nang_cao`) cũng được điểm bài giảng và mốc.
 */
export function chonMoc(T, viec, luot, now, daCo) {
  const ra = [];
  const them = (khoa, diem, nhan) => { if (luotKe(daCo, khoa)) ra.push({ khoa, diem, nhan }); };
  for (const [cid, v] of viec) {
    const cd = T.cd[cid];
    if (!cd) continue;
    const ten = cd.ten || cid;
    if (v.kt && daHocKienThuc(cd, luot, now)) them(`toan:giang:${cid}.kien-thuc`, DIEM.TOAN.GIANG, `Toán: ${ten} · xong phần Kiến thức`);
    if (!v.dang.size) continue;
    for (const d of diemDang(cd, luot, now, v.dang)) {
      const tenD = (cd.dang.find((x) => x.id === d.id) || {}).ten || d.id;
      if (d.hoc) them(`toan:giang:${d.id}`, DIEM.TOAN.GIANG, `Toán: ${ten} · xong bài giảng ${tenD}`);
      for (let lv = 2; lv <= d.muc; lv++) them(`toan:moc:${d.id}:${lv}`, DIEM.TOAN.MOC[lv], `Toán: ${ten} · ${tenD} · lên ${MUC_ICON[lv]} ${MUC_TEN[lv]}`);
    }
  }
  return ra;
}

/** Hàm thuần: chuyên đề `cid` Đạt (mọi dạng cơ bản ≥ 🟢 + dòng tổng kiểm tra mới nhất đạt — `mucChuyenDe`) mà chưa có điểm → [dòng +100]. */
export function chonDat(T, cid, luot, now, daCo) {
  const cd = T.cd[cid];
  const khoa = `toan:dat:${cid}`;
  if (!cd || !luotKe(daCo, khoa) || !mucChuyenDe(cd, luot, now).dat) return [];
  return [{ khoa, diem: DIEM.TOAN.DAT, nhan: `Toán: ${cd.ten || cid} · đạt chuyên đề` }];
}

/** Khoảng id `attempt` của một tiền tố "<x>." — [x + ".", x + "/"] ('/' ngay sau '.'). */
const idTrong = (x) => [`${x}.`, `${x}/`];

/** Câu đọc lượt làm theo các khoảng id (cùng khuôn `readLuot` của worker/toan.js: dạng {i, c, g, ts, x}, cũ trước mới sau). */
const cauLuot = (db, user, course, kh) => db.prepare(
  `SELECT a.item_id AS i, a.concept_id AS c, a.grade AS g, a.ts, a.chose AS x
     FROM json_each(?3) AS e CROSS JOIN attempt AS a
    WHERE a.user_id = ?1 AND a.course = ?2 AND a.item_id >= json_extract(e.value, '$[0]') AND a.item_id < json_extract(e.value, '$[1]')
    ORDER BY a.ts, a.id`
).bind(user, course, JSON.stringify(kh));

/**
 * Lô lượt Toán của writeSession (`rows` đã lọc: {i, c, g, t, …}) → điểm vừa cộng. Môn không có trong manifest, hoặc manifest không mang
 * cấu trúc Toán (build Toán lỗi / manifest cũ) → 0 (lượt làm vẫn đã ghi). Thường 2 lượt gọi D1 (manifest ở ASSETS, rồi MỘT batch đọc
 * [khoá điểm đã có ‖ lượt làm của phần lô chạm tới], rồi MỘT câu ghi); thêm một câu đọc khi cần xét "Đạt" (xem đầu file).
 */
export async function congToan(env, url, user, course, rows, now = giay()) {
  if (!rows.length) return 0;
  const mf = await docManifest(env, url, user);
  const mon = mf && Object.values(mf.mon).find((m) => m && m.slug === course);
  const T = mon && mon.toan;
  if (!T || typeof T.cd !== "object" || T.cd === null) return 0;
  // Lượt có thể làm điểm tăng: đúng (g ≥ 2) hoặc bước bài giảng (g luôn 3). Sai / xem lời giải không bao giờ cộng gì.
  const co = rows.filter((a) => a && typeof a.i === "string" && (kepG(a.g) >= 2 || laBuoc(a.i)));
  // Phần mỗi chuyên đề mà lô chạm tới: dạng (theo `c` của lượt hoặc tiền tố id), bước Kiến thức, dòng tổng kiểm tra.
  const viec = new Map();
  for (const a of co) {
    const cid = tiengCD(a.i);
    const cd = Object.hasOwn(T.cd, cid) ? T.cd[cid] : null;
    if (!cd) continue;
    if (!viec.has(cid)) viec.set(cid, { dang: new Set(), kt: false, tong: false });
    const v = viec.get(cid);
    if (a.i === `${cid}.kiem-tra`) v.tong = true;
    else if (a.i.startsWith(`${cid}.kien-thuc.`)) v.kt = true;
    for (const d of cd.dang || []) if (a.c === d.id || a.i.startsWith(`${d.id}.`)) v.dang.add(d.id);
  }
  if (!viec.size) return 0;
  const baiIds = [...new Set(co.filter((a) => kepG(a.g) >= 2 && traBai(T, a.i)).map((a) => a.i))];
  // Khoá điểm đã có (cả dòng gỡ `huy:`): từng bài của lô; mốc / bài giảng / đạt của các chuyên đề liên quan.
  const kh = [];
  const tien = [...baiIds.map((id) => `toan:bai:${id}:`), ...[...viec.keys()].flatMap((c) => [`toan:giang:${c}.`, `toan:moc:${c}.`])];
  for (const t of tien) kh.push(khoang(t), khoang("huy:" + t));
  for (const c of viec.keys()) kh.push([`toan:dat:${c}`, `toan:dat:${c}$`], [`huy:toan:dat:${c}`, `huy:toan:dat:${c}$`]);
  // Lượt làm: các dạng bị chạm, bài kiểm tra chuyên đề (mang `c` = dạng), bước Kiến thức, dòng tổng.
  const lk = [];
  for (const [c, v] of viec) {
    for (const d of v.dang) lk.push(idTrong(d));
    if (v.dang.size) lk.push(idTrong(`${c}.kt`));
    if (v.kt) lk.push(idTrong(`${c}.kien-thuc`));
    lk.push([`${c}.kiem-tra`, `${c}.kiem-tra/`]);
  }
  const db = env.STUDY_DB;
  const [dd, ls] = await db.batch([
    db.prepare(
      `SELECT d.khoa, d.ts FROM json_each(?2) AS e CROSS JOIN diem AS d
        WHERE d.user_id = ?1 AND d.khoa >= json_extract(e.value, '$[0]') AND d.khoa < json_extract(e.value, '$[1]')`
    ).bind(user, JSON.stringify(kh)),
    cauLuot(db, user, course, lk),
  ]);
  const daCo = new Set((dd.results || []).map((r) => r.khoa));
  const tsNua = new Map((dd.results || []).map((r) => [r.khoa, r.ts]));
  const luot = ls.results || [];
  const moi = [...chonBai(co, T, daCo, tsNua, now), ...chonMoc(T, viec, luot, now, daCo)];
  // "Đạt": chưa có điểm, dòng tổng mới nhất g 3 (đã đọc ở trên), và lô vừa có dòng tổng hoặc đưa một dạng cơ bản lên ≥ 🟢 → đọc các dạng
  // còn lại của chuyên đề (hiếm: chỉ lượt ngay sau bài kiểm tra đạt) rồi hỏi mucChuyenDe.
  for (const [cid, v] of viec) {
    const tong = luot.findLast((a) => a.i === `${cid}.kiem-tra`);
    if (!tong || tong.g !== 3 || !luotKe(daCo, `toan:dat:${cid}`)) continue;
    const cd = T.cd[cid];
    // VỪA lên 🟢 trong lô này (RD-01) — không phải "đang ≥ 🟢": không thì mọi lô sau bài kiểm tra đạt đều đọc cả chuyên đề.
    const tTruoc = Math.min(...co.filter((a) => tiengCD(a.i) === cid).map((a) => kepTs(a.t, now))) - 1;
    const truoc = new Map(diemDang(cd, luot, tTruoc, v.dang).map((d) => [d.id, d.muc]));
    const lenXanh = diemDang(cd, luot, now, v.dang)
      .some((d) => d.muc >= 2 && (truoc.get(d.id) ?? 0) < 2 && !cd.dang.find((x) => x.id === d.id).nang_cao);
    if (!v.tong && !lenXanh) continue;
    const tat = await cauLuot(db, user, course, [...(cd.dang || []).map((d) => idTrong(d.id)), idTrong(`${cid}.kt`), [`${cid}.kiem-tra`, `${cid}.kiem-tra/`]]).all();
    moi.push(...chonDat(T, cid, tat.results || [], now, daCo));
  }
  return (await ghiDiem(env, user, moi, now)).cong;
}
