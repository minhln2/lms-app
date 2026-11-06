/**
 * Bài tập ESL 5 — chấm, «Con điền» và danh sách Luyện (kế hoạch 2026-11-04-bai-tap-esl-A, Task A3). MỘT bản cho trang ôn tập (nạp bằng
 * import động, builder chép sang dist/assets/ với tên có hash — ADR 0048), khu bố mẹ và Worker. Hàm thuần: chỉ MỘT import (`./muc_ten.js` — bộ nhãn năm mức CHUNG mọi môn; builder viết lại
 * đường import thành tên có hash), KHÔNG đụng DOM, không đọc đồng hồ (mức theo mảng do `mucKt` của worker/bai_tap.js tính — ở đây chỉ cấp `cacCau` làm đầu vào và `nhanMuc` đặt nhãn).
 *
 * Hai bản chuẩn hoá + chấm (Python lúc build `src/bai_tap_esl.py`, JS lúc chấm) chốt bằng tệp mẫu chung `tests/bai_tap_esl_mau.json`
 * (tests/test_bai_tap_esl.py và tests/test_bai_tap_esl_js.mjs cùng đọc) và bằng đối chiếu ngẫu nhiên trong bài JS. Sửa một bản mà quên bản kia
 * thì một trong hai bài đỏ. Regex KHÔNG dùng lookbehind (Safari < 16.4 không nạp nổi cả mô-đun): biên từ ASCII viết bằng nhóm tiền tố.
 *
 * Tài liệu đầu vào là tài liệu DỰNG (`dist/<hs>/study/<slug>.bai-tap.json`, do `src/bai_tap_esl.py › dung()` sinh): {unit: [{luyen: [BAI], de: [DE]}]}.
 *   BAI = {id, kt, kieu, tier, nguon, loai?, tach, cau: [CÂU], …} · CÂU = {id, kt, tier, dap, ly, …} · DE = {id, ma, loai, khuon?, toi_da, phan: [{ten, diem, bai}]}.
 *
 * ── `traLoi` (tl) của MỘT câu, theo kiểu bài ───────────────────────────────────────────────────────────────────────────
 *   abc        "B"                         chữ cái phương án (hoa / thường đều nhận)
 *   hoi_thoai  "E"                         chữ cái câu trong khung A–H
 *   o khung chuoi viet_lai   "does not rain"   chuỗi ô (con gõ, hoặc chọn từ khung)
 *   noi        2                           chỉ số VẾ PHẢI (trong bai.phai) đã nối cho câu (cặp); null / vắng = chưa nối; 0 là một đáp án (không phải «trống»)
 *   sua_loi    {chon: true, sua: "takes"}  cho câu (lỗi k): chon = con đã bấm ĐÚNG chữ sai của lỗi đó, sua = chữ con gõ. Chữ KHÔNG sai con bấm
 *                                          KHÔNG vào tl của câu nào: nằm ở tlBai._nham (mảng chỉ số token trong bai.tu), không chấm, không ghi sổ
 *   sap_xep    [1, 0, 2, 3, 4]             chỉ số mảnh (trong cau.manh) theo THỨ TỰ con xếp; đủ mảnh mới chấm, thiếu = «trống»
 *   viet       "đoạn văn"                  không chấm bằng quy tắc (Gemini nhận xét); ở đây chỉ «trong» / «cho_may», chamDe bỏ qua (0 điểm)
 *   `tlBai` (chamBai) = {[idCâu]: tl, _nham?: number[]}  ·  `tlDe` (chamDe) = {[idCâu]: tl}.
 * Kết quả một câu: "dung" · "sai" · "trong" (chưa làm — ở Luyện không chấm, không ghi sổ; ở đề tính SAI, g 1, x "") · "cho_may" (viet_lai không khớp
 * danh sách chấp nhận, chờ Gemini; chưa có kết luận thì không cộng điểm, không vào `sai`).
 */
import { TEN_MUC } from "./muc_ten.js";

// ═══════════════════════════ Đếm từ ═══════════════════════════

/**
 * Số từ của bài viết = số cụm KHÔNG chứa khoảng trắng (`\S+`) — ĐÚNG phép đếm của bộ đếm «x / min–max từ» ở ② ③ ④ (`beDem` của templates/_bt_esl.html gọi hàm này)
 * VÀ của tiêu chí ĐỘ DÀI do máy quyết ở `/api/cham-viet` chế độ ESL (worker/cham_viet.js import hàm này). MỘT phép đếm cho cả ba nơi: con thấy «180 / 150–250 từ» thì máy
 * chấm cũng đếm 180. Không trim trước (`\S+` không quan tâm), không tách theo dấu câu / dấu gạch nối («well-known» là một từ).
 */
export function demTu(s) {
  return (String(s ?? "").match(/\S+/g) || []).length;
}

// ═══════════════════════════ Chuẩn hoá ═══════════════════════════

/** Dạng rút gọn → đầy đủ. Khoá: chữ thường, nháy thẳng. GIỐNG HỆT `RUT_GON` của src/bai_tap_esl.py (bài JS đối chiếu hai bảng). */
export const RUT_GON = {
  "i'm": "i am", "you're": "you are", "he's": "he is", "she's": "she is", "it's": "it is", "we're": "we are", "they're": "they are",
  "that's": "that is", "there's": "there is", "here's": "here is", "what's": "what is", "who's": "who is", "where's": "where is", "how's": "how is",
  "let's": "let us",
  "i've": "i have", "you've": "you have", "we've": "we have", "they've": "they have",
  "i'll": "i will", "you'll": "you will", "he'll": "he will", "she'll": "she will", "it'll": "it will", "we'll": "we will", "they'll": "they will",
  "isn't": "is not", "aren't": "are not", "wasn't": "was not", "weren't": "were not",
  "don't": "do not", "doesn't": "does not", "didn't": "did not",
  "hasn't": "has not", "haven't": "have not", "hadn't": "had not",
  "won't": "will not", "wouldn't": "would not", "shan't": "shall not", "shouldn't": "should not",
  "can't": "cannot", "couldn't": "could not", "mustn't": "must not", "needn't": "need not",
};

const MA = "A-Za-z0-9_";    // biên từ kiểu ASCII (Python cũng ASCII): không dính chữ / số / «_» hai bên
const THOAT = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// «tiền tố» = đầu chuỗi hoặc một ký tự không thuộc từ (thay cho lookbehind); phần tử đứng sau không được là ký tự thuộc từ
const RE_RUT_GON = new RegExp("(^|[^" + MA + "])(" + Object.keys(RUT_GON).sort((a, b) => b.length - a.length).map(THOAT).join("|") + ")(?![" + MA + "])", "g");
const RE_CAN_NOT = new RegExp("(^|[^" + MA + "])can not(?![" + MA + "])", "g");

/**
 * Chữ → dạng so sánh, đúng thứ tự này (khớp `chuan` của Python):
 *   1 NFC · 2 nháy cong ’ ‘ → '  và  “ ” → " · 3 chữ thường · 4 mọi dãy khoảng trắng (đúng tập `\s` của ECMAScript, Python viết tường minh cho khớp) → một dấu cách, bỏ đầu cuối ·
 *   5 bỏ dấu cách đứng TRƯỚC , . ? ! · 6 bỏ . ! ? và dấu cách ở CUỐI · 7 dạng rút gọn → đầy đủ (RUT_GON, theo biên từ ASCII) · 8 «can not» → «cannot».
 * `whose` KHÔNG là `who is`; `'s` sau danh từ (penguin's) giữ nguyên. null / undefined → "".
 */
export function chuan(s) {
  let t = (s === null || s === undefined ? "" : String(s)).normalize("NFC")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').toLowerCase();
  t = t.replace(/\s+/g, " ").trim();
  t = t.replace(/ ([,.?!])/g, "$1");
  t = t.replace(/[ .!?]+$/, "");
  t = t.replace(RE_RUT_GON, (_m, truoc, tu) => truoc + RUT_GON[tu]);
  return t.replace(RE_CAN_NOT, "$1cannot");
}

// ═══════════════════════════ Chấm một câu ═══════════════════════════

/**
 * Câu VIẾT LẠI (sau trim) ngắn hơn số này KHÔNG bao giờ nhờ Gemini: «no», «ab» không thể là câu hoàn chỉnh nên chấm SAI ngay tại trang (chamCau). CHÍNH hằng số mà
 * worker/cham_lai.js dùng để từ chối chấm — một nguồn, hai nơi cùng đọc; src/bai_tap_esl.py giữ bản sao (LAI_TEXT_MIN) và tests/bai_tap_esl_mau.json chốt chúng khớp nhau.
 * Không để câu ngắn thành «cho_may»: lô /api/cham-lai chứa nó sẽ không bao giờ có kết luận (review cuối I1).
 */
export const LAI_TEXT_MIN = 3;

/**
 * Độ dài câu viết lại để so với LAI_TEXT_MIN / LAI_TEXT_MAX: số CODE POINT sau `trim()` (khoảng trắng của ECMAScript — đúng tập `_KHOANG_CHARS` của src/bai_tap_esl.py, `do_dai_lai`).
 * Không dùng `.length` (đơn vị UTF-16: một emoji = 2) — Python `len` đếm code point, hai bản phải ra cùng con số. null / undefined → 0.
 */
export function doDaiLai(s) {
  return Array.from(s === null || s === undefined ? "" : String(s).trim()).length;
}

/** Chuỗi con gõ đã chuẩn hoá; không phải chuỗi → "". */
const coChu = (tl) => (typeof tl === "string" ? chuan(tl) : "");
const dsDap = (v) => (Array.isArray(v) ? v : []);
const nhanDuoc = (cau) => new Set(dsDap(cau?.dap).map(chuan));

/**
 * Chấm MỘT câu đã dựng → "dung" | "sai" | "trong" | "cho_may". `bai` chỉ cần `bai.kieu`. Không bao giờ ném: tl lạ → "trong" (hoặc "sai" khi rõ ràng sai).
 *   abc / hoi_thoai   so chữ cái sau chuan · o khung chuoi   so với danh sách chấp nhận sau chuan · viet_lai   như trên, không khớp → "cho_may" (trừ khi chữ gõ, sau trim, ngắn hơn LAI_TEXT_MIN: "sai")
 *   noi               tl === cau.dap (chỉ số vế phải) · sua_loi   phải chọn đúng chữ sai VÀ gõ chữ sửa; chọn mà chưa gõ = "trong"
 *   sap_xep           chỉ số trùng / ngoài khoảng → "sai" (xét TRƯỚC khi đếm mảnh thiếu); thiếu mảnh → "trong"; đủ thì ghép chữ rồi so danh sách chấp nhận
 */
export function chamCau(cau, tl, bai) {
  const kieu = bai?.kieu;
  switch (kieu) {
    case "abc":
    case "hoi_thoai": {
      const t = coChu(tl);
      return !t ? "trong" : t === chuan(cau?.dap) ? "dung" : "sai";
    }
    case "o":
    case "khung":
    case "chuoi":
    case "viet_lai": {
      const t = coChu(tl);
      if (!t) return "trong";
      if (nhanDuoc(cau).has(t)) return "dung";
      if (kieu !== "viet_lai") return "sai";
      return doDaiLai(tl) < LAI_TEXT_MIN ? "sai" : "cho_may";     // quá ngắn: không thể là một câu, khỏi nhờ máy
    }
    case "noi":
      if (!Number.isInteger(tl)) return "trong";
      return tl === cau?.dap ? "dung" : "sai";
    case "sua_loi": {
      if (tl === null || typeof tl !== "object" || Array.isArray(tl) || !tl.chon) return "trong";
      const t = coChu(tl.sua);
      if (!t) return "trong";
      return nhanDuoc(cau).has(t) ? "dung" : "sai";
    }
    case "sap_xep": {
      const manh = dsDap(cau?.manh);
      if (!Array.isArray(tl) || !tl.length) return "trong";
      if (tl.some((i) => !Number.isInteger(i) || i < 0 || i >= manh.length) || new Set(tl).size !== tl.length) return "sai";
      if (tl.length < manh.length) return "trong";
      return nhanDuoc(cau).has(chuan(tl.map((i) => manh[i]).join(" "))) ? "dung" : "sai";
    }
    case "viet":
      return coChu(tl) ? "cho_may" : "trong";
    default:
      return "trong";
  }
}

/** Chấm mọi câu của MỘT bài → {[idCâu]: kết quả}, đủ mọi câu, đúng thứ tự trong bài. `tlBai._nham` (chữ không sai con bấm) bị bỏ qua. */
export function chamBai(bai, tlBai) {
  const tl = tlBai !== null && typeof tlBai === "object" ? tlBai : {};
  const ra = {};
  for (const c of bai?.cau || []) ra[c.id] = chamCau(c, tl[c.id], bai);
  return ra;
}

/**
 * Chấm trọn một đề → {phan: [{diem, toi_da}], tong, toi_da, sai: [idCâu], cho: [idCâu], trong: number}.
 *   tlDe = {[idCâu]: tl}. Điểm phần = số câu đúng (mỗi câu 1 điểm); bài `viet` 0 điểm và KHÔNG vào sai / cho / trong (Gemini nhận xét riêng).
 *   Ô TRỐNG = sai (g 1 khi ghi sổ): có trong `sai` VÀ đếm vào `trong` (để giao diện hỏi «còn N ô trống» và ghi x "").
 *   may = {[idCâu]: true | false} = kết luận Gemini cho câu «cho_may»: true cộng 1 điểm, false vào `sai`; thiếu = vẫn chờ (vào `cho`, không cộng, không vào `sai`).
 *   Thứ tự `sai` / `cho`: theo phần rồi theo câu.
 */
export function chamDe(de, tlDe, may = {}) {
  const tl = tlDe !== null && typeof tlDe === "object" ? tlDe : {};
  const ketLuan = may !== null && typeof may === "object" ? may : {};
  const phan = [], sai = [], cho = [];
  let tong = 0, toiDa = 0, trong = 0;
  for (const p of de?.phan || []) {
    const bai = p?.bai;
    const cau = bai?.cau || [];
    if (bai?.kieu === "viet") { phan.push({ diem: 0, toi_da: 0 }); continue; }
    const toi = Number.isInteger(p?.diem) ? p.diem : cau.length;
    let diem = 0;
    for (const c of cau) {
      const kq = chamCau(c, tl[c.id], bai);
      if (kq === "dung") diem++;
      else if (kq === "cho_may") {
        if (ketLuan[c.id] === true) diem++;
        else if (ketLuan[c.id] === false) sai.push(c.id);
        else cho.push(c.id);
      } else {
        sai.push(c.id);
        if (kq === "trong") trong++;
      }
    }
    phan.push({ diem, toi_da: toi });
    tong += diem;
    toiDa += toi;
  }
  return { phan, tong, toi_da: toiDa, sai, cho, trong };
}

/** `g` ghi sổ (0..3): đúng → 3 CHỈ KHI câu chưa từng sai (chủ dự án chốt), đúng sau khi từng sai → 2, sai → 1. `tungSai` = câu đã có lượt g ≤ 1 (sổ + lượt cục bộ). */
export function gCau(dung, tungSai) {
  return dung ? (tungSai ? 2 : 3) : 1;
}

// ═══════════════════════════ «Con điền» ═══════════════════════════

export const X_CAU = 200;

const gon = (s) => String(s).replace(/\s+/g, " ").trim();
const cat = (s) => {
  if (s.length <= X_CAU) return s;
  let t = s.slice(0, X_CAU);
  if (/[\ud800-\udbff]$/.test(t)) t = t.slice(0, -1);     // không cắt đứt một cặp surrogate
  return t;
};

/**
 * Số thứ tự (từ 1) của vế ảnh `x` trong các ảnh của bài `noi` (vế trái rồi vế phải); 0 = không thấy. Dùng cho chữ dự phòng «hình N»
 * của ảnh KHÔNG có `nhan` — con và bố mẹ không bao giờ phải đọc tên tệp ảnh (chữ này đi vào sổ cho bố mẹ và hiện ở ② ④).
 */
export function soHinh(bai, x) {
  const ds = [...dsDap(bai?.trai), ...dsDap(bai?.phai)].filter((v) => v && v.anh);
  let i = ds.indexOf(x);
  if (i < 0 && x && x.anh) i = ds.findIndex((v) => v.anh === x.anh);
  return i + 1;
}

/** Chữ của MỘT vế (chữ → chữ; ảnh có nhãn → «hình a»; ảnh không nhãn → «hình 2» theo thứ tự trong bài). KHÔNG BAO GIỜ trả tên tệp ảnh. */
export function chuVe(x, bai) {
  if (x === null || x === undefined) return "";
  if (x.t !== undefined && x.t !== null) return gon(x.t);
  if (x.nhan) return "hình " + x.nhan;
  if (x.anh) { const n = soHinh(bai, x); return n ? "hình " + n : "hình"; }
  return "";
}

function xTho(cau, tl, bai) {
  switch (bai?.kieu) {
    case "abc": {
      const k = coChu(tl).toUpperCase();
      if (!k) return "";
      const t = dsDap(cau?.lc)[k.charCodeAt(0) - 65];
      return t ? `${k}. ${gon(t)}` : k;
    }
    case "hoi_thoai": {
      const k = coChu(tl).toUpperCase();
      if (!k) return "";
      const m = dsDap(bai?.lc).find((x) => x && x.k === k);
      return m && m.t ? `${k}. ${gon(m.t)}` : k;
    }
    case "o": case "khung": case "chuoi": case "viet_lai": case "viet":
      return typeof tl === "string" ? gon(tl) : "";
    case "noi": {
      if (!Number.isInteger(tl)) return "";
      const phai = chuVe(dsDap(bai?.phai)[tl], bai);
      if (!phai) return "";
      const i = dsDap(bai?.cau).findIndex((c) => c && cau && c.id === cau.id);
      const trai = i >= 0 ? chuVe(dsDap(bai?.trai)[i], bai) : "";
      return trai ? `${trai} → ${phai}` : phai;
    }
    case "sua_loi": {
      if (tl === null || tl === undefined) return "";
      const sua = typeof tl === "object" && tl.chon && typeof tl.sua === "string" ? gon(tl.sua) : "";
      return sua ? `${gon(cau?.sai ?? "")}→${sua}` : "(chưa tìm)";
    }
    case "sap_xep": {
      const manh = dsDap(cau?.manh);
      if (!Array.isArray(tl)) return "";
      return gon(tl.filter((i) => Number.isInteger(i) && i >= 0 && i < manh.length).map((i) => manh[i]).join(" "));
    }
    default:
      return "";
  }
}

/**
 * «Con điền» của MỘT câu (cột `x` của dòng sổ; khu bố mẹ hiện «Con điền: …»), ≤ 200 ký tự (X_CAU), không bao giờ ném.
 *   abc / hoi_thoai: «B. eats» (chữ cái + chữ phương án) · o khung chuoi viet_lai viet: chữ con gõ (gọn khoảng trắng, GIỮ nguyên hoa / nháy) ·
 *   noi: «chick → a partner for life» (ảnh: «hình a»; ảnh không nhãn: «hình 2» theo thứ tự trong bài, KHÔNG BAO GIỜ tên tệp) · sua_loi: «take→takes»; đã làm gì đó mà chưa chọn đúng chữ sai / chưa gõ chữ sửa: «(chưa tìm)» ·
 *   sap_xep: các mảnh theo thứ tự con xếp · chưa làm gì: "".
 */
export function xCau(cau, tl, bai) {
  try {
    return cat(xTho(cau, tl, bai));
  } catch {
    return "";
  }
}

// ═══════════════════════════ Điểm của một lượt nộp đề (kể cả câu chấm muộn) ═══════════════════════════

const docX = (x) => {
  if (x !== null && typeof x === "object") return x;
  try { const o = typeof x === "string" ? JSON.parse(x) : null; return o !== null && typeof o === "object" ? o : null; } catch { return null; }
};

/**
 * Câu chấm MUỘN (Gemini chấm sau lúc nộp, mở lại màn Kết quả) của lượt nộp có dòng tổng `tong` = {t, x}: trong `dong` = [{i, g, x}] (mọi dòng sổ
 * có thể là câu chấm muộn; `x` là chuỗi JSON hoặc đã parse) lấy dòng có `x.lu` == GIỜ NỘP của lượt và id nằm trong `tong.x.cho` (danh sách câu chờ máy lúc nộp).
 * Giờ nộp = `tong.x.tn` (ts trình duyệt lúc nộp, ghi vào chính dòng tổng) — KHÔNG phải `tong.t`: D1 kẹp `ts` của mỗi dòng vào [now − 24 h, now] (`writeSession`), nên khi máy con
 * chạy nhanh giờ hơn máy chủ, hoặc lô nộp nằm trong đệm quá 24 h, `ts` dòng tổng ≠ `lu` của dòng chấm muộn. Dòng tổng CŨ không có `tn` → lùi về `tong.t` (như trước).
 * → Map<idCâu, đúng?>: đúng = có dòng g ≥ 2. Câu chấm muộn SAI có trong Map (đã xong) nhưng cộng 0.
 * Dòng của lượt khác (lu khác), dòng tự luyện ở ② (không có `lu`) và dòng viết (không có `lu`) không bao giờ vào.
 */
export function chamMuon(tong, dong) {
  const ra = new Map();
  for (const r of dongMuon(tong, dong)) ra.set(r.i, ra.get(r.i) === true || (typeof r.g === "number" && r.g >= 2));
  return ra;
}

/** Các dòng của `dong` là câu chấm muộn CỦA LƯỢT `tong`: id ∈ `cho` của dòng tổng và `x.lu` == giờ nộp (tn, không có thì t). → [{i, g, x: đã parse}]; một bộ lọc cho chamMuon và lyMuon. */
function dongMuon(tong, dong) {
  const ra = [];
  const tx = docX(tong?.x);
  if (!tx || !Array.isArray(tx.cho)) return ra;
  const tn = tx.tn === undefined || tx.tn === null || tx.tn === "" ? NaN : Number(tx.tn);
  const t = Number.isFinite(tn) ? tn : Number(tong?.t);
  if (!Number.isFinite(t)) return ra;
  const cho = new Set(tx.cho);
  for (const r of dong || []) {
    if (!r || !cho.has(r.i)) continue;
    const x = docX(r.x);
    if (!x || Number(x.lu) !== t) continue;
    ra.push({ i: r.i, g: r.g, x });
  }
  return ra;
}

/**
 * Lời của MÁY (Gemini) ở câu chấm muộn SAI: dòng muộn ghi lý do vào `x.m.n` (cùng chữ máy con thấy lúc chấm). → Map<idCâu, lời> chỉ cho câu KẾT LUẬN là sai (`chamMuon` = false) và có lời không rỗng;
 * ④ ở máy khác nhận kết luận từ sổ thì nhận cả lời này (không thì hiện lời mẫu của `ly_html`, N3 review A8). Nhiều dòng cùng id: lấy lời không rỗng đầu tiên. Không bao giờ ném.
 */
export function lyMuon(tong, dong) {
  const rs = dongMuon(tong, dong), dung = chamMuon(tong, dong), ra = new Map();
  for (const r of rs) {
    if (dung.get(r.i) !== false || ra.has(r.i)) continue;
    const n = r.x?.m?.n;
    if (typeof n === "string" && n.trim()) ra.set(r.i, n.trim());
  }
  return ra;
}

/**
 * Điểm của MỘT lượt = Σ `x.diem` của dòng tổng (BẤT BIẾN — sổ chỉ thêm, ADR 0061) + số câu chấm muộn ĐÚNG (`chamMuon`; mỗi câu 1 điểm, mỗi id một lần).
 * Dùng chung: ① Bước 2 · ④ · khu bố mẹ. → {d, toi, muon} hoặc null khi dòng tổng không có `diem`.
 */
export function diemLuot(tong, dong) {
  const tx = docX(tong?.x);
  if (!tx || !Array.isArray(tx.diem)) return null;
  let d = 0, toi = 0;
  for (const p of tx.diem) { d += Number(p && p[0]) || 0; toi += Number(p && p[1]) || 0; }
  let muon = 0;
  for (const dung of chamMuon(tong, dong).values()) if (dung) muon++;
  return { d: d + muon, toi, muon };
}

/**
 * Chênh lệch điểm của MỘT câu viết lại chấm LÚC nộp sau khi bố mẹ sửa kết luận (`bt/sua` ghi `x.bm {d, g0}`; dòng tổng của lượt thì bất biến, ADR 0061):
 * kết luận hiện hành (`bm.d`) − kết luận máy lúc nộp (`m.d`; dòng cũ không có `m` thì `g0` ≥ 2). → +1 (máy bác, bố mẹ đánh đạt) · −1 (ngược lại) · 0. `x` không có `bm` / chữ trần / null → 0.
 */
export function chenhBm(x) {
  const o = docX(x);
  if (!o || !o.bm || typeof o.bm !== "object") return 0;
  const goc = o.m && (o.m.d === 1 || o.m.d === 0) ? o.m.d === 1 : Number(o.bm.g0) >= 2;
  return (o.bm.d === 1 ? 1 : 0) - (goc ? 1 : 0);
}

/**
 * Chênh lệch do bố mẹ sửa của các câu viết lại CHẤM LÚC NỘP của lượt `tong` = {t, x}. `dong` = [{i, ts, x}] (mọi dòng câu có x JSON), `vietLai` = Set id câu viết lại CỦA ĐỀ.
 * Dòng của lượt = id ∈ `vietLai`, `ts` == `tong.t` hoặc == `tong.x.tn` (D1 kẹp ts nhưng câu và dòng tổng cùng lô nên cùng ts), KHÔNG có `lu` (câu chấm muộn: `bt/sua` đổi `g` của nó nên `diemLuot` đã đọc đúng).
 * Một câu nhiều dòng → dòng SAU thắng. → Map<idCâu, ±1> chỉ câu có chênh lệch.
 */
export function bmNop(tong, dong, vietLai) {
  const ra = new Map();
  const tx = docX(tong?.x);
  if (!tx || !(vietLai instanceof Set)) return ra;
  const tn = tx.tn === undefined || tx.tn === null || tx.tn === "" ? NaN : Number(tx.tn);
  const ts = [Number(tong?.t), tn].filter(Number.isFinite);
  if (!ts.length) return ra;
  const cuoi = new Map();
  for (const r of dong || []) {
    if (!r || !vietLai.has(r.i) || !ts.includes(Number(r.ts))) continue;
    const x = docX(r.x);
    if (!x || x.lu !== undefined) continue;
    cuoi.set(r.i, x);
  }
  for (const [i, x] of cuoi) { const d = chenhBm(x); if (d) ra.set(i, d); }
  return ra;
}

/**
 * Điểm của MỘT lượt CÓ ÁP SỬA CỦA BỐ MẸ (R46) = `diemLuot` + `bmNop`. MỘT phép tính cho trang con (① Bước 2 «lần N: d/M», ④ tổng) và khu bố mẹ (qtBtEsl) — con và bố mẹ không bao giờ thấy hai điểm khác nhau.
 * ⭐ KHÔNG đổi (sổ `diem` chỉ thêm). → {d, toi, muon, bm, bmCau: Map<idCâu, ±1>} hoặc null khi dòng tổng không có `diem`. `dong` = [{i, g, ts, x}] vừa câu chấm muộn vừa câu chấm lúc nộp.
 * Trên MÁY ĐÃ NỘP, trang con không dùng hàm này cho điểm cục bộ mà chấm lại đề (`chamDe`) với kết luận của máy phủ ĐÚNG hai phép `chamMuon` + `bmNop` (templates/_bt_esl.html `beMayPhu`) — cùng đầu vào, cùng số.
 */
export function diemLuotBm(tong, dong, vietLai) {
  const dl = diemLuot(tong, dong);
  if (!dl) return null;
  const bmCau = bmNop(tong, dong, vietLai);
  let bm = 0;
  for (const d of bmCau.values()) bm += d;
  return { ...dl, d: dl.d + bm, bm, bmCau };
}

// ═══════════════════════════ Mức theo mảng ═══════════════════════════

/**
 * Nhãn của mức 0..4 từ `mucKt` — bộ NĂM nhãn CHUNG mọi môn (worker/muc_ten.js, A9): Chưa học · Đang học · Làm được · Thành thạo · Học bá.
 * Ngoài 0..4 / vắng / không phải số nguyên → «Chưa học».
 */
export function nhanMuc(m) {
  return TEN_MUC[Number.isInteger(m) && m >= 0 && m < TEN_MUC.length ? m : 0];
}

const donVi = (doc) => (Array.isArray(doc?.unit) ? doc.unit : doc && (doc.luyen || doc.de) ? [doc] : []);

/** Mọi câu của `luyen` + `de` → [{id, kt, tier}] — đầu vào `cacY` của `mucKt(luot, cacCau(doc), now)` (worker/bai_tap.js). Câu trong đề tính như câu luyện cùng tier. */
export function cacCau(doc) {
  const ra = [];
  const them = (b) => { for (const c of b?.cau || []) ra.push({ id: c.id, kt: c.kt || b.kt, tier: c.tier || b.tier }); };
  for (const u of donVi(doc)) {
    for (const b of u.luyen || []) them(b);
    for (const d of u.de || []) for (const p of d.phan || []) them(p?.bai);
  }
  return ra;
}

// ═══════════════════════════ Danh sách Luyện + câu sai của đề ═══════════════════════════

/** Câu của ĐỀ có ≥ 1 lượt g ≤ 1 → Set<idCâu>. `luot` = [{i, g, ts}] của một học sinh. Dòng tổng lượt đề, id lạ và câu của Luyện không vào. */
export function cauSaiDe(doc, luot) {
  const deIds = new Set();
  for (const u of donVi(doc)) for (const d of u.de || []) for (const p of d.phan || []) for (const c of p?.bai?.cau || []) deIds.add(c.id);
  const ra = new Set();
  for (const a of luot || []) if (a && deIds.has(a.i) && typeof a.g === "number" && a.g <= 1) ra.add(a.i);
  return ra;
}

/**
 * Bài hiện ở màn Luyện của mảng `kt` → [{bai, chiCau: id[] | null}] (`bai` là chính đối tượng trong tài liệu, không sao chép).
 * Trước: bài `luyen` (loai «goc» trước, «them» sau, giữ thứ tự tệp); sau: bài của ĐỀ có câu trong `saiDe`.
 *   Bài `tach` (câu độc lập: abc sap_xep viet_lai, o / khung dạng cau): xếp theo `kt` của CÂU, `chiCau` = id các câu của mảng này (ở đề: chỉ câu sai).
 *   Bài đoạn chung (o / khung dạng đoạn, noi, chuoi, sua_loi, hoi_thoai, viet): xếp theo `kt` của BÀI, `chiCau` = null (cả bài; ở đề: khi có ≥ 1 câu sai).
 * `saiDe`: Set hoặc mảng id (null / vắng = chỉ phần luyen). Mảng không có bài → [].
 */
export function luyenCua(doc, kt, saiDe) {
  const sai = saiDe instanceof Set ? saiDe : new Set(saiDe || []);
  const units = donVi(doc);
  const luyen = units.flatMap((u) => u.luyen || []);
  const ra = [];
  const nhat = (b, chap, caBai) => {
    if (b?.tach) {
      const ids = (b.cau || []).filter((c) => chap(c) && (c.kt || b.kt) === kt).map((c) => c.id);
      if (ids.length) ra.push({ bai: b, chiCau: ids });
    } else if (b && b.kt === kt && caBai(b)) {
      ra.push({ bai: b, chiCau: null });
    }
  };
  for (const b of [...luyen.filter((x) => x.loai === "goc"), ...luyen.filter((x) => x.loai !== "goc")]) nhat(b, () => true, () => true);
  if (sai.size) {
    for (const u of units) for (const d of u.de || []) for (const p of d.phan || []) nhat(p?.bai, (c) => sai.has(c.id), (b) => (b.cau || []).some((c) => sai.has(c.id)));
  }
  return ra;
}

/**
 * Đề «mới cùng cấu trúc» kế tiếp của đề gốc `maGoc`: các đề `loai == "moi"` có `khuon == maGoc` (thứ tự tệp), lấy lần lượt theo `soLuotMoi % số đề mới`
 * (hết thì quay vòng). `soLuotMoi` = số lượt đã nộp các đề mới của khuôn đó. Không có đề mới → null.
 */
export function deMoiKe(doc, maGoc, soLuotMoi) {
  const ds = donVi(doc).flatMap((u) => u.de || []).filter((d) => d.loai === "moi" && d.khuon === maGoc);
  if (!ds.length) return null;
  const n = Math.floor(Number(soLuotMoi));
  return ds[Number.isFinite(n) && n > 0 ? n % ds.length : 0];
}
