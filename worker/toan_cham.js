/**
 * Chấm đáp số Toán 6 — theo GIÁ TRỊ, không theo mặt chữ (spec 2026-10-21, §5). MỘT bản cho cả trình duyệt (trang Toán nạp
 * bằng <script type="module">, builder chép sang dist/assets/ với tên có hash — ADR 0048) và Worker. Hàm thuần, không
 * import, không đụng DOM / API riêng của Worker. Bản Python của PHẦN ĐỌC số (`src/toan_cham.py`, dùng lúc kiểm nội dung)
 * phải đọc giống hệt: cả hai chấm trên cùng bộ mẫu `tests/toan_cham_mau.json`.
 *
 * Số hữu tỉ CHÍNH XÁC bằng BigInt (cặp n/d đã tối giản, d > 0) — không bao giờ so số thực: 0,5 = 1/2 = 2/4, và
 * 1/3 ≠ 0,33333333333333333 (số thực làm tròn coi hai số này là một).
 *
 * Dạng đọc được (sau khi gộp khoảng trắng, bỏ dấu cách quanh `/`): số nguyên `12` · thập phân `0,75` hoặc `0.75` · phân số `3/4` hoặc `3 / 4` (mẫu ≠ 0) ·
 * hỗn số `2 1/3` · tỉ số `1:2` (CHỈ khi đáp số của bài là phân số — CCN-10: đề hỏi tỉ số, con quen viết `1:2`). Không nhận số âm, `%`,
 * chữ, số mũ. Gõ không đọc được → "cach_viet" (chưa đúng cách viết — KHÔNG tính là sai). Mọi loại gạch (`-` `−` `–`) được coi như một
 * (CCN-01: công thức hiển thị dấu trừ `−`, con có thể chép đúng ký tự ấy).
 *
 * Dấu ngăn hàng nghìn (chỉ `cham` đọc, `docSo` thì không): `1.000`, `1,000`, `12.500`, `1.000.000` (phần nguyên 1–3 chữ số, không
 * mở đầu bằng 0, rồi một hay nhiều nhóm `.` hoặc `,` + đúng 3 chữ số, CÙNG một dấu) và `1 000`, `12 500`, `1 000 000` (nhóm cách
 * ra bằng dấu cách, không có `/`) là MƠ HỒ — con có thể đang viết 1 (thập phân) hoặc 1000 (ngăn nghìn). Chấm `dung` nếu MỘT trong
 * hai cách đọc khớp đáp số, không thì `sai` (đã cân: chấm sai một đáp số đúng tệ hơn tha một đáp số tình cờ khớp).
 */

const TOI_DA = 200;   // dài hơn thì không phải một con số — chặn sớm trước khi dựng BigInt

const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };

function rutGon(n, d) {
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

/** Bỏ khoảng trắng đầu/cuối, gộp mọi dãy khoảng trắng (cả NBSP) thành MỘT dấu cách; `−` (U+2212) `–` `‐` `‑` thành `-` (CCN-01); bỏ dấu cách
 *  quanh `/` ("7 / 20" = "7/20" — bàn phím iPad hay tự chèn; soát phan-so-cua-mot-so CC-03). */
function chuanHoa(s) {
  return String(s).trim().replace(/\s+/g, " ").replace(/ ?\/ ?/g, "/").replace(/[\u2212\u2013\u2010\u2011]/g, "-");
}

/**
 * `t` đã chuẩn hoá → {v: {n, d}, chuaGian} | null. `chuaGian` = viết dạng phân số / hỗn số mà phần phân số còn rút gọn được
 * (2/4, 1 2/4) — chỉ để chấm bài đòi tối giản.
 */
function phanTich(t, tySo = false) {
  if (!t || t.length > TOI_DA) return null;
  let m;
  if ((m = /^([0-9]+)$/.exec(t))) return { v: { n: BigInt(m[1]), d: 1n }, chuaGian: false };
  if ((m = /^([0-9]+)[.,]([0-9]+)$/.exec(t))) {
    return { v: rutGon(BigInt(m[1] + m[2]), 10n ** BigInt(m[2].length)), chuaGian: false };
  }
  if ((m = /^([0-9]+)\/([0-9]+)$/.exec(t))) {
    const a = BigInt(m[1]), b = BigInt(m[2]);
    return b === 0n ? null : { v: rutGon(a, b), chuaGian: gcd(a, b) !== 1n };
  }
  if ((m = /^([0-9]+) ([0-9]+)\/([0-9]+)$/.exec(t))) {
    const w = BigInt(m[1]), a = BigInt(m[2]), b = BigInt(m[3]);
    return b === 0n ? null : { v: rutGon(w * b + a, b), chuaGian: gcd(a, b) !== 1n };
  }
  if (tySo && (m = /^([0-9]+) ?: ?([0-9]+)$/.exec(t))) {   // tỉ số 1:2 = phân số 1/2 (chỉ khi đáp số của bài là phân số)
    const a = BigInt(m[1]), b = BigInt(m[2]);
    return b === 0n ? null : { v: rutGon(a, b), chuaGian: gcd(a, b) !== 1n };
  }
  return null;
}

/**
 * Cách đọc NGĂN HÀNG NGHÌN của `t` (đã chuẩn hoá) → {n, d: 1n} | null. Phần nguyên 1–3 chữ số không mở đầu bằng 0 (`0,500` không
 * phải 500), rồi các nhóm đúng 3 chữ số ngăn bằng cùng một dấu `.` / `,` (trộn `1,000.000` thì không đọc), hoặc bằng dấu cách.
 */
function nghin(t) {
  let m = /^([1-9][0-9]{0,2})((?:\.[0-9]{3})+|(?:,[0-9]{3})+)$/.exec(t);
  if (m) return { n: BigInt(m[1] + m[2].replace(/[.,]/g, "")), d: 1n };
  if (/^[1-9][0-9]{0,2}(?: [0-9]{3})+$/.test(t)) return { n: BigInt(t.replace(/ /g, "")), d: 1n };
  return null;
}

/** Mọi cách đọc của một đáp số con (`t` đã chuẩn hoá) → {cach: [{n, d}], chuaGian} | null nếu không cách nào đọc được. */
function cachDoc(t, tySo = false) {
  const p = phanTich(t, tySo);
  const cach = p ? [p.v] : [];
  const k = t.length > TOI_DA ? null : nghin(t);
  if (k) cach.push(k);
  return cach.length ? { cach, chuaGian: p ? p.chuaGian : false } : null;
}

/**
 * Có phép ghép 1–1 giữa đáp số con (mỗi cái có nhiều cách đọc) và đáp số chuẩn sao cho mỗi cặp khớp bằng ít nhất một cách đọc
 * không? `thuTu` thì ghép theo vị trí. Ghép tham lam sai ở bài như đáp số [1, 1000] ← "1,000;1,000", nên dùng đường tăng luồng
 * (Kuhn): hai danh sách bằng độ dài, mỗi bên rất ít phần tử.
 */
function ghep(cacCach, chuanKhoa, thuTu) {
  if (thuTu) return cacCach.every((c, i) => c.includes(chuanKhoa[i]));
  const n = chuanKhoa.length, chu = new Array(n).fill(-1);   // chu[j] = đáp số con đang giữ đáp số chuẩn j
  const thu = (i, daXet) => {
    for (let j = 0; j < n; j++) {
      if (daXet[j] || !cacCach[i].includes(chuanKhoa[j])) continue;
      daXet[j] = true;
      if (chu[j] < 0 || thu(chu[j], daXet)) { chu[j] = i; return true; }
    }
    return false;
  };
  return cacCach.every((_, i) => thu(i, new Array(n).fill(false)));
}

// ── Đơn vị (CCN-09): `don_vi` của bài là chữ HOẶC danh sách chữ (mọi phần tử đều nhận). So sánh qua `chuanDonVi`: không phân biệt hoa
// thường; `m2` `m^2` ≡ `m²` (bàn phím iPad khó gõ ²); vài cách viết tương đương (km/h ≡ km/giờ, ki-lô-gam ≡ kg…); bỏ lượng từ đứng đầu
// khi còn lại chữ ("chiếc ghế" ≡ "ghế" — DSN-22). Không phải chấm sai: đơn vị lạ vẫn là "cach_viet" như trước.
const LUONG_TU = new Set(["chiếc", "cái", "con", "quyển", "cuốn", "bông", "cây", "quả", "viên", "tờ", "bức", "trái", "hạt", "cục"]);
const TUONG_DUONG = new Map();
for (const nhom of [
  ["kg", "ki-lô-gam", "ki lô gam", "kilôgam", "kilogam", "kilogram", "ki-lô-gram"],
  ["g", "gam", "gram"],
  ["km/giờ", "km/h", "km/gio", "ki-lô-mét/giờ", "ki-lô-mét trên giờ", "km trên giờ"],
  ["m/giây", "m/s", "mét/giây", "mét trên giây", "m/giay"],
  ["lít", "l", "lit"],
  ["mm", "mi-li-mét", "milimét"], ["cm", "xăng-ti-mét", "xăng ti mét", "xentimét"], ["dm", "đề-xi-mét"], ["m", "mét"],
  ["km", "ki-lô-mét", "kilômét"],
  ["cm²", "xăng-ti-mét vuông", "xăng ti mét vuông"], ["m²", "mét vuông", "met vuong"], ["km²", "ki-lô-mét vuông"],
  ["m³", "mét khối", "met khoi"], ["cm³", "xăng-ti-mét khối"],
]) for (const x of nhom) TUONG_DUONG.set(x, nhom[0]);

/** Đơn vị → dạng chuẩn để so sánh (xem trên). */
function chuanDonVi(u) {
  let t = chuanHoa(u).toLowerCase().normalize("NFC").replace(/ ?\/ ?/g, "/");
  const m = /^(mm|cm|dm|m|km|ha) ?\^? ?([23])$/.exec(t);
  if (m) t = m[1] + (m[2] === "2" ? "²" : "³");
  t = TUONG_DUONG.get(t) ?? t;
  const w = t.split(" ");
  return w.length > 1 && LUONG_TU.has(w[0]) ? w.slice(1).join(" ") : t;
}

/** Các đơn vị bài chấp nhận → mảng dạng chuẩn (rỗng nếu bài không có đơn vị). */
function donViChap(dv) {
  return [].concat(dv ?? []).filter((x) => typeof x === "string" && x.trim()).map(chuanDonVi);
}

/** Bỏ đơn vị ở CUỐI một đáp số con gõ (`7500 m2` → `7500`) nếu đó đúng là một đơn vị bài chấp nhận; không thì giữ nguyên. */
function boDonVi(t, chap) {
  if (!chap.length) return t;
  const i = t.search(/[^0-9.,/: ]/);
  if (i <= 0) return t;
  return chap.includes(chuanDonVi(t.slice(i))) ? t.slice(0, i).trim() : t;
}

/** Vì sao một đáp số con gõ không đọc được: "so_kem_chu" = có phần số đọc được rồi tới chữ lạ ("60 viên bi") — page nhắc "chỉ cần ghi số"; "khac" = còn lại. */
function lyDo(t, tySo) {
  const i = t.search(/[^0-9.,/: ]/);
  return i > 0 && cachDoc(t.slice(0, i).trim(), tySo) ? "so_kem_chu" : "khac";
}

/** Một con số con gõ → {n: bigint, d: bigint} (tối giản, d > 0), hoặc null nếu không đọc được. Không nhận đơn vị. Chỉ đọc THẬP PHÂN (`1.000` = 1), như `doc_so` của Python. `tySo` = đọc cả `a:b` như phân số (bài có đáp số là phân số). */
export function docSo(s, tySo = false) {
  if (typeof s !== "string") return null;
  const p = phanTich(chuanHoa(s), tySo);
  return p ? p.v : null;
}

const khoa = (v) => `${v.n}/${v.d}`;
const gionNhau = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
/** Hai danh sách chuỗi bằng nhau như ĐA TẬP (không phụ thuộc thứ tự); `thuTu` thì so từng vị trí. */
const khopDS = (a, b, thuTu) => (thuTu ? gionNhau(a, b) : gionNhau([...a].sort(), [...b].sort()));

/**
 * Chấm một lần nộp. `bai` = {dap: string | string[], kieu: "so" | "chon", don_vi?: string | string[], toi_gian?, thu_tu?}; `go` = chữ con gõ
 * (hoặc id phương án đã chọn). Trả {kq, go, ly?}:
 *   kq = "dung" · "sai" · "cach_viet" (không đọc được — không tính sai) · "chua_toi_gian" (đúng giá trị nhưng bài đòi
 *        tối giản mà con còn để phân số rút gọn được);
 *   go = chữ con gõ đã chuẩn hoá — chuỗi này ghi vào sổ làm đáp số con gõ;
 *   ly = (chỉ khi kq = "cach_viet", bài kieu "so") "so_kem_chu" nếu có phần số đọc được kèm chữ lạ ("60 viên bi"), không thì "khac" (CCN-09).
 * Số có dấu ngăn hàng nghìn (`1.000`, `1 000`…) là mơ hồ — xem đầu file: một trong hai cách đọc khớp là `dung`.
 * Nhiều đáp số: tách theo ";" rồi so như ĐA TẬP (trừ khi `thu_tu`: so từng vị trí). Có `don_vi`: mỗi đáp số được kèm đơn vị
 * đó ở cuối (cách hay liền đều được), không kèm cũng được; đơn vị khác thì "cach_viet".
 * `kieu: "chon"`: so ĐÚNG chữ (id phương án), không đọc số.
 */
export function cham(bai, go) {
  const goChuan = typeof go === "string" ? chuanHoa(go) : "";
  const dap = Array.isArray(bai.dap) ? bai.dap : [bai.dap];
  const cac = goChuan.split(";").map((t) => t.trim());
  const ra = (kq) => ({ kq, go: goChuan });

  if (bai.kieu === "chon") {
    return ra(khopDS(cac, dap.map(String), bai.thu_tu) ? "dung" : "sai");
  }

  const chap = donViChap(bai.don_vi);
  const tySo = dap.some((x) => String(x).includes("/"));   // đáp số là phân số → nhận cả tỉ số `a:b` (CCN-10)
  const ps = cac.map((t) => cachDoc(boDonVi(t, chap), tySo));
  const hong = ps.findIndex((p) => p === null);
  if (hong >= 0) return { kq: "cach_viet", go: goChuan, ly: lyDo(cac[hong], tySo) };

  // Đáp số của chính bài không đọc được (lỗi nội dung — máy kiểm bên Python chặn trước): không có gì để khớp.
  const chuan = dap.map((x) => docSo(String(x)));
  if (chuan.some((v) => v === null) || ps.length !== chuan.length) return ra("sai");

  if (!ghep(ps.map((p) => p.cach.map(khoa)), chuan.map(khoa), bai.thu_tu)) return ra("sai");
  return ra(bai.toi_gian && ps.some((p) => p.chuaGian) ? "chua_toi_gian" : "dung");
}
