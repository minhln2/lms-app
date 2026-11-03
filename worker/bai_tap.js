/**
 * Bài tập Math 5 — chấm trên trình duyệt + mức thành thạo theo kiến thức (plan 2026-11-02-bai-tap-math5-3-1, Task 2).
 * MỘT bản cho trang ôn tập (nạp bằng <script type="module">, builder chép sang dist/assets/ với tên có hash — ADR 0048) và khu bố mẹ
 * / Worker. Hàm thuần, KHÔNG đụng DOM, không đọc đồng hồ (mọi hàm nhận `now` = epoch giây). Chỉ import toan_cham.js để đọc số và
 * đơn vị (builder viết lại đường import đó thành tên có hash — đừng thêm chỗ thứ hai nhắc tới tệp ấy trong dấu nháy kép).
 *
 * Số học là HỮU TỈ CHÍNH XÁC bằng BigInt ({n, d} tối giản, d > 0), không bao giờ so số thực: mean / trung vị của số thập phân (12.7…)
 * ra đúng chuỗi mà `src/bai_tap.py` ra. Hai bản (Python lúc build, JS lúc chấm) chốt bằng tệp mẫu chung `tests/bai_tap_mau.json`
 * (tests/test_bai_tap.py và tests/test_bai_tap_js.mjs cùng đọc).
 *
 * Tài liệu đầu vào là tài liệu DỰNG (`dist/<hs>/study/<slug>.bai-tap.json`, do `src/bai_tap.py › dung()` sinh). Hình dạng từng ý `y`:
 *   o        y.o[]   = {id "o0".., dap, don_vi?, don_vi_in?, kt, goi_y?}   goi_y: true = ô của dòng GỢI Ý (y.goi_y_manh): chamY bỏ qua, chamGoiY chấm
 *   bang     y.o[]   = {id "r0c1".., dap, don_vi?, don_vi_in?, kt, hang, cot}   (don_vi_in = đơn vị in sẵn cạnh ô: xem chamO)
 *   noi      y.trai[] = {t, kt} · y.phai[] = {t} · y.ghep = [[chỉ số trái, chỉ số phải]]
 *   chon     y.dap · y.ly_do? = {lua_chon, dap}
 *   tick     y.cau[] = {t, dung}          dung_sai  y.cau[] = {t, dung, kt}
 *   the      y.chon · y.dk · (thẻ số nằm ở BAI.the_so — truyền `bai` cho chamY)     day   y.n? · y.dk
 *   viet     y.tu_kiem[]
 *   Mọi ý có y.nhom = [{id, kt}] — mỗi nhóm là MỘT item ghi sổ (id "b.xxxxxxxx").
 *
 * ── `traLoi` của chamY(y, traLoi, bai), theo kiểu ý ────────────────────────────────────────────────────────────────────
 *   o         {[oId]: string}                  chữ con gõ trong từng ô ("5,5", "9 kg"; ô mode có thể là "none")
 *   bang      {[cellId]: string}               cellId "r<hàng>c<cột>"
 *   noi       {[chỉ số trái]: chỉ số phải}     object hoặc mảng; ô chưa nối vắng mặt (hoặc null)
 *   chon      {dap: string, ly_do?: string}    mã phương án `k`; `ly_do` chỉ cần khi y có `ly_do`
 *   tick      boolean[]                        theo thứ tự y.cau (chưa tick = false)
 *   dung_sai  (boolean|null)[]                 theo thứ tự y.cau; null/vắng = chưa chọn Đúng hay Sai → chấm sai
 *   the       number[]                         chỉ số các thẻ đã chọn trong BAI.the_so (thứ tự tuỳ ý) — cần `bai`
 *   day       string                           dãy số con gõ ("119, 131; 132 135")
 *   viet      {tick: boolean[]}                các câu tự kiểm đã tick, theo thứ tự y.tu_kiem
 * Chưa trả lời → "sai", không bao giờ ném lỗi. Kết quả: {[idNhom]: "dung" | "sai" | "cach_viet"}.
 */
import { cham, docSo } from "./toan_cham.js";

export const TEN_MUC = ["Chưa làm", "Đang học", "Làm được", "Thành thạo", "Vững"];

// ═══════════════════════════ Số hữu tỉ chính xác ═══════════════════════════

const DK_KHOA = ["mean", "median", "range", "tong", "n", "mode"];
const SO_CHUOI = /^[0-9]{1,20}(?:\.[0-9]{1,20})?$/;
const LON = 10n ** 9n;

const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
/** {n, d} tối giản; n ≥ 0n, d > 0n. */
const fr = (n, d = 1n) => { const g = gcd(n, d); return { n: n / g, d: d / g }; };
const laFr = (x) => x !== null && typeof x === "object" && typeof x.n === "bigint" && typeof x.d === "bigint";
const cmp = (a, b) => { const l = a.n * b.d, r = b.n * a.d; return l < r ? -1 : l > r ? 1 : 0; };
const bang = (a, b) => a.n * b.d === b.n * a.d;
const cong = (a, b) => fr(a.n * b.d + b.n * a.d, a.d * b.d);
const tru = (a, b) => fr(a.n * b.d - b.n * a.d, a.d * b.d);   // a ≥ b

/**
 * Số vào → {n, d}. Nhận chuỗi `"12.7"` (dấu chấm), số JSON, hoặc {n, d} BigInt (số con gõ đã đọc — không giới hạn chữ số thập phân).
 * Chuỗi / số JSON: không âm, ≤ 2 chữ số thập phân, như `so_fr` của Python; sai thì ném (đây là lỗi nội dung, không phải đáp án của con).
 */
function soFr(x, ten = "số") {
  if (laFr(x)) return x;
  let t;
  if (typeof x === "number") {
    if (!Number.isFinite(x)) throw new RangeError(`${ten}: ${x} không phải số hữu hạn`);
    t = String(x);
  } else if (typeof x === "string") {
    t = x.trim();
  } else {
    throw new TypeError(`${ten}: cần số, nhận ${x === null ? "null" : typeof x}`);
  }
  if (!SO_CHUOI.test(t)) throw new RangeError(`${ten}: ${JSON.stringify(x)} không phải số (nhận dạng 12 hoặc 12.7, dấu chấm, không âm)`);
  const [ng, le = ""] = t.split(".");
  if (le.length > 2 && /[1-9]/.test(le.slice(2))) throw new RangeError(`${ten}: ${JSON.stringify(x)} có quá 2 chữ số thập phân`);
  const v = fr(BigInt(ng + le), 10n ** BigInt(le.length));
  if (v.n > LON * v.d) throw new RangeError(`${ten}: ${JSON.stringify(x)} quá lớn`);
  return v;
}

/** {n, d} → chuỗi chuẩn ("5.5", "12", "0.05") hoặc null nếu không phải số thập phân đúng ≤ 2 chữ số (13.0333…, 0.375). Giống `so_str`. */
function soStr(r) {
  const v100 = r.n * 100n;
  if (v100 % r.d !== 0n) return null;
  const v = v100 / r.d;
  const q = v / 100n, c = v % 100n;
  if (c === 0n) return String(q);
  return `${q}.${String(c).padStart(2, "0").replace(/0$/, "")}`;
}

function dsFr(so, ten = "so") {
  if (!Array.isArray(so)) throw new TypeError(`${ten}: phải là danh sách số`);
  return so.map((x, i) => soFr(x, `${ten}[${i}]`));
}

/** Thống kê chính xác của tập {n, d}[] (không rỗng). `mode`: danh sách tăng dần, [] = không có mốt (không giá trị nào lặp lại). */
function tkFr(xs) {
  if (!xs.length) throw new RangeError("so: tập số rỗng");
  const s = [...xs].sort(cmp);
  const m = s.length;
  const tong = xs.reduce(cong, fr(0n));
  const dem = fr(BigInt(m));
  const lan = new Map();
  for (const x of s) { const k = `${x.n}/${x.d}`; lan.set(k, (lan.get(k) || 0) + 1); }
  const cao = Math.max(...lan.values());
  const mode = cao < 2 ? [] : s.filter((x, i) => (i === 0 || !bang(x, s[i - 1])) && lan.get(`${x.n}/${x.d}`) === cao);
  return {
    tong, dem,
    mean: fr(tong.n, tong.d * BigInt(m)),
    median: m % 2 ? s[(m - 1) / 2] : (() => { const t = cong(s[m / 2 - 1], s[m / 2]); return fr(t.n, t.d * 2n); })(),
    mode,
    range: tru(s[m - 1], s[0]),
    max: s[m - 1], min: s[0],
  };
}

/**
 * Thống kê của một tập số (chuỗi `"12.7"` hoặc số JSON; không âm, ≤ 2 chữ số thập phân; không rỗng — không thì ném).
 * Trả {tong, dem, mean, median, mode, range, max, min}: mọi giá trị là CHUỖI chuẩn hoá (`"5.5"`, `"12"`) giống `so_str` của Python,
 * `mode` là danh sách chuỗi tăng dần ([] = không có mốt). Thống kê không phải số thập phân đúng ≤ 2 chữ số (mean = 13.0333…,
 * trung vị 0.375) là `null` — Python không có chuỗi cho nó (`so_str` ném), nên tệp mẫu để VẮNG khoá đó.
 */
export function thongKe(so) {
  const tk = tkFr(dsFr(so));
  const ra = {};
  for (const k of ["tong", "dem", "mean", "median"]) ra[k] = soStr(tk[k]);
  ra.mode = tk.mode.map(soStr);
  for (const k of ["range", "max", "min"]) ra[k] = soStr(tk[k]);
  return ra;
}

/**
 * Từng điều kiện của `dk` đạt hay không → {khoá: bool}. So CHÍNH XÁC (13.0333… không bằng "13.03"). `dk`: khoá tuỳ chọn trong
 * mean median range tong n (số) và mode (danh sách số; [] = không có mốt; so như TẬP, không phụ thuộc thứ tự). Khoá lạ thì ném.
 * `so` nhận cả {n, d} BigInt (số con gõ).
 */
export function dat(so, dk) {
  if (dk === null || typeof dk !== "object") throw new TypeError("dk: phải là object");
  const tk = tkFr(dsFr(so));
  const ra = {};
  for (const [k, v] of Object.entries(dk)) {
    if (!DK_KHOA.includes(k)) throw new RangeError(`dk: khoá lạ ${JSON.stringify(k)} (có: ${DK_KHOA.join(", ")})`);
    if (k === "mode") {
      if (!Array.isArray(v)) throw new TypeError("dk.mode: phải là danh sách số ([] = không có mốt)");
      const want = v.map((x, i) => soFr(x, `dk.mode[${i}]`)).sort(cmp);
      ra.mode = want.length === tk.mode.length && want.every((x, i) => bang(x, tk.mode[i]));
    } else {
      ra[k] = bang(k === "n" ? tk.dem : tk[k], soFr(v, `dk.${k}`));
    }
  }
  return ra;
}

// ═══════════════════════════ Chấm một ô số ═══════════════════════════

const TIEN_TO = ["$", "£", "€"];   // đơn vị in TRƯỚC ô (`don_vi_in` của src/bai_tap.py); mọi đơn vị khác là hậu tố
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Bỏ đơn vị `dv` khỏi chữ con gõ cho ô NHIỀU giá trị ("4 cm, 5 cm" → "4, 5"; "$4; $5" → "4; 5") → {chu, co} (co = có bỏ được ít nhất một chỗ).
 * Hậu tố: chỉ khi dính ngay sau một số và không phải đầu một chữ dài hơn (đơn vị `m` không ăn `mm`); không phân biệt hoa thường;
 * đơn vị `m²` nhận cả `m2` / `m^2`. Không dùng lookbehind (Safari < 16.4 chết cả module vì lỗi cú pháp).
 */
function boDonViNhieu(g, dv, tienTo) {
  if (tienTo) {
    const chu = g.replace(new RegExp(esc(dv) + "\\s*(?=[0-9])", "g"), "");
    return { chu, co: chu !== g };
  }
  const mau = esc(dv).replace(/²/g, "(?:²|\\^?2)").replace(/³/g, "(?:³|\\^?3)");
  const chu = g.replace(new RegExp(`([0-9])\\s*${mau}(?![\\p{L}0-9²³])`, "giu"), "$1");
  return { chu, co: chu !== g };
}

/**
 * Chấm MỘT ô số. `o` = {dap, don_vi?, don_vi_in?} (ô của ý `o` / `bang`); `go` = chữ con gõ → {kq, ly?}:
 *   kq "dung" · "sai" · "cach_viet" (chưa đúng cách viết — KHÔNG tính là sai). `ly` (chỉ khi cach_viet): "thieu_don_vi" · "so_kem_chu" · "khac".
 * Bọc `cham({dap, kieu: "so", don_vi}, go)` của toan_cham.js: `5,5` = `5.5`; `9kg` = `9 kg`; số 9 mà ô đòi đơn vị (`o.don_vi`) thì
 * "cach_viet"/"thieu_don_vi" (toan_cham tự nó cho qua khi thiếu đơn vị — ở đây ô đòi đơn vị thì phải có; số SAI mà thiếu đơn vị vẫn là "sai").
 * `o.don_vi_in` (đơn vị ĐÃ IN cạnh ô, chỉ có khi ô không có `don_vi`) là TUỲ CHỌN: nhận số đứng một mình HOẶC kèm đúng đơn vị đó, đơn vị khác
 * là "cach_viet". Hậu tố (`cm` `kg` `s` `°C` `years` `puppies`…): `5` · `5 cm` · `5cm` · `5 CM`, giống toan_cham. Tiền tố (`$` `£` `€`, in TRƯỚC ô):
 * `61` · `$61` · `$ 61`; ký hiệu tiền khác (`£61` ở ô `$`) là "cach_viet".
 * Chưa gõ gì → "sai". `dap` = "none" (không có mốt): chỉ chữ `none` mới đúng (nút "không có mốt" đặt "none"; KHÔNG bao giờ nhận đơn vị); gõ số vào ô đó,
 * hay "none" vào ô có mốt → "sai".
 * `dap` nhiều mốt ("4; 5"): gõ cách nhau `;` hoặc `,` hoặc dấu cách hoặc `and` / `&`, thứ tự tuỳ ý (`5, 4` = `4 and 5` = `4; 5`). Có `;` thì dấu `,` vẫn là
 * dấu thập phân. Đơn vị gõ theo từng số hay một lần ở cuối đều được (`4 cm, 5 cm` · `4, 5 cm`).
 * Không có `;` mà có dấu phẩy thì NHẬP NHẰNG (dấu ngăn hay dấu thập phân?) nên thử cả hai cách đọc (xem `cachDocNhieu`): "dung" nếu MỘT cách đọc khớp
 * (`1,2, 1,8` = `1,2 1,8` = `1.2, 1.8` = `1,2; 1,8` cho 1.2 và 1.8). Không cách nào khớp: nếu mọi cách đọc đều đọc được thì "sai", còn có cách không
 * đọc được (vd `1,2,1,8`) thì "cach_viet" — không tính sai một đáp số có thể đúng.
 */
export function chamO(o, go) {
  const dap = String(o.dap);
  const g = typeof go === "string" ? go.trim() : typeof go === "number" ? String(go) : "";
  if (!g) return { kq: "sai" };
  const none = g.toLowerCase() === "none";
  if (dap === "none") return { kq: none ? "dung" : "sai" };
  if (none) return { kq: "sai" };
  const cac = dap.split(";").map((t) => t.trim());
  const dvBat = o.don_vi || null;                                                    // đơn vị BẮT BUỘC con phải gõ
  const dvIn = !dvBat && typeof o.don_vi_in === "string" && o.don_vi_in ? o.don_vi_in : null;   // đơn vị đã in: gõ hay không đều được
  const tienTo = dvIn !== null && TIEN_TO.includes(dvIn);
  const bai = { dap: cac, kieu: "so" };
  let kqs, coDv = false;
  if (cac.length > 1) {
    let chu = g;
    if (dvBat || dvIn) ({ chu, co: coDv } = boDonViNhieu(g, dvBat || dvIn, tienTo));
    kqs = cachDocNhieu(chu).map((nhap) => ({ nhap, r: cham(bai, nhap) }));
  } else {
    let chu = g;
    if (tienTo) chu = g.replace(new RegExp("^" + esc(dvIn) + "\\s*"), "");
    else if (dvBat || dvIn) bai.don_vi = dvBat || dvIn;
    kqs = [{ nhap: chu, r: cham(bai, chu) }];
  }
  const dung = kqs.find((x) => x.r.kq === "dung");
  if (dung) {
    if (dvBat && (cac.length > 1 ? !coDv : cham({ dap: cac, kieu: "so" }, dung.nhap).kq === "dung")) return { kq: "cach_viet", ly: "thieu_don_vi" };   // đúng số, chưa ghi đơn vị
    return { kq: "dung" };
  }
  if (kqs.every((x) => x.r.kq === "sai")) return { kq: "sai" };
  const hong = kqs.find((x) => x.r.kq === "cach_viet") || kqs[0];
  return hong.r.ly ? { kq: hong.r.kq, ly: hong.r.ly } : { kq: hong.r.kq };
}

/**
 * Các cách đọc chữ con gõ `g` (đã trim) cho ô NHIỀU mốt, mỗi cách đã đổi thành dạng `a; b` mà toan_cham đọc được. Bỏ dấu ngăn thừa ở hai đầu.
 * `and` / `&` là dấu ngăn như dấu phẩy ("4 and 5", "4 & 5"; có `;` trong chữ thì thành `;`, không thì thành `, ` để còn đọc được hai cách).
 *   có `;`            → một cách: các dấu phẩy là dấu thập phân ("1,2; 1,8")
 *   không có `;`      → (a) mọi dấu phẩy và dấu cách đều là dấu ngăn ("5,4" = 5 và 4; "1.2, 1.8"; "5 4")
 *                       (b) chỉ ", " hoặc dấu cách là dấu ngăn, dấu phẩy sát số là dấu thập phân ("1,2, 1,8"; "1,2 1,8")
 */
function cachDocNhieu(g) {
  const va = g.includes(";") ? "; " : ", ";
  const sach = g.replace(/\s*(?:\band\b|&)\s*/gi, va).replace(/^[\s,;]+|[\s,;]+$/g, "");
  if (sach.includes(";")) return [sach];
  const a = sach.replace(/\s*,\s*|\s+/g, "; ");
  const b = sach.replace(/,?\s+/g, "; ");
  return a === b ? [a] : [a, b];
}

// ═══════════════════════════ Chấm cả ý ═══════════════════════════

const MAX_SO_GO = 60;   // dãy số con gõ dài hơn thì không phải một đáp án — chặn sớm

/** Chữ con gõ cho ý `day` → các cách đọc ({n, d}[][]) đọc được hết; [] nếu không cách nào đọc được. Dấu phẩy có thể là dấu ngăn hoặc dấu thập phân. */
function docDay(go) {
  const t = typeof go === "string" ? go.trim() : "";
  const doc = (ds) => {
    if (!ds.length || ds.length > MAX_SO_GO) return null;
    const ra = [];
    for (const s of ds) {
      const v = /^[0-9]+(?:[.,][0-9]+)?$/.test(s) ? docSo(s) : null;
      if (!v) return null;
      ra.push(v);
    }
    return ra;
  };
  const cach = [t.split(/[;,\s]+/).filter(Boolean)];   // mọi dấu phẩy / chấm phẩy / cách là dấu ngăn: "5, 6; 7"
  if (t.includes(";")) cach.push(t.split(";").map((s) => s.trim()).filter(Boolean));   // dấu phẩy là dấu thập phân: "5,5; 6"
  else if (/\s/.test(t)) cach.push(t.split(/\s+/));                                       // "5,5 6,5"
  else cach.push([t]);                                                                     // một số "5,5"
  return cach.map(doc).filter(Boolean);
}

const gop = (kqs) => (kqs.includes("cach_viet") ? "cach_viet" : kqs.includes("sai") ? "sai" : kqs.length ? "dung" : "sai");
const idx = (tl, i) => {   // tl[i] của object hoặc mảng → số nguyên, hoặc -1 nếu chưa có
  const v = tl == null ? null : tl[i];
  if (v === null || v === undefined || v === "") return -1;
  const n = Number(v);
  return Number.isInteger(n) ? n : -1;
};

/**
 * Chọn chưa ĐÚNG số thẻ (ý `the`)? true khi thiếu, thừa, có chỉ số trùng, hoặc chỉ số không phải số nguyên (chuỗi "0", 1.5, NaN…). Trang nhắc con
 * chọn đúng `y.chon` thẻ khác nhau và KHÔNG chấm, không ghi sổ. `traLoi` = chỉ số thẻ đã chọn (số nguyên).
 */
export function chuaDuThe(y, traLoi) {
  if (!Array.isArray(traLoi) || !traLoi.every((i) => Number.isInteger(i))) return true;
  return traLoi.length !== y.chon || new Set(traLoi).size !== y.chon;
}

/**
 * Nối một cặp trái–phải. Trả `traLoi` MỚI (không sửa bản cũ): nối lại một ô đã nối thì GỠ cặp cũ của ô đó (ở cả hai phía).
 * traLoi dạng {[chỉ số trái]: chỉ số phải}.
 */
export function noiCap(traLoi, trai, phai) {
  const ra = {};
  for (const [k, v] of Object.entries(traLoi || {})) {
    if (Number(k) !== trai && Number(v) !== phai && v !== null && v !== undefined) ra[k] = v;
  }
  ra[trai] = phai;
  return ra;
}

/** Từng mục chấm của một ý → [{kt, kq}] (kt = kiến thức của mục). */
function mucCham(y, tl, bai) {
  switch (y.kieu) {
    case "o":
    case "bang":
      // Ô của dòng GỢI Ý (`goi_y: true`, chỉ hiện sau "💡 Gợi ý") KHÔNG vào nhóm: bỏ trống / sai / chưa đúng cách viết cũng không đổi kết quả
      return (y.o || []).filter((c) => !c.goi_y).map((c) => ({ kt: c.kt, kq: chamO(c, tl?.[c.id]).kq }));
    case "noi": {
      const dich = new Map((y.ghep || []).map(([i, j]) => [i, j]));
      return (y.trai || []).map((t, i) => ({ kt: t.kt ?? y.kt, kq: idx(tl, i) === dich.get(i) ? "dung" : "sai" }));
    }
    case "chon": {
      const ok = tl?.dap === y.dap && (!y.ly_do || tl?.ly_do === y.ly_do.dap);
      return [{ kt: y.kt, kq: ok ? "dung" : "sai" }];
    }
    case "tick":
      return [{ kt: y.kt, kq: (y.cau || []).every((c, i) => !!tl?.[i] === c.dung) ? "dung" : "sai" }];
    case "dung_sai":
      return (y.cau || []).map((c, i) => ({ kt: c.kt ?? y.kt, kq: tl?.[i] === c.dung ? "dung" : "sai" }));
    case "the": {
      if (!bai || !Array.isArray(bai.the_so)) throw new TypeError("chamY: ý kiểu `the` cần tham số thứ ba `bai` có `the_so`");
      const cs = Array.isArray(tl) ? tl : [];
      const hopLe = cs.length === y.chon && new Set(cs).size === cs.length && cs.every((i) => Number.isInteger(i) && i >= 0 && i < bai.the_so.length);
      const ok = hopLe && Object.values(dat(cs.map((i) => bai.the_so[i]), y.dk)).every(Boolean);
      return [{ kt: y.kt, kq: ok ? "dung" : "sai" }];
    }
    case "day": {
      if (typeof tl !== "string" || !tl.trim()) return [{ kt: y.kt, kq: "sai" }];
      const cach = docDay(tl);
      if (!cach.length) return [{ kt: y.kt, kq: "cach_viet" }];
      const ok = cach.some((xs) => (y.n == null || xs.length === y.n) && Object.values(dat(xs, y.dk)).every(Boolean));
      return [{ kt: y.kt, kq: ok ? "dung" : "sai" }];
    }
    case "viet": {
      const tick = tl?.tick;
      const ok = Array.isArray(tick) && (y.tu_kiem || []).length > 0 && y.tu_kiem.every((_, i) => tick[i] === true);
      return [{ kt: y.kt, kq: ok ? "dung" : "sai" }];
    }
    default:
      throw new RangeError(`chamY: kiểu ý lạ ${JSON.stringify(y.kieu)}`);
  }
}

/**
 * Chấm cả ý theo `kieu` → {[idNhom]: "dung" | "sai" | "cach_viet"}, một phần tử cho MỖI nhóm của `y.nhom` (nhóm = item ghi sổ).
 * Ô / câu / cặp được gom theo kiến thức `kt` của chúng vào nhóm cùng `kt`: nhóm "dung" khi mọi mục của nó đúng; có mục "cach_viet"
 * thì cả nhóm là "cach_viet" (chưa chấm sai — trang nhắc viết lại, KHÔNG ghi sổ); không thì có mục sai là "sai".
 * `traLoi`: xem đầu tệp. `bai` (BAI chứa ý, cần `the_so`) chỉ bắt buộc cho kiểu `the`. Chưa trả lời → "sai", không ném.
 * Ném chỉ khi lập trình sai (ý không có `nhom`, kiểu lạ, thiếu `bai` cho `the`).
 */
export function chamY(y, traLoi, bai) {
  if (!y || !Array.isArray(y.nhom)) throw new TypeError("chamY: ý thiếu `nhom` (tài liệu chưa qua bai_tap.dung)");
  const muc = mucCham(y, traLoi ?? null, bai);
  const ra = {};
  for (const n of y.nhom) ra[n.id] = gop(muc.filter((m) => m.kt === n.kt).map((m) => m.kq));
  return ra;
}

/**
 * Chấm riêng các ô của dòng GỢI Ý (`y.o[]` có `goi_y: true`; kiểu `o`, hiện sau "💡 Gợi ý") để trang tô màu → {[idÔ]: "dung" | "sai" | "cach_viet"}.
 * CHỈ để hiển thị: `chamY` không tính các ô này vào nhóm nào (không ghi sổ, không đổi kết quả). Ô gợi ý con CHƯA điền (trống / vắng) KHÔNG có khoá —
 * trang không tô (bỏ trống gợi ý là chuyện bình thường, không phải "sai"). Ý không có ô gợi ý (mọi kiểu khác) → {}. `traLoi` như của `o`: {[idÔ]: chữ gõ}.
 */
export function chamGoiY(y, traLoi) {
  const ra = {};
  for (const c of y?.o || []) {
    if (!c.goi_y) continue;
    const go = traLoi?.[c.id];
    if (typeof go === "string" ? !go.trim() : typeof go !== "number") continue;
    ra[c.id] = chamO(c, go).kq;
  }
  return ra;
}

/** Mọi item ghi sổ của tài liệu dựng → [{id, kt, tier}] (id = id nhóm), KỂ CẢ nhóm của biến thể "bài tương tự". Đầu vào của `mucKt`. */
export function cacNhom(doc) {
  const ra = [];
  const them = (b) => {
    for (const y of b.y || []) for (const n of y.nhom || []) ra.push({ id: n.id, kt: n.kt, tier: b.tier });
  };
  for (const m of doc?.muc || []) {
    for (const b of m.bai || []) {
      them(b);
      for (const v of b.bien_the || []) them(v);
    }
  }
  return ra;
}

// ═══════════════════════════ Mức thành thạo ═══════════════════════════

const NGAY = 86400;
const VN = 7 * 3600;                                       // múi giờ Việt Nam (UTC+7): cùng một ngày lịch ở trình duyệt lẫn Worker
const ngayCua = (ts) => Math.floor((ts + VN) / NGAY);
const GAN_NHAT = 5;
const soSanhId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Mức thành thạo của từng kiến thức → {[kt]: 0..4} (tên: TEN_MUC). Hàm thuần: khu bố mẹ gọi (trang con chưa hiện mức, chỉ dùng module để chấm).
 *   luot  = [{i, c, g, ts}] của MỘT học sinh, khoá như cột `attempt` (thứ tự tuỳ ý): i = id nhóm · g = 0..3 · ts = epoch giây.
 *           Lượt có ts > now bị bỏ; lượt TRÙNG HỆT (cùng ts, i, g) chỉ đếm một lần (trang gửi lại lô sau lỗi mạng); lượt có `i` không
 *           thuộc `cacY` (bài đã sửa / gỡ khỏi nội dung) bị bỏ.
 *   cacY  = [{id, kt, tier}] — các NHÓM (item ghi sổ), kể cả nhóm của biến thể: `cacNhom(doc)`.
 *   now   = epoch giây.
 *   0 Chưa làm: chưa có lượt · 1 Đang học: có lượt ·
 *   2 Làm được: ≥ 3 lượt g = 3 trong 5 lượt GẦN NHẤT của kiến thức, và các lượt g = 3 đó thuộc ≥ 2 item khác nhau ·
 *   3 Thành thạo: mức 2, có g = 3 (bất kỳ lúc nào) ở một item practice hoặc challenge, và ở một item challenge nếu kiến thức có item challenge ·
 *   4 Vững: mức 3, có g = 3 ở hai ngày (lịch giờ VN) cách nhau ≥ 7 ngày.
 * Mọi kiến thức xuất hiện trong `cacY` đều có mặt trong kết quả.
 */
export function mucKt(luot, cacY, now) {
  const info = new Map();
  for (const y of cacY || []) if (y && y.id != null && y.kt) info.set(y.id, { kt: y.kt, tier: y.tier });
  const coKho = new Set();
  for (const { kt, tier } of info.values()) if (tier === "challenge") coKho.add(kt);

  const han = now == null ? Infinity : now;
  const ls = (luot || []).filter((a) => a && info.has(a.i) && a.ts <= han)
    .sort((a, b) => a.ts - b.ts || soSanhId(a.i, b.i) || a.g - b.g);
  const theoKt = new Map();
  ls.forEach((a, k) => {
    if (k > 0 && a.ts === ls[k - 1].ts && a.i === ls[k - 1].i && a.g === ls[k - 1].g) return;   // trùng hệt
    const kt = info.get(a.i).kt;
    if (!theoKt.has(kt)) theoKt.set(kt, []);
    theoKt.get(kt).push(a);
  });

  const ra = {};
  for (const { kt } of info.values()) {
    const L = theoKt.get(kt) || [];
    if (!L.length) { ra[kt] = 0; continue; }
    const c3 = L.slice(-GAN_NHAT).filter((a) => a.g === 3);
    if (c3.length < 3 || new Set(c3.map((a) => a.i)).size < 2) { ra[kt] = 1; continue; }
    const g3 = L.filter((a) => a.g === 3);
    const tierCua = (a) => info.get(a.i).tier;
    const khoDu = g3.some((a) => tierCua(a) === "practice" || tierCua(a) === "challenge") && (!coKho.has(kt) || g3.some((a) => tierCua(a) === "challenge"));
    if (!khoDu) { ra[kt] = 2; continue; }
    const ngay = g3.map((a) => ngayCua(a.ts));
    ra[kt] = Math.max(...ngay) - Math.min(...ngay) >= 7 ? 4 : 3;
  }
  return ra;
}

// ═══════════════════════════ Chấm câu viết bằng Gemini (plan 2026-11-03-cham-cau-viet-gemini) ═══════════════════════════
//
// Ba hàm thuần dùng chung cho Worker (`worker/cham_viet.js`), trang con và khu bố mẹ. KHÔNG import thêm gì ở đây (builder viết lại đúng
// MỘT dòng import `toan_cham`). `x` của lượt `viet` (cột `attempt.chose`) là JSON có phiên bản:
//   máy chấm   {"v":1,"t":câu,"l":lan,"m":{"d":0|1,"k":{ma:0|1},"q":{ma:trích},"c":{ma:ghi_chưa_đạt},"s":[{"q":trích,"h":gợi_ý}],"n":nhận_xét}}
//   tự kiểm    {"v":1,"t":câu,"l":lan,"tk":{ma:0|1},"ly":"loi|het_cau|het_ngay|khong_co|nghi_lenh|khoa|ngoai_tuyen"}
//   bài mẫu    {"v":1,"mau":1}                 (mở bài mẫu khi chưa đạt, g 0)
//   bố mẹ sửa  …,"bm":{"d":0|1,"ts":epoch,"g0":grade_trước_lần_sửa_đầu}   (thêm vào bất kỳ dạng nào có `t`)
// Lượt cũ (trước tính năng) có `x` là chữ trần → `docXViet` đọc thành loai "cu".

/** Trần độ dài `x` ghi vào sổ (ký tự). `writeSession` cắt `x` của id `b.*` ở đúng con số này, nên JSON do `goiX` ra không bao giờ bị cắt gãy. */
export const X_VIET = 2400;

/**
 * Điểm `g` (0..3) của MỘT lượt chấm câu viết — bảng §4, theo thứ tự điều kiện:
 *   xemMau (đã mở bài mẫu khi chưa đạt)           → 0
 *   đạt, lan === 1 (lượt chấm đầu), chưa mở gợi ý → 3
 *   đạt                                           → 2   (kể cả đạt lượt đầu nhưng đã mở «💡 Gợi ý»: trần 2)
 *   chưa đạt                                      → 1
 * `ok` của dòng sổ = g >= 2. `lan` là số thứ tự lượt chấm của nhóm (máy + tự kiểm, từ 1); chỉ số `1` đúng kiểu mới được 3.
 */
export function gViet({ dat, lan, xemMau = false, goiY = false }) {
  if (xemMau) return 0;
  if (!dat) return 1;
  return lan === 1 && !goiY ? 3 : 2;
}

/** Cắt bớt ÍT NHẤT `bot` ký tự JSON của chuỗi `s`: bỏ `bot + 1` ký tự cuối rồi thêm «…» (mỗi ký tự bỏ đi ≥ 1 ký tự JSON ⇒ mất ròng ≥ `bot`). Hết chỗ cắt thì "". */
function catBot(s, bot) {
  const giu = s.length - bot - 1;
  if (giu <= 0) return "";
  let r = s.slice(0, giu);
  if (/[\ud800-\udbff]$/.test(r)) r = r.slice(0, -1);   // không chặt đôi cặp surrogate (emoji)
  return r + "…";
}

const laObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Đối tượng `x` → chuỗi JSON ≤ X_VIET ký tự (không sửa đầu vào). Vừa thì giữ nguyên; quá thì cắt LẦN LƯỢT, mỗi chuỗi chỉ cắt phần dư và
 * chuỗi bị cắt thêm «…», sau mỗi lần đo lại:
 *   m.n → các m.c → các m.s[].h → các m.q → t        (trong một nhóm nhiều chuỗi: từ chuỗi CUỐI trở lại; chuỗi cắt hết thành "" rồi sang chuỗi kế)
 * Khoá cấu trúc (v, l, m.d, m.k, tk, ly, bm) không bao giờ bị cắt ⇒ `docXViet` đọc được. Hình dạng quá lạ vẫn quá dài sau mọi bước thì trả `{"v":1}`.
 */
export function goiX(o) {
  const goc = JSON.stringify(o);
  if (goc.length <= X_VIET) return goc;
  const b = JSON.parse(goc);   // bản sao để cắt
  const m = laObj(b?.m) ? b.m : null;
  const nhom = [
    () => (m ? [[m, "n"]] : []),
    () => (laObj(m?.c) ? Object.keys(m.c).reverse().map((k) => [m.c, k]) : []),
    () => (Array.isArray(m?.s) ? m.s.filter(laObj).reverse().map((e) => [e, "h"]) : []),
    () => (laObj(m?.q) ? Object.keys(m.q).reverse().map((k) => [m.q, k]) : []),
    () => (laObj(b) ? [[b, "t"]] : []),
  ];
  for (const lay of nhom) {
    for (const [cha, khoa] of lay()) {
      if (typeof cha[khoa] !== "string") continue;
      const bot = JSON.stringify(b).length - X_VIET;
      if (bot <= 0) return JSON.stringify(b);
      cha[khoa] = catBot(cha[khoa], bot);
    }
  }
  const ra = JSON.stringify(b);
  return ra.length <= X_VIET ? ra : '{"v":1}';
}

// Bộ lọc cho `docXViet`: `x` là dữ liệu trình duyệt gửi lên, nên KHÔNG tin hình dạng. Lọc về đúng kiểu để chỗ hiển thị (x-text) không ném.
const chuoi = (v) => (typeof v === "string" ? v : null);
const bit = (v) => (v === 0 || v === 1 ? v : null);
const soHuuHan = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
function mapLoc(v, loc) {
  const ra = {};
  if (laObj(v)) for (const [k, x] of Object.entries(v)) { const y = loc(x); if (y !== null) ra[k] = y; }
  return ra;
}

/**
 * `x` (chuỗi hoặc null) → {loai, t, l, d, k, q, c, s, n, tk, ly, bm}. Không bao giờ ném.
 *   loai "may" (có `m`) · "tu" (có `tk` / `ly`) · "mau" (`mau`) · "cu" (chữ trần của lượt trước tính năng; JSON cắt cụt / hỏng / phiên bản lạ:
 *   `t` = NGUYÊN chuỗi gốc) · "trong" (null / rỗng / không phải chuỗi).
 *   d = kết luận máy 0|1 hoặc null · k {ma:0|1} · q {ma:trích} · c {ma:ghi} · s [{q, h}] · tk {ma:0|1} · bm {d, ts, g0} hoặc null.
 * Khoá vắng: chuỗi / số / d / n / ly / bm → null; k, q, c, tk → {}; s → [].
 */
export function docXViet(x) {
  const rong = (loai, t = null) => ({ loai, t, l: null, d: null, k: {}, q: {}, c: {}, s: [], n: null, tk: {}, ly: null, bm: null });
  if (typeof x !== "string" || !x.trim()) return rong("trong");
  if (!x.trim().startsWith("{")) return rong("cu", x);
  let o;
  try { o = JSON.parse(x); } catch { return rong("cu", x); }
  if (!laObj(o) || o.v !== 1) return rong("cu", x);
  const ra = rong("cu", chuoi(o.t));
  ra.l = soHuuHan(o.l);
  if (laObj(o.bm)) ra.bm = { d: bit(o.bm.d), ts: soHuuHan(o.bm.ts), g0: Number.isInteger(o.bm.g0) && o.bm.g0 >= 0 && o.bm.g0 <= 3 ? o.bm.g0 : null };
  if (laObj(o.m)) {
    const m = o.m;
    ra.loai = "may";
    ra.d = bit(m.d);
    ra.k = mapLoc(m.k, bit);
    ra.q = mapLoc(m.q, chuoi);
    ra.c = mapLoc(m.c, chuoi);
    ra.s = (Array.isArray(m.s) ? m.s : []).filter(laObj).map((e) => ({ q: chuoi(e.q) ?? "", h: chuoi(e.h) ?? "" }));
    ra.n = chuoi(m.n);
  } else if (laObj(o.tk) || typeof o.ly === "string") {
    ra.loai = "tu";
    ra.tk = mapLoc(o.tk, bit);
    ra.ly = chuoi(o.ly);
  } else if (o.mau) {
    ra.loai = "mau";
  } else if (ra.t === null) {
    ra.t = x;   // JSON v1 không có gì đọc được: cho hiện nguyên chuỗi như lượt cũ
  }
  return ra;
}

// ── Vùng trích: khu bố mẹ tô <mark> đoạn câu của con mà máy đã trích làm bằng chứng ─────────────────────────────────────────
// CÙNG luật khớp với `coTrich` của worker/cham_viet.js (chuẩn hoá chữ thường / nháy cong / khoảng trắng / dấu phẩy / ký tự không độ rộng,
// tách theo `…` hoặc `...`, mỗi mảnh ≥ 2 chữ/số, tối đa 3 mảnh, tổng ≥ 4, đúng THỨ TỰ, mỗi mảnh đứng ở BIÊN chữ/số) — nhưng trả VỊ TRÍ trong câu gốc
// thay vì true/false. Hai bản phải khớp nhau từng ca: tests/test_cham_viet_js.mjs đối chiếu `vungTrich !== null` ⇔ `coTrich`. Khác biệt có chủ ý: bản này
// đòi câu ĐÃ NFC (tachDoan lo), vì vị trí phải đo trên chính chuỗi hiển thị.
const KHONG_DO_RONG_VT = /[\u200b-\u200d\u2060\ufeff]/;   // = KHONG_DO_RONG của cham_viet.js; viết bằng escape để một lần lưu / định dạng không làm rơi ký tự vô hình
const BO_DAU_HAI_DAU_VT = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const TRUOC_LA_CHU_VT = /[\p{L}\p{N}]$/u, SAU_LA_CHU_VT = /^[\p{L}\p{N}]/u;
const TRICH_MANH_MAX = 3, TRICH_MANH_CHU_MIN = 2, TRICH_CHU_MIN = 4;

/**
 * `chuan` của cham_viet.js kèm bản đồ vị trí: {n, tu, den} — `n` là chuỗi đã chuẩn hoá, `tu[k]` / `den[k]` = đoạn [tu, den) của câu gốc mà ký tự thứ k của `n`
 * (theo đơn vị mã UTF-16) sinh ra. Khoảng trắng gộp thì trỏ vào khoảng trắng ĐẦU; khoảng trắng bị bỏ (đầu / cuối / quanh dấu phẩy) không có mục nào.
 */
function chuanBanDo(s) {
  const n = [], tu = [], den = [];
  const dua = (c, a, b) => { for (let k = 0; k < c.length; k++) { n.push(c[k]); tu.push(a); den.push(b); } };
  let i = 0;
  for (const ch of s) {
    const a = i, b = i + ch.length;
    i = b;
    if (KHONG_DO_RONG_VT.test(ch)) continue;
    const c = ch.toLowerCase().replace(/[’‘ʼ´`]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-");
    if (/^\s$/.test(c)) {
      if (n.length && n[n.length - 1] !== " " && n[n.length - 1] !== ",") dua(" ", a, b);
      continue;
    }
    if (c === "," && n.length && n[n.length - 1] === " ") { n.pop(); tu.pop(); den.pop(); }
    dua(c, a, b);
  }
  while (n.length && n[n.length - 1] === " ") { n.pop(); tu.pop(); den.pop(); }
  return { n: n.join(""), tu, den };
}

const demChuVt = (s) => (s.match(/[\p{L}\p{N}]/gu) || []).length;

/** Vị trí đầu tiên ≥ `tuViTri` mà `m` đứng ở BIÊN (ký tự ngay trước / sau không phải chữ hoặc số), -1 nếu không có — như `timOBien` của cham_viet.js. */
function timBien(nen, m, tuViTri) {
  for (let i = nen.indexOf(m, tuViTri); i >= 0; i = nen.indexOf(m, i + 1)) {
    if (TRUOC_LA_CHU_VT.test(nen.slice(Math.max(0, i - 2), i))) continue;
    if (SAU_LA_CHU_VT.test(nen.slice(i + m.length, i + m.length + 2))) continue;
    return i;
  }
  return -1;
}

/**
 * Các vùng [từ, đến) của `cau` (ĐÃ NFC) mà `trich` chỉ tới — mỗi mảnh của trích một vùng, theo thứ tự — hoặc null khi `trich` không khớp
 * (đúng khi và chỉ khi `coTrich` của cham_viet.js trả false). Không ném với đầu vào không phải chuỗi.
 */
export function vungTrich(cau, trich) {
  if (typeof cau !== "string" || typeof trich !== "string") return null;
  const bd = chuanBanDo(cau);
  const manh = trich.split(/…|\.{3}/).map((m) => chuanBanDo(m.normalize("NFC")).n.replace(BO_DAU_HAI_DAU_VT, "")).filter(Boolean);
  if (!manh.length || manh.length > TRICH_MANH_MAX) return null;
  const ra = [];
  let tuViTri = 0, chu = 0;
  for (const m of manh) {
    const c = demChuVt(m);
    if (c < TRICH_MANH_CHU_MIN) return null;
    const i = timBien(bd.n, m, tuViTri);
    if (i < 0) return null;
    tuViTri = i + m.length;
    chu += c;
    ra.push([bd.tu[i], bd.den[i + m.length - 1]]);
  }
  return chu >= TRICH_CHU_MIN ? ra : null;
}

/**
 * Cắt `cau` (chuẩn hoá NFC để vị trí đo trên đúng chuỗi hiển thị) thành các đoạn liên tiếp [{t, mark}]: đoạn nằm trong vùng của ÍT NHẤT một trích khớp thì
 * mark = true. Trích không khớp thì bỏ qua (không tô gì). Vùng chồng / liền kề nhau gộp một. Nối mọi `t` lại ra đúng `cau`. Câu rỗng → [].
 */
export function tachDoan(cau, trichs) {
  const t = typeof cau === "string" ? cau.normalize("NFC") : "";
  if (!t) return [];
  const vung = [];
  for (const tr of Array.isArray(trichs) ? trichs : []) vung.push(...(vungTrich(t, tr) || []));
  vung.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const gop = [];
  for (const [a, b] of vung) {
    const cuoi = gop[gop.length - 1];
    if (cuoi && a <= cuoi[1]) cuoi[1] = Math.max(cuoi[1], b);
    else gop.push([a, b]);
  }
  const ra = [];
  let vt = 0;
  for (const [a, b] of gop) {
    if (a > vt) ra.push({ t: t.slice(vt, a), mark: false });
    ra.push({ t: t.slice(a, b), mark: true });
    vt = b;
  }
  if (vt < t.length) ra.push({ t: t.slice(vt), mark: false });
  return ra;
}

const NGOAC_CO_SO = /\s*\([^()]*\p{Nd}[^()]*\)/gu, CHU_SO_LIEN = /\p{Nd}+(?:[.,]\p{Nd}+)*/gu;

/**
 * Nhãn của một tiêu chí tự kiểm (`tu_kiem`) cho THẺ KẾT QUẢ của máy chấm (con thấy, ngay sau lượt chưa đạt). Câu `tu_kiem` đầy đủ có khi chứa đáp số
 * máy tính ngay trong chữ («so sánh range: B 36, D 69», «dùng range nhỏ nhất (17)»): đưa lên thẻ máy thì bộ lọc «không lộ đáp số» của Worker mất tác dụng.
 * Luật (cùng nhãn chip khu bố mẹ, thêm việc bỏ ngoặc):
 *   - bỏ MỌI cụm ngoặc đơn có chữ số (lồng thì từ trong cùng ra ngoài; ngoặc không chữ số giữ nguyên);
 *   - có «:» → nhãn = phần trước dấu «:» đầu tiên (chữ số ở đó, vd «Group 1», giữ nguyên);
 *   - không có «:» → mọi chữ số còn lại của câu thành «…» (một số thập phân = một «…»).
 * Danh sách TỰ KIỂM (đường lùi, con tự tick) vẫn hiện nguyên câu như trước tính năng. Không ném với đầu vào không phải chuỗi; luôn trả chữ không rỗng.
 */
export function nhanTieuChi(t) {
  let s = typeof t === "string" ? t : "";
  for (let truoc = null; truoc !== s;) { truoc = s; s = s.replace(NGOAC_CO_SO, ""); }
  s = s.replace(/\s+/g, " ").trim();
  const che = (x) => x.replace(CHU_SO_LIEN, "\u2026");
  const i = s.indexOf(":");
  let nhan = i >= 0 ? s.slice(0, i).replace(/\s*\([^)]*$/, "") : che(s);   // ngoặc mở dở trước «:» thì cắt tại ngoặc
  nhan = nhan.replace(/[\s,;]+$/, "").trim();
  if (!nhan && i >= 0) nhan = che(s.slice(i + 1)).replace(/^[\s,;:]+|[\s,;]+$/g, "");   // nhãn rỗng (câu mở đầu bằng «:»): lấy phần sau, đã che số
  return nhan || "Tiêu chí";
}
