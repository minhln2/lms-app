/**
 * Ôn tập Toán 6 — mức thành thạo, "cần giảng lại", "Ôn hôm nay", trạng thái buổi, buổi hiện tại + "đã xong X/T" của lộ trình (R22),
 * các lần làm của dạng (`lanLam`), đề kiểm tra (spec 2026-10-21 §5–§7), lượt luyện tập 5 bài (`luotLuyen`) và "Tiếp tục" của trang
 * chuyên đề (`tiepTuc`) — Task 12b; dạng NÂNG CAO (R33, `nang_cao`: ngoài mức / kiểm tra chuyên đề, học sau kiểm tra).
 * MỘT bản cho trình duyệt (trang con, trang bố mẹ) và Worker: cùng `luot` ra cùng mức ở mọi nơi — như `lich_on.js`.
 * Hàm thuần; chỉ import `./lich_on.js`; không đọc đồng hồ (mọi hàm nhận `now` = epoch giây) và không đụng API riêng của
 * Node hay trình duyệt. Không hàm nào sửa đầu vào (sắp xếp luôn trên bản sao).
 *
 * Đầu vào:
 *   luot = [{i, c, g, ts, x}] của MỘT học sinh, khoá như cột `attempt` (thứ tự tuỳ ý — hàm tự xếp theo (ts, i, g), nên kết
 *     quả không phụ thuộc thứ tự mảng, kể cả hai lượt trùng cả ts lẫn i):
 *     i = id bài / bước · c = id dạng (dòng tổng của bài kiểm tra chuyên đề: c = id chuyên đề) · g = 0..3 · ts = epoch giây ·
 *     x = đáp số con gõ (dòng tổng: "<đúng>/<tổng>").
 *     Thang g: 3 đúng không gợi ý · 2 đúng sau gợi ý · 1 sai · 0 đã xem lời giải. Điểm một lần (`diemLan`): 3→1 · 2→½ · ≤1→0.
 *     Dòng tổng kiểm tra chuyên đề: g = 3 khi ĐẠT (≥ 80% và đúng mọi câu thu-thach), 1 khi không — xem `tongKiemTra`.
 *     Lượt có ts > now bị bỏ — `now` là "tính tới lúc nào".
 *   id: chuyên đề `[a-z0-9-]+` (không có dấu chấm) · dạng `<cd>.<dạng>` · bài `<dạng>.<nn>` · bài kiểm tra `<cd>.kt.<nn>` ·
 *       bước `<dạng>.b<k>` / `<cd>.kien-thuc.b<k>` · thứ nằm trong bước `<bước>.h` / `<bước>.o<n>` / `<bước>.<nn>` (không đếm,
 *       như bước) · dòng tổng `<cd>.kiem-tra`.
 *   dạng (kho.cd[id].dang[k]) = {id, buoc: [id bước…], bai: [{id, muc}], nang_cao?} — `muc`: mo-khoa · tang-toc · chinh-phuc · thu-thach.
 *     `nang_cao: true` (ruling R33) = dạng NÂNG CAO: học SAU kiểm tra chuyên đề (`tiepTuc`); KHÔNG vào `mucChuyenDe` (muc / da_hoc / dat →
 *     cũng không vào `trangThaiBuoi` "xong") và KHÔNG vào đề kiểm tra (`deKiemTra`); vẫn có mức riêng (`mucDang`), vẫn vào Ôn hôm nay
 *     (`onHomNay`) và "Cần giảng lại" (`canGiangLai`). Vắng / false = dạng cơ bản.
 *   cd   (kho.cd[id])         = {kien_thuc: [id bước…], dang: [dạng…], kiem_tra: [id bài…]}   (id chuyên đề lấy từ `cd.id`,
 *                               không có thì suy từ tiền tố trước dấu chấm đầu tiên của id con).
 *   kho  = {cd: {id: cd}} — JSON nhúng trang (Task 6). Chuyên đề nháp / chưa soạn KHÔNG có trong kho.
 *   buổi (lộ trình) = {so, ten, chuyen_de: [id…], kiem_tra?: "giai-doan" | "de-thi"}.
 *
 * ⚠ Mọi hàm mức của DẠNG nhận cả đối tượng dạng, không chỉ id: mức cần danh sách bước (🟡) và mức từng bài (🔵).
 *
 * Không khoá cứng (spec §7): mức 🟢 / 🔵 / ⭐ của dạng chỉ tính từ các LẦN LÀM bài, không đòi đã đi hết bài giảng — con có
 * thể làm bài trước khi học. Chỉ 🟡 cần đủ bước, và khi chưa đủ bước mà chưa 🟢 thì mức là 0. Vì vậy mức ≥ 1 KHÔNG có
 * nghĩa "đã học bài giảng": `mucChuyenDe().da_hoc` tính thẳng từ các bước (mọi bước của mọi dạng + mọi bước Kiến thức).
 */
import { phatLai } from "./lich_on.js";

const NGAY = 86400;
const VN = 7 * 3600;         // múi giờ Việt Nam (UTC+7) — mốc "cùng ngày" của `daXemLoiGiai` và `thuThachHomNay`
const ngayCua = (ts) => Math.floor((ts + VN) / NGAY);   // số thứ tự ngày lịch giờ VN của một mốc epoch giây
const GAN_NHAT = 5;          // "5 lần gần nhất" của dạng
const DUNG_TOI_THIEU = 3;    // 🟢: ≥ 3 lần điểm 1 trong 5 lần gần nhất
const CUA_SO_TUT = 7 * NGAY; // "mức cao nhất từng đạt trong 7 ngày qua"; cũng là mốc ôn lại của ⭐
const KHO_BAI = new Set(["chinh-phuc", "thu-thach"]);
const CHINH_PHUC_TOI_THIEU = 2, THU_THACH_TOI_THIEU = 1;   // 🔵: số bài chinh-phuc KHÁC NHAU / thu-thach phải đúng không gợi ý (chủ dự án duyệt 2026-10-23)
const TOI_DA_ON = 10, TOI_THIEU_ON = 5, BAI_MOI_DANG = 2;

/** Điểm một lần làm: 3 → 1 · 2 → ½ · còn lại (1 sai, 0 xem lời giải) → 0. */
export function diemLan(g) { return g === 3 ? 1 : g === 2 ? 0.5 : 0; }

/**
 * id thuộc BÀI GIẢNG (không phải lần làm bài): một bước `….b<k>` HOẶC một thứ nằm trong bước — câu hỏi giảng `….b<k>.h`, ô làm
 * cùng `….b<k>.o<n>`, bài kiểm tra nhanh / bẫy `….b<k>.<nn>` (toan/SPEC.md: id của thứ trong bước LUÔN bắt đầu bằng id bước).
 * Mọi lượt có id như vậy KHÔNG đếm vào "5 lần gần nhất" (spec §6). Còn "bước đã học" thì khác: chỉ lượt có ĐÚNG id bước (có trong
 * `dang.buoc` / `cd.kien_thuc`) mới tính — `chuoiMuc` và `mucCD` so thành viên chính xác, không dùng hàm này.
 */
export function laBuoc(id) { return typeof id === "string" && /\.b\d+(\.[a-z0-9-]+)?$/.test(id); }

const tiengCD = (id) => (typeof id === "string" ? id.split(".")[0] : "");   // id chuyên đề không có dấu chấm
const idCD = (cd) => cd.id || tiengCD(cd.dang?.[0]?.id ?? cd.kien_thuc?.[0] ?? cd.kiem_tra?.[0] ?? "");
const soSanhId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Lượt hợp lệ tới `now`, xếp theo (ts, i, g) — thứ tự toàn phần để hai lượt trùng ts và i vẫn ra cùng kết quả; bản sao.
 *  Bỏ lượt TRÙNG HỆT (cùng ts, i, g): trang gửi lại lô sau khi máy chủ lỗi sẽ ghi lượt hai lần — không được đếm đôi (RD-02). */
function chuan(luot, now) {
  const han = now == null ? Infinity : now;
  const ls = (luot || []).filter((a) => a && a.ts <= han).sort((a, b) => a.ts - b.ts || soSanhId(a.i, b.i) || a.g - b.g);
  return ls.filter((a, k) => k === 0 || a.ts !== ls[k - 1].ts || a.i !== ls[k - 1].i || a.g !== ls[k - 1].g);
}

/** Lần làm KHÔNG-bước của dạng (luyện tập, Ôn hôm nay, bài kiểm tra chuyên đề) — nguồn của "5 lần gần nhất". */
const laLanLam = (a, dangId) => a.c === dangId && !laBuoc(a.i);

/** id bài → muc, của kho luyện `dang.bai` (bài kiểm tra chuyên đề KHÔNG ở đây: chúng nằm ngoài `dang.bai`). */
const mucBaiCua = (dang) => new Map((dang.bai || []).filter((b) => b).map((b) => [b.id, b.muc]));

/**
 * Lượt Thử thách SAI / xem lời giải của kho dạng (`muc` = thu-thach, điểm 0 — g 1 hay g 0). Chủ dự án 2026-10-24 ("phương án b", theo tinh
 * thần "không phạt vì thử bài khó"): lượt này VÔ HÌNH với mức dạng — không vào dãy lần làm mà mức xét (5 lần gần nhất của 🟢, hai lần LIỀN
 * NHAU của ⭐, "lần điểm 0 gần nhất" đặt lại đồng hồ ⭐, "sai 2 lần liên tiếp" / "đã xem lời giải" của `canGiangLai`). Vẫn là một lượt
 * (`lanLam` liệt kê đủ, `luotLuyen` đọc chuỗi mức như mọi lượt); thẻ ôn `theOn` cũng bỏ lượt này (không hạ box / ease, không kéo hạn ôn). Thử thách
 * đúng (g ≥ 2) tính như cũ. Câu kiểm tra SOẠN SẴN (`<cd>.kt.<nn>`, không có trong `dang.bai`) không bị ảnh hưởng; đề GHÉP (`deKiemTra`) lấy chính
 * id bài luyện nên câu thu-thach sai trong đề ghép cũng vô hình — chấp nhận, vì sổ không ghi ngữ cảnh.
 */
const thuThachHut = (a, mucBai) => diemLan(a.g) === 0 && mucBai.get(a.i) === "thu-thach";

/**
 * Mức của dạng SAU từng lượt liên quan (bước của dạng hoặc lần làm của dạng) → [{ts, muc}] tăng dần theo ts, ĐÚNG một mục cho mỗi lượt.
 * Mức tính lại từ đầu trên toàn bộ lịch sử, nên tự tụt khi 5 lần gần nhất xấu đi (tiêu chí nâng 2026-10-23, chủ dự án duyệt).
 * "Lần làm" dưới đây KHÔNG gồm lượt Thử thách sai / xem lời giải (`thuThachHut`, 2026-10-24): lượt đó chỉ thêm một mục lặp lại mức trước nó.
 *   🟡 1: mọi bước của dạng đã có lượt · 🟢 2: ≥ 3 lần điểm 1 trong 5 lần gần nhất ·
 *   🔵 3: 🟢 + điểm 1 trên ≥ 2 bài chinh-phuc KHÁC NHAU + ≥ 1 bài thu-thach (ở bất kỳ đâu trong lịch sử; "bài" = id trong `dang.bai`) ·
 *   ⭐ 4: đang 🔵 và, sau ≥ 7 ngày, có HAI lần làm LIÊN TIẾP (liền nhau trong dãy lần làm của dạng) đều điểm 1, ≥ 1 trong hai là bài
 *         chinh-phuc / thu-thach. Đồng hồ 7 ngày tính từ G = max(T🔵, ts lần điểm 0 gần nhất): cả hai lần phải ts ≥ G + 7 ngày; mỗi lần
 *         điểm 0 (sai hay xem lời giải) sau khi lên 🔵 bắt đầu lại đồng hồ — trừ lượt Thử thách sai / xem lời giải (không đặt lại đồng hồ,
 *         cũng không chen vào giữa hai lần liền nhau). Lần ½ (g = 2) nằm giữa hai lần thì chúng KHÔNG liền nhau.
 * Kho thiếu bài thì đòi `min(cần, số bài có)`: dạng chỉ có 1 bài chinh-phuc → đòi 1; không có thu-thach → không đòi; dạng không có bài
 * chinh-phuc / thu-thach nào → 🔵 chỉ cần 🟢 và hai lần liên tiếp của ⭐ không cần là bài khó (không thì dạng đó không bao giờ 🔵).
 * T🔵 = ts của lượt đưa dạng lên 🔵 và đã giữ 🔵 liên tục từ đó (tụt rồi lên lại thì mốc 7 ngày tính lại).
 */
function chuoiMuc(dang, ls) {
  const buoc = dang.buoc || [];
  const cuaBuoc = new Set(buoc);
  const mucBai = mucBaiCua(dang);
  const coMuc = (m) => new Set((dang.bai || []).filter((b) => b && b.muc === m).map((b) => b.id)).size;
  const canCP = Math.min(CHINH_PHUC_TOI_THIEU, coMuc("chinh-phuc")), canTT = Math.min(THU_THACH_TOI_THIEU, coMuc("thu-thach"));
  const coKho = coMuc("chinh-phuc") + coMuc("thu-thach") > 0;
  const khoBai = (id) => KHO_BAI.has(mucBai.get(id));
  const daHoc = new Set();
  const lan = [];            // lần làm không-bước, tăng dần theo ts
  const cpDung = new Set();  // id các bài chinh-phuc đã từng điểm 1
  const ttDung = new Set();  // id các bài thu-thach đã từng điểm 1
  let tuLan0 = 0;            // ts lần điểm 0 gần nhất (sai hay xem lời giải)
  let batDau = null;         // T🔵 của đoạn 🔵 liên tục hiện tại
  const ra = [];
  for (const a of ls) {
    if (cuaBuoc.has(a.i)) daHoc.add(a.i);
    else if (laLanLam(a, dang.id)) {
      if (thuThachHut(a, mucBai)) { ra.push({ ts: a.ts, muc: ra.length ? ra[ra.length - 1].muc : 0 }); continue; }   // vô hình: mức giữ nguyên, vẫn một mục (luotLuyen đọc chuoi[k] theo ls[k])
      lan.push(a);
      if (diemLan(a.g) === 1) {
        const m = mucBai.get(a.i);
        if (m === "chinh-phuc") cpDung.add(a.i);
        else if (m === "thu-thach") ttDung.add(a.i);
      } else if (diemLan(a.g) === 0) tuLan0 = a.ts;
    } else continue;
    let dungGan = 0;   // số lần điểm 1 trong 5 lần gần nhất
    for (let k = Math.max(0, lan.length - GAN_NHAT); k < lan.length; k++) if (diemLan(lan[k].g) === 1) dungGan++;
    const xanh = dungGan >= DUNG_TOI_THIEU;
    const duBuoc = buoc.length > 0 && buoc.every((b) => daHoc.has(b));   // dạng không có bước nào: không bao giờ 🟡 chỉ vì "đủ bước"
    let muc = xanh ? 2 : duBuoc ? 1 : 0;
    if (xanh && cpDung.size >= canCP && ttDung.size >= canTT) {
      muc = 3;
      if (batDau === null) batDau = a.ts;
      // ⭐: hai lần làm liền nhau (p, q), cả hai điểm 1 và ts ≥ G + 7 ngày. `lan` tăng dần theo ts nên chỉ cần soi cái đuôi có ts ≥ mốc.
      const tu = Math.max(batDau, tuLan0) + CUA_SO_TUT;
      for (let k = lan.length - 1; k >= 1 && lan[k - 1].ts >= tu; k--) {
        const p = lan[k - 1], q = lan[k];
        // Hai BÀI KHÁC NHAU (RD-03): làm lại đúng một bài hai lần liền không chứng tỏ vững cả dạng.
        if (p.i !== q.i && diemLan(p.g) === 1 && diemLan(q.g) === 1 && (!coKho || khoBai(p.i) || khoBai(q.i))) { muc = 4; break; }
      }
    } else batDau = null;
    ra.push({ ts: a.ts, muc });
  }
  return ra;
}

/** Lượt liên quan tới dạng (bước của dạng hoặc lần làm của dạng) lấy từ dãy `ls` ĐÃ xếp + đã lọc tới `now` (kết quả `chuan`). */
function lichSuDangLs(dang, ls) {
  const cuaBuoc = new Set(dang.buoc || []);
  return ls.filter((a) => cuaBuoc.has(a.i) || laLanLam(a, dang.id));
}

/** Lượt liên quan tới dạng (bước của dạng hoặc lần làm của dạng), tới `now`, đã xếp. */
function lichSuDang(dang, luot, now) {
  return lichSuDangLs(dang, chuan(luot, now));
}

/** Mức của dạng từ dãy `ls` ĐÃ xếp tới `now` — như `mucDang` nhưng không xếp lại (hàm gọi nhiều dạng trên cùng một dãy). */
function mucLs(dang, ls) {
  if (!dang || dang.id == null) return 0;
  const c = chuoiMuc(dang, lichSuDangLs(dang, ls));
  return c.length ? c[c.length - 1].muc : 0;
}

/**
 * Các LẦN LÀM của dạng tính tới `now`, xếp tăng dần theo (ts, i, g) — luyện tập, Ôn hôm nay, bài kiểm tra chuyên đề; KHÔNG có bước /
 * thứ nằm trong bước bài giảng; lượt có ts > now bị bỏ. Đây là LỊCH SỬ ĐỦ để bố mẹ xem: gồm cả lượt Thử thách sai / xem lời giải
 * (`thuThachHut`) — lượt ấy chỉ không vào cửa sổ mức, xem `lanGanNhat`. Trang bố mẹ liệt kê từng lần làm bằng hàm này, không tự lọc lại.
 * Mảng mới; phần tử là các lượt đưa vào (không sao chép, không sửa).
 */
export function lanLam(dang, luot, now) {
  if (!dang || dang.id == null) return [];
  return chuan(luot, now).filter((a) => laLanLam(a, dang.id));
}

/**
 * "5 lần gần nhất" của dạng — cửa sổ mà luật 🟢 xét (≥ 3 lần điểm 1 trong đó): 5 lần cuối của `lanLam` SAU KHI bỏ lượt Thử thách sai / xem
 * lời giải (`thuThachHut`, 2026-10-24). Thử thách g ≥ 2 và câu bài kiểm tra chuyên đề vẫn ở trong. Trang bố mẹ dùng hàm này cho "đúng x/5".
 */
export function lanGanNhat(dang, luot, now) {
  if (!dang || dang.id == null) return [];
  const mucBai = mucBaiCua(dang);
  return lanLam(dang, luot, now).filter((a) => !thuThachHut(a, mucBai)).slice(-GAN_NHAT);
}

/**
 * Trong `lan` (các lượt của `lanLam`) những lượt KHÔNG tính vào mức dạng = lượt Thử thách sai / xem lời giải (`thuThachHut`) → Set theo CHÍNH
 * đối tượng lượt. Tab bố mẹ gắn nhãn "(không tính vào mức)" cho các dòng này (bảng vẫn liệt kê đủ). Dạng / `lan` thiếu → Set rỗng.
 */
export function lanKhongTinhVaoMuc(dang, lan) {
  const ra = new Set();
  if (!dang || dang.id == null || !Array.isArray(lan)) return ra;
  const mucBai = mucBaiCua(dang);
  for (const a of lan) if (a && thuThachHut(a, mucBai)) ra.add(a);
  return ra;
}

/** Mức của MỘT dạng tính tới `now`: 0 ⚪ chưa học · 1 🟡 · 2 🟢 · 3 🔵 · 4 ⭐. `dang` = {id, buoc, bai} (xem đầu file). */
export function mucDang(dang, luot, now) {
  if (!dang || dang.id == null) return 0;
  return mucLs(dang, chuan(luot, now));
}

/**
 * Mức CAO NHẤT dạng từng đạt trong lịch sử tới `now` (đỉnh của chuỗi mức sau từng lượt) — khác `mucDang` (mức HIỆN TẠI, tự tụt khi
 * 5 lần gần nhất xấu đi). Điểm mốc dạng (🟢 / 🔵 / ⭐) là MỘT LẦN, kể cả tụt rồi lên lại (worker/toan_diem.js): bố mẹ gỡ một lần làm
 * (3A) chỉ thu hồi mốc khi đỉnh của lịch sử CÒN LẠI không tới mốc đó — mức hiện tại thấp vì con vừa sai thì không phải lý do thu hồi.
 */
export function mucDinh(dang, luot, now) {
  if (!dang || dang.id == null) return 0;
  return Math.max(0, ...chuoiMuc(dang, lichSuDangLs(dang, chuan(luot, now))).map((p) => p.muc));
}

/**
 * Dòng tổng bài kiểm tra chuyên đề → {lan, dung, tong, dat} theo dòng MỚI NHẤT; chưa có dòng nào → null. `ls` đã xếp.
 * `dat` = ≥ 80% (x = "<đúng>/<tổng>", so bằng số nguyên) VÀ g = 3. Trang chấm ghi g = 3 khi đạt, 1 khi không — và "đạt" từ 2026-10-23
 * (chủ dự án duyệt) đòi thêm MỌI câu thu-thach của đề đúng, nên dòng 9/10 mà g = 1 là "đủ 80% nhưng sai một câu Thử thách".
 * Điều kiện thu-thach nằm ở nơi biết đề (trang, lúc Nộp) và đi theo g — không dựng lại từ lượt từng câu (không biết câu nào thuộc đề nào).
 * x hỏng (không đọc ra đúng/tổng): `dat` theo g.
 */
function datTong(m) {
  const r = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String(m.x ?? ""));
  if (!r) return { dung: null, tong: null, dat: m.g === 3 };   // x hỏng: dòng tổng ghi g = dat ? 3 : 1
  const dung = +r[1], tong = +r[2];
  return { dung, tong, dat: tong > 0 && dung * 10 >= tong * 8 && m.g === 3 };   // ≥ 0,8 bằng số nguyên, không dính số thực
}

function tongKiemTra(id, ls) {
  const dong = ls.filter((a) => a.i === `${id}.kiem-tra`);
  if (!dong.length) return null;
  return { lan: dong.length, ...datTong(dong[dong.length - 1]) };
}

/** Dạng CƠ BẢN của chuyên đề (R33): mức, da_hoc, dat và đề kiểm tra chỉ tính các dạng này. */
const dangCoBan = (cd) => (cd.dang || []).filter((d) => d && !d.nang_cao);

/** Mọi bước trong `buoc` (≥ 1 bước) đều có lượt (đúng id bước) trong tập id `coLuot`. Không có bước nào thì không thể "học hết". */
const hocHet = (buoc, coLuot) => !!buoc && buoc.length > 0 && buoc.every((b) => coLuot.has(b));

/**
 * "Xong bài giảng" của một dạng = chính điều kiện 🟡 của `mucDang` và `da_hoc` của `mucChuyenDe`: dạng có ≥ 1 bước và MỌI bước có lượt
 * (đúng id bước) tới `now`. Điểm thưởng bài giảng (worker/toan_diem.js) dùng đúng hàm này — một định nghĩa cho cả mức lẫn điểm.
 */
export function daHocDang(dang, luot, now) {
  if (!dang) return false;
  return hocHet(dang.buoc, new Set(chuan(luot, now).map((a) => a.i)));
}

/** "Xong phần Kiến thức" của chuyên đề: có ≥ 1 bước Kiến thức (`cd.kien_thuc`) và mọi bước có lượt tới `now`. */
export function daHocKienThuc(cd, luot, now) {
  if (!cd) return false;
  return hocHet(cd.kien_thuc, new Set(chuan(luot, now).map((a) => a.i)));
}

function mucCD(id, cd, ls, now) {
  const dang = dangCoBan(cd);
  const mucs = dang.map((d) => mucDang(d, ls, now));
  const coLuot = new Set(ls.map((a) => a.i));
  const kt = tongKiemTra(id, ls);
  // da_hoc tính THẲNG từ bước (không suy từ mức: dạng có thể 🟢 mà chưa học bài giảng): mỗi dạng có ≥ 1 bước và mọi bước
  // đều có lượt, cộng mọi bước Kiến thức. Dạng không có bước nào thì không thể "đã học hết bài giảng".
  const hocHetBuoc = (d) => !!d && hocHet(d.buoc, coLuot);
  return {
    muc: mucs.length ? Math.min(...mucs) : 0,
    da_hoc: dang.length > 0 && dang.every(hocHetBuoc) && (cd.kien_thuc || []).every((b) => coLuot.has(b)),
    dat: mucs.length > 0 && mucs.every((m) => m >= 2) && kt !== null && kt.dat,
    kt,
  };
}

/**
 * Mức của chuyên đề tính tới `now` → {muc: min mức các dạng, da_hoc: mọi bước của mọi dạng và mọi bước Kiến thức đều có lượt,
 * dat: mọi dạng ≥ 2 và bài kiểm tra chuyên đề mới nhất ≥ 80% và đúng mọi câu thu-thach của đề đó (xem `tongKiemTra`),
 * kt: {lan, dung, tong, dat} | null}. `cd` = kho.cd[id].
 * "Mọi dạng" = mọi dạng CƠ BẢN (R33): dạng `nang_cao` không kéo mức xuống, không chặn da_hoc / dat.
 */
export function mucChuyenDe(cd, luot, now) {
  if (!cd) return { muc: 0, da_hoc: false, dat: false, kt: null };
  return mucCD(idCD(cd), cd, chuan(luot, now), now);
}

/**
 * Chuyên đề TỪNG Đạt ở một thời điểm nào đó của lịch sử tới `now`? (≥ 1 thời điểm t mà `mucChuyenDe(cd, luot, t).dat`). Đạt cũng là MỘT LẦN
 * (+100 `toan:dat:<cd>`, worker/toan_diem.js) nên bố mẹ gỡ một lần làm chỉ thu hồi khi lịch sử còn lại không còn lúc nào Đạt. Một lượt quét:
 * chuỗi mức từng dạng cơ bản (`chuoiMuc`) và từng dòng tổng (`datTong`) là các hàm bậc thang theo ts — xét mọi mốc ts của chúng.
 */
export function tungDat(cd, luot, now) {
  if (!cd) return false;
  const ls = chuan(luot, now);
  const dang = dangCoBan(cd);
  if (!dang.length) return false;
  const chuoi = dang.map((d) => chuoiMuc(d, lichSuDangLs(d, ls)));
  const tong = ls.filter((a) => a.i === `${idCD(cd)}.kiem-tra`).map((a) => ({ ts: a.ts, dat: datTong(a).dat }));
  if (!tong.some((t) => t.dat)) return false;
  const moc = [...new Set([...chuoi.flatMap((c) => c.map((p) => p.ts)), ...tong.map((t) => t.ts)])].sort((a, b) => a - b);
  const vt = chuoi.map(() => 0);   // số phần tử đã đi qua của từng chuỗi
  let tg = 0;
  for (const t of moc) {
    chuoi.forEach((c, k) => { while (vt[k] < c.length && c[vt[k]].ts <= t) vt[k]++; });
    while (tg < tong.length && tong[tg].ts <= t) tg++;
    if (tg > 0 && tong[tg - 1].dat && chuoi.every((c, k) => vt[k] > 0 && c[vt[k] - 1].muc >= 2)) return true;
  }
  return false;
}

/**
 * "Xong bài giảng" + mức của các dạng có id trong tập `dangIds` (null = mọi dạng, kể cả nâng cao) của một chuyên đề, tính tới `now` →
 * [{id, hoc: `daHocDang`, muc: `mucDang`}…] theo thứ tự kho. Xếp lượt MỘT lần cho cả các dạng (Worker Free chỉ có 10 ms CPU — gọi
 * `mucDang` / `daHocDang` riêng từng dạng là xếp lại cả sổ mỗi lần). Điểm thưởng bài giảng + mốc dạng (worker/toan_diem.js) dùng hàm này.
 */
export function diemDang(cd, luot, now, dangIds = null) {
  if (!cd) return [];
  const ls = chuan(luot, now);
  const co = new Set(ls.map((a) => a.i));
  return (cd.dang || []).filter((d) => d && d.id != null && (!dangIds || dangIds.has(d.id)))
    .map((d) => ({ id: d.id, hoc: hocHet(d.buoc, co), muc: mucLs(d, ls) }));
}

/**
 * Lý do bố mẹ nên giảng lại dạng, hoặc null. "Lần làm" ở đây là dãy của cửa sổ mức (`lanGanNhat`): lượt Thử thách sai / xem lời giải
 * (`thuThachHut`) không thành lý do nào (2026-10-24). Thứ tự ưu tiên:
 *   "sai 2 lần liên tiếp" (hai lần làm cuối đều sai — g = 1; xem lời giải g = 0 không phải "sai") ›
 *   "đã xem lời giải" (g = 0 trong 5 lần gần nhất) ›
 *   "tụt mức khi ôn" (mức hiện tại thấp hơn mức cao nhất trong 7 ngày qua, kể cả mức đang giữ lúc bắt đầu cửa sổ).
 */
export function canGiangLai(dang, luot, now) {
  if (!dang || dang.id == null) return null;
  const ls = lichSuDang(dang, luot, now);
  const mucBai = mucBaiCua(dang);
  const lan = ls.filter((a) => laLanLam(a, dang.id) && !thuThachHut(a, mucBai));   // cùng dãy với cửa sổ mức: Thử thách sai / xem lời giải không thành lý do
  const sai = (a) => diemLan(a.g) === 0 && a.g >= 1;
  if (lan.length >= 2 && sai(lan[lan.length - 1]) && sai(lan[lan.length - 2])) return "sai 2 lần liên tiếp";
  if (lan.slice(-GAN_NHAT).some((a) => a.g === 0)) return "đã xem lời giải";
  const chuoi = chuoiMuc(dang, ls);
  if (chuoi.length) {
    const tu = now - CUA_SO_TUT;
    let cao = 0;   // mức đang có lúc `tu`, rồi tăng theo các mức đạt trong cửa sổ (tu, now]
    for (const p of chuoi) {
      if (p.ts <= tu) cao = p.muc;
      else if (p.muc > cao) cao = p.muc;
    }
    if (chuoi[chuoi.length - 1].muc < cao) return "tụt mức khi ôn";
  }
  return null;
}

/** Thẻ ôn của mọi dạng mức ≥ 2 trong kho → [{d, due}] xếp hạn sớm nhất trước (cùng hạn giữ thứ tự kho). `ls` đã chuan. */
function theOn(kho, ls, now) {
  const ung = [];
  for (const cd of Object.values((kho && kho.cd) || {})) {
    for (const d of (cd && cd.dang) || []) {
      if (mucDang(d, ls, now) < 2) continue;
      // thẻ dạng phát lại các lần làm không-bước (`laLanLam`, thứ tự (ts, i, g)) TRỪ lượt Thử thách sai / xem lời giải (`thuThachHut`, 2026-10-24,
      // rà soát I1): lượt đó không hạ box / ease và không kéo hạn ôn — cùng tinh thần "không phạt vì thử bài khó" như mức dạng
      const mucBai = mucBaiCua(d);
      const lan = ls.filter((a) => laLanLam(a, d.id) && !thuThachHut(a, mucBai)).map((a) => ({ g: a.g, ok: a.g >= 2, ts: a.ts }));
      ung.push({ d, due: phatLai(d.id, lan).due });
    }
  }
  return ung.sort((a, b) => a.due - b.due);   // sort ổn định: cùng hạn giữ thứ tự kho
}

/**
 * "Ôn hôm nay" → id bài (≤ 10, thường ≥ 5 khi kho đủ). Mỗi dạng mức ≥ 2 có thẻ dạng = phatLai(id dạng, các lần làm
 * không-bước); đến hạn khi due ≤ now. Lấy dạng hạn sớm nhất trước, mỗi dạng 2 bài (bài chưa làm trước theo thứ tự kho, rồi
 * bài lâu chưa làm nhất; không lấy bài kiểm tra vì chúng nằm ngoài `dang[].bai`, không lấy bài thu-thach — tuỳ chọn, ngoài
 * lượt, ruling R31). Dừng ở 10. Chưa đủ 5 thì kéo thêm dạng
 * CHƯA đến hạn nhưng gần hạn nhất, từng dạng một, cho tới khi đủ 5 hoặc hết dạng. Không dạng nào ≥ 2 → [].
 * R31 sửa 2026-10-24 (chủ dự án: "Ôn hôm nay ra thêm bài Thử thách"): danh sách này GIỮ NGUYÊN (không thu-thach, trần 10); bài Thử
 * thách của ngày là MỘT bài riêng, đứng cuối và NGOÀI trần — `thuThachHomNay` (trang ghép hai hàm).
 */
export function onHomNay(kho, luot, now) {
  const ls = chuan(luot, now);
  const lanCuoi = new Map();   // id bài → ts lần làm gần nhất (ls đã xếp: ghi đè = lần mới nhất)
  for (const a of ls) lanCuoi.set(a.i, a.ts);
  const ung = theOn(kho, ls, now);
  const ra = [];
  for (const { d, due } of ung) {
    if (ra.length >= TOI_DA_ON) break;
    if (due > now && ra.length >= TOI_THIEU_ON) break;   // dạng chưa tới hạn chỉ để bù cho đủ 5
    const kho = (d.bai || []).filter((b) => b.muc !== "thu-thach");   // R31: thu-thach không vào danh sách này (mỗi ngày có MỘT bài riêng: thuThachHomNay)
    const chua = kho.filter((b) => !lanCuoi.has(b.id));
    const cu = kho.filter((b) => lanCuoi.has(b.id)).sort((x, y) => lanCuoi.get(x.id) - lanCuoi.get(y.id));
    for (const b of [...chua, ...cu].slice(0, BAI_MOI_DANG)) ra.push(b.id);
  }
  return ra.slice(0, TOI_DA_ON);
}

/**
 * Bài Thử thách CỦA NGÀY → id một bài `thu-thach` | null (R31 sửa 2026-10-24, chủ dự án: "Ôn hôm nay ra thêm bài Thử thách").
 * Trang xếp nó CUỐI mục Ôn hôm nay, NGOÀI trần `TOI_DA_ON` của `onHomNay` (danh sách ôn không đổi), nhãn "🏆 Thử thách".
 * Chọn: các dạng đã ≥ 🟢 (mức ≥ 2; 🔵 ⭐ cũng được) — dạng CƠ BẢN trước, NÂNG CAO sau — lấy bài `thu-thach` CHƯA TỪNG ĐÚNG (không lượt
 * g 3 / g 2 nào của id đó): bài chưa làm lần nào trước (thứ tự kho), rồi bài có lần làm gần nhất LÂU nhất. Thứ tự là chung cho mọi dạng
 * (cơ bản › chưa làm › làm lâu nhất › thứ tự kho), nên bài chưa làm của dạng sau đứng trước bài đã làm sai của dạng trước.
 * Không dạng nào ≥ 🟢, hoặc mọi bài thu-thach của dạng ≥ 🟢 đã từng đúng → null (KHÔNG thay bằng bài khác).
 * "Từng đúng" KHÔNG tính lượt g 3 / g 2 có SAU khi con đã xem lời giải bài đó (lượt g 0) cùng ngày VN — như `daXemLoiGiai` (RD-04, 2026-10-24):
 * trang ghi g 0 cho đáp số gõ lại sau khi xem lời giải, nhưng sổ cũ / máy khác có thể còn lượt đúng sau lần xem; bài đó chưa được coi là đã làm được.
 *
 * ỔN ĐỊNH TRONG NGÀY VN: tính trên sổ như lúc 00:00 giờ VN của ngày chứa `now` (lượt ts ≥ 00:00:00 hôm nay không tính; cả mức dạng cũng
 * đo lúc đó). Mở lại trang cùng ngày — kể cả sau khi con vừa làm đúng bài đó, sai bài đó, hay một dạng vừa lên / tụt 🟢 — vẫn ra CÙNG bài;
 * sang ngày VN mới thì tính lại (bài hôm qua làm đúng thì bỏ; dạng vừa lên 🟢 hôm qua mới có bài). Vì sao không tính theo sổ hiện tại như
 * `onHomNay`: danh sách ôn là việc cần làm, làm xong thì biến / đổi bài; còn Thử thách là MỘT bài mỗi ngày — làm xong mà bài khác hiện ra
 * ngay thì thành vô hạn bài mỗi ngày, và con làm sai thì lại bị đổi bài ngay lúc đang muốn thử lại.
 * Hàm thuần; mọi thứ khác (không sửa đầu vào, không phụ thuộc thứ tự lượt) như các hàm trong tệp.
 */
export function thuThachHomNay(kho, luot, now) {
  const dauNgay = Math.floor((now + VN) / NGAY) * NGAY - VN;   // 00:00:00 giờ VN của ngày chứa `now`
  const ls = chuan(luot, now).filter((a) => a.ts < dauNgay);   // ảnh chụp đầu ngày: lượt từ 00:00:00 hôm nay trở đi chưa tính
  const lanCuoi = new Map(), dung = new Set();   // id → ts lần làm gần nhất (ls đã xếp) · id từng đúng (g 3 / g 2)
  const xem = new Set();                          // `<id>|<ngày VN>` đã mở lời giải (g 0) tính tới lượt đang xét — ls xếp (ts, i, g) nên g 0 đứng trước g ≥ 2 cùng ts
  for (const a of ls) {
    lanCuoi.set(a.i, a.ts);
    const kn = `${a.i}|${ngayCua(a.ts)}`;
    if (a.g === 0) xem.add(kn);
    // RD-04: đúng SAU khi đã xem lời giải bài đó cùng ngày VN không tính là "từng đúng" — chính là `daXemLoiGiai(a.i, ls, a.ts)`, chạy một lượt
    else if (a.g >= 2 && !xem.has(kn)) dung.add(a.i);
  }
  const ung = [];
  for (const cd of Object.values((kho && kho.cd) || {})) {
    for (const d of (cd && cd.dang) || []) {
      const con = (d && d.bai || []).filter((b) => b && b.muc === "thu-thach" && !dung.has(b.id));
      if (!con.length || mucLs(d, ls) < 2) continue;
      for (const b of con) ung.push({ id: b.id, nc: d.nang_cao ? 1 : 0, cu: lanCuoi.has(b.id) ? 1 : 0, ts: lanCuoi.get(b.id) || 0, k: ung.length });
    }
  }
  ung.sort((p, q) => p.nc - q.nc || p.cu - q.cu || p.ts - q.ts || p.k - q.k);
  return ung.length ? ung[0].id : null;
}

/**
 * Trạng thái một buổi của lộ trình: "sap_co" (có chuyên đề không có trong kho, buổi chưa có chuyên đề nào, hoặc buổi có
 * `kiem_tra`) › "xong" (mọi chuyên đề `dat`) › "dang_hoc" (có lượt nào của chuyên đề trong buổi) › "chua_toi".
 */
export function trangThaiBuoi(buoi, kho, luot, now) {
  const ds = (buoi && buoi.chuyen_de) || [];
  const cd = (kho && kho.cd) || {};
  if (!buoi || buoi.kiem_tra || !ds.length || ds.some((id) => !cd[id])) return "sap_co";
  const ls = chuan(luot, now);
  if (ds.every((id) => mucCD(id, cd[id], ls, now).dat)) return "xong";
  const trong = new Set(ds);
  return ls.some((a) => trong.has(tiengCD(a.c)) || trong.has(tiengCD(a.i))) ? "dang_hoc" : "chua_toi";
}

/** Các buổi của lộ trình theo thứ tự (giai_doan[].buoi[]); lộ trình thiếu / hỏng → []. */
function cacBuoi(loTrinh) {
  const ra = [];
  for (const g of (loTrinh && loTrinh.giai_doan) || []) for (const b of (g && g.buoi) || []) if (b) ra.push(b);
  return ra;
}

/** Số buổi một mục chiếm: `so: [a, b]` (mục gộp) → b−a+1; còn lại (số đơn, hỏng) → 1. */
function soBuoiCua(buoi) {
  const n = Array.isArray(buoi.so) ? buoi.so[1] - buoi.so[0] + 1 : 1;
  return n >= 1 ? n : 1;
}

/**
 * Buổi con ĐANG Ở trong một lộ trình (ruling R22 — MỘT luật cho trang con và tab bố mẹ): buổi đầu tiên theo thứ tự lộ trình có
 * `trangThaiBuoi` = "dang_hoc"; không có thì buổi đầu tiên "chua_toi". Buổi "sap_co" và "xong" bỏ qua. Mọi buổi xong hoặc sắp có
 * hết → null. Trả CHÍNH đối tượng buổi trong `loTrinh` (không sao chép). `loTrinh` = {giai_doan: [{buoi: [buổi…]}…]}.
 */
export function buoiHienTai(loTrinh, kho, luot, now) {
  const ds = cacBuoi(loTrinh).map((b) => ({ b, tt: trangThaiBuoi(b, kho, luot, now) }));
  const hien = ds.find((x) => x.tt === "dang_hoc") || ds.find((x) => x.tt === "chua_toi");
  return hien ? hien.b : null;
}

/**
 * "Đã xong X/T buổi" của một lộ trình (R22): xong = số buổi ở trạng thái "xong"; tong = mọi buổi. Mục gộp `so: [a, b]` tính
 * b−a+1 buổi (lộ trình của cô: tong = 40, không phải số mục).
 */
export function soBuoiXong(loTrinh, kho, luot, now) {
  let xong = 0, tong = 0;
  for (const b of cacBuoi(loTrinh)) {
    const n = soBuoiCua(b);
    tong += n;
    if (trangThaiBuoi(b, kho, luot, now) === "xong") xong += n;
  }
  return { xong, tong };
}

/**
 * Đề kiểm tra chuyên đề cần làm bây giờ → [id bài…] (ruling R24, spec §5 "không đạt thì làm lại bằng đề ghép từ các bài con
 * chưa làm trong kho luyện của các dạng — không soạn thêm đề thứ hai").
 *   - Chưa có dòng tổng `<cd>.kiem-tra` nào, hoặc dòng MỚI NHẤT đạt → đề soạn sẵn `cd.kiem_tra` (bản sao, giữ thứ tự).
 *   - Dòng mới nhất KHÔNG đạt → đề ghép cùng cỡ: mỗi dạng CƠ BẢN lấy ĐÚNG số câu như đề soạn sẵn (đếm theo `dangKt`), từ kho LUYỆN của
 *     dạng đó (`dang.bai`; dạng nâng cao không có phần — R33): bài con chưa từng làm trước (theo id), rồi bài làm lâu nhất (ts lần gần nhất tăng dần, rồi id).
 *     Dạng thiếu bài thì phần hụt chia lần lượt (vòng tròn theo thứ tự dạng) cho các dạng còn bài; tổng kho nhỏ hơn cỡ đề thì đề ngắn
 *     hơn. Kết quả xếp theo id — tất định: cùng (cd, luot, now) ra cùng đề.
 * `dangKt` = {id bài kiểm tra: id dạng} (trường `dang` của bài kiểm tra trong kho.json `bai`; kho.cd không mang nó — khuôn R1).
 * Bài kiểm tra không có trong `dangKt` (hoặc trỏ dạng lạ) được tính là phần hụt, chia vòng tròn như trên.
 * Lượt "đã làm" = lượt bất kỳ có i = id bài (luyện, ôn, đề ghép trước). Chỉ tính lượt có ts ≤ now.
 */
export function deKiemTra(cd, luot, now, dangKt) {
  if (!cd) return [];
  const goc = [...(cd.kiem_tra || [])];
  const ls = chuan(luot, now);
  const kt = tongKiemTra(idCD(cd), ls);
  if (!kt || kt.dat) return goc;
  const lanCuoi = new Map();
  for (const a of ls) lanCuoi.set(a.i, a.ts);
  const dang = dangCoBan(cd);   // R33: đề kiểm tra (kể cả đề ghép) KHÔNG bao giờ lấy từ dạng nâng cao; bài kiểm tra trỏ dạng nâng cao = phần hụt
  const can = new Map(dang.map((d) => [d.id, 0]));
  let hut = 0;
  for (const id of goc) {
    const d = dangKt && dangKt[id];
    if (can.has(d)) can.set(d, can.get(d) + 1);
    else hut++;
  }
  // kho từng dạng, đã xếp: chưa làm (theo id) → đã làm (lâu nhất trước, rồi id)
  const kho = new Map(dang.map((d) => {
    const ids = (d.bai || []).map((b) => b.id);
    const chua = ids.filter((i) => !lanCuoi.has(i)).sort(soSanhId);
    const cu = ids.filter((i) => lanCuoi.has(i)).sort((x, y) => lanCuoi.get(x) - lanCuoi.get(y) || soSanhId(x, y));
    return [d.id, [...chua, ...cu]];
  }));
  const ra = [];
  const dung = new Map(dang.map((d) => [d.id, 0]));   // số bài đã lấy của mỗi dạng
  for (const d of dang) {
    const n = Math.min(can.get(d.id), kho.get(d.id).length);
    ra.push(...kho.get(d.id).slice(0, n));
    dung.set(d.id, n);
    hut += can.get(d.id) - n;
  }
  while (hut > 0) {
    let lay = false;
    for (const d of dang) {
      if (hut <= 0) break;
      const k = dung.get(d.id);
      if (k < kho.get(d.id).length) { ra.push(kho.get(d.id)[k]); dung.set(d.id, k + 1); hut--; lay = true; }
    }
    if (!lay) break;   // mọi kho đã cạn
  }
  return ra.sort(soSanhId);
}

// ═══════════════════════════ Lượt luyện tập 5 bài (Task 12b — quyết định chủ dự án 2026-10-21) ═══════════════════════════
const MUC_LUOT = ["mo-khoa", "tang-toc", "chinh-phuc"];          // thu-thach KHÔNG vào lượt (nút "🏆 Thử thách" riêng)
const SUAT_LUOT = { "mo-khoa": 2, "tang-toc": 2, "chinh-phuc": 1 };
const CO_LUOT = 5;          // cỡ một lượt (= tổng SUAT_LUOT)
const SOM_LUOT = 3;         // dừng sớm: dạng LÊN 🟢 trong lượt sau ≥ 3 bài của lượt

/**
 * Chọn bài cho MỘT lượt từ kho luyện của dạng, theo trạng thái sổ `lanCuoi` (id bài → ts lần làm gần nhất). Mỗi mức lấy theo
 * suất (2 mo-khoa · 2 tang-toc · 1 chinh-phuc); trong một mức: bài CHƯA làm trước (theo thứ tự kho), rồi bài làm lâu nhất (ts, rồi
 * id). Mức thiếu bài → suất hụt lấy từ mức LÂN CẬN (gần trước; cách đều thì mức dễ hơn trước). Kết quả xếp khó dần: theo mức, trong
 * mức theo thứ tự ưu tiên. Kho (không tính thu-thach) < 5 bài → lượt ngắn hơn.
 */
function chonLuot(dang, lanCuoi) {
  const theoMuc = MUC_LUOT.map((m) => {
    const ds = (dang.bai || []).filter((b) => b && b.muc === m).map((b) => b.id);
    const chua = ds.filter((i) => !lanCuoi.has(i));
    const cu = ds.filter((i) => lanCuoi.has(i)).sort((x, y) => lanCuoi.get(x) - lanCuoi.get(y) || soSanhId(x, y));
    return [...chua, ...cu];
  });
  const lay = MUC_LUOT.map(() => 0);   // số bài đã lấy ở mỗi mức (lấy từ ĐẦU danh sách ưu tiên của mức)
  const hut = MUC_LUOT.map((m, k) => {
    lay[k] = Math.min(SUAT_LUOT[m], theoMuc[k].length);
    return SUAT_LUOT[m] - lay[k];
  });
  for (let k = 0; k < MUC_LUOT.length; k++) {
    // láng giềng theo khoảng cách, cách đều thì mức dễ (chỉ số nhỏ) trước
    const gan = MUC_LUOT.map((_, q) => q).filter((q) => q !== k).sort((p, q) => Math.abs(p - k) - Math.abs(q - k) || p - q);
    for (const q of gan) {
      while (hut[k] > 0 && lay[q] < theoMuc[q].length) { lay[q]++; hut[k]--; }
    }
  }
  return theoMuc.flatMap((ds, k) => ds.slice(0, lay[k]));
}

/**
 * Lượt luyện tập của MỘT dạng tính tới `now` — dựng lại HOÀN TOÀN từ sổ (mở lại trang / máy khác vẫn tiếp đúng chỗ) →
 *   {bai: [id…] (lượt hiện tại, khó dần, ≤ 5), lam: [{i, g}…] (bài của lượt đã làm, theo thứ tự làm), da_lam: lam.length,
 *    dung: số bài trong `lam` có g ≥ 2 (đúng, kể cả sau gợi ý), tiep: bài kế (bài đầu tiên của `bai` chưa làm) | null,
 *    xong, som (xong vì lên 🟢 trước bài cuối), dat (xong và mức dạng lúc kết lượt ≥ 2), muc (mức dạng lúc kết / hiện tại),
 *    moi: [id…] bài của lượt KẾ (chỉ khi xong — nút "Luyện thêm") | null, so_xong: số lượt ĐÃ XONG của dạng (tính tới now; lượt
 *    đang mở không tính) — "Tiếp tục" dùng nó để biết dạng đã có lượt đầu xong chưa (R29/R30)}.
 *
 * LUẬT MỞ LƯỢT (tất định, chỉ đọc sổ): duyệt các lượt của dạng theo (ts, i, g). "Lần làm luyện" = lần làm (không-bước) của dạng có
 * id là bài trong kho luyện mức mo-khoa / tang-toc / chinh-phuc (thu-thach không tính). Khi KHÔNG có lượt nào đang mở, một lần
 * làm luyện MỞ lượt mới nếu bài đó nằm trong `chonLuot` tính từ sổ NGAY TRƯỚC lần làm đó (tức đúng 5 bài trang đang mời làm); lần
 * làm ngoài danh sách đó không mở lượt. Trong lượt đang mở, lần làm ĐẦU TIÊN của mỗi bài thuộc lượt được đếm (làm lại, bài ngoài
 * lượt, bài kiểm tra: không đếm). Lượt XONG khi đếm đủ mọi bài của lượt, hoặc SỚM khi dạng LÊN 🟢 trong lượt (mức trước lần làm
 * đầu tiên của lượt < 2, mức sau một lần làm đếm được ≥ 2) sau ≥ 3 bài — dạng đã 🟢 từ trước thì làm đủ để tới bài Chinh phục (🔵).
 * Lượt xong thì lần làm luyện kế tiếp (thường là bài đầu của `moi`, khi con bấm "Luyện thêm") mở lượt mới theo đúng luật trên.
 * ⚠ Sổ không ghi ngữ cảnh (luyện / Ôn hôm nay / đề ghép kiểm tra đều chỉ là lượt trên id bài): lần làm một bài kho luyện ở Ôn hôm
 * nay hay đề ghép cũng được đếm nếu nó thuộc lượt đang mở — cùng dạng, cùng kho, nên vẫn là luyện đúng dạng đó.
 * Chưa từng mở lượt → lượt "chưa bắt đầu": `bai` = chonLuot(sổ tới now), lam rỗng.
 */
export function luotLuyen(dang, luot, now) {
  const rong = { bai: [], lam: [], da_lam: 0, dung: 0, tiep: null, xong: false, som: false, dat: false, muc: 0, moi: null, so_xong: 0 };
  if (!dang || dang.id == null) return rong;
  const kho = new Set((dang.bai || []).filter((b) => b && MUC_LUOT.includes(b.muc)).map((b) => b.id));
  const ls = lichSuDang(dang, luot, now);
  const chuoi = chuoiMuc(dang, ls);   // cùng độ dài với ls: mức SAU từng lượt
  const lanCuoi = new Map();
  let R = null, cuoi = null, mucTruoc = 0, soXong = 0;
  for (let k = 0; k < ls.length; k++) {
    const a = ls[k], sau = chuoi[k].muc;
    const laLam = laLanLam(a, dang.id);
    if (laLam && kho.has(a.i)) {
      if (!R) {
        const S = chonLuot(dang, lanCuoi);
        if (S.includes(a.i)) R = { bai: S, lam: [], dau: mucTruoc, muc: mucTruoc };
      }
      if (R && R.bai.includes(a.i) && !R.lam.some((x) => x.i === a.i)) {
        R.lam.push({ i: a.i, g: a.g });
        R.muc = sau;
        const som = R.lam.length >= SOM_LUOT && R.dau < 2 && sau >= 2;
        if (R.lam.length >= R.bai.length || som) {
          R.som = R.lam.length < R.bai.length;
          cuoi = R;
          soXong++;
          R = null;
        }
      }
    }
    if (laLam) lanCuoi.set(a.i, a.ts);
    mucTruoc = sau;
  }
  const ra = (x, xong) => ({
    bai: [...x.bai], lam: x.lam.map((e) => ({ ...e })), da_lam: x.lam.length, dung: x.lam.filter((e) => e.g >= 2).length,
    tiep: xong ? null : (x.bai.find((i) => !x.lam.some((e) => e.i === i)) ?? null),
    xong, som: xong && !!x.som, dat: xong && x.muc >= 2, muc: xong ? x.muc : mucTruoc,
    moi: xong ? chonLuot(dang, lanCuoi) : null,
    so_xong: soXong,
  });
  if (R) return ra(R, false);
  if (cuoi) return ra(cuoi, true);
  return ra({ bai: chonLuot(dang, lanCuoi), lam: [] }, false);
}

/**
 * "Tiếp tục" của trang chuyên đề → việc kế tiếp con nên làm (MỘT luật, thuần — ruling R29 + R30 + R33), theo thứ tự:
 *   1. bước Kiến thức cần nhớ đầu tiên chưa có lượt → {loai: "kien-thuc", id, k, n}
 *   2. TỪNG DẠNG CƠ BẢN THEO THỨ TỰ: bước bài giảng đầu tiên chưa có lượt → {loai: "bai-giang", dang, id, k, n}; học hết bài giảng mà
 *      dạng dưới 🟢 và CHƯA có lượt luyện nào xong (`luotLuyen().so_xong === 0`: chưa bắt đầu, hoặc lượt ĐẦU đang mở) → lượt đó
 *      {loai: "luyen", dang, id: bài kế, k, n, them: false}. Lượt đầu xong rồi thì sang dạng sau DÙ CHƯA 🟢 (R30: không quẩn ở một
 *      dạng) — kể cả khi dạng đó đang mở một lượt luyện thêm (lượt ấy chờ tới bước 5).
 *   3. bài kiểm tra chuyên đề chưa đạt (chưa làm, hoặc lần mới nhất < 80% — trang ra đề ghép) → {loai: "kiem-tra", id: "<cd>.kiem-tra"}
 *   4. TỪNG DẠNG NÂNG CAO (`nang_cao`, R33) theo thứ tự, cùng luật bước 2 (bài giảng › lượt luyện đầu) — SAU kiểm tra, vì kiểm tra
 *      chuyên đề chỉ gồm dạng cơ bản.
 *   5. "luyện thêm": dạng CƠ BẢN còn dưới 🟢 (theo thứ tự), rồi dạng NÂNG CAO còn dưới 🟢 → {loai: "luyen", dang, id, k, n, them: true}:
 *      lượt đang mở thì làm tiếp (bài kế), không thì bài đầu của lượt mới `moi`.
 *   Dạng ≥ 🟢 không bao giờ được bước 2 / 4 / 5 trả về (lượt mở trên dạng 🟢 — vd Ôn hôm nay làm bài kho luyện — không kéo con về luyện).
 *   6. có dạng của chuyên đề (kể cả nâng cao) đến hạn ôn (thẻ phatLai, due ≤ now — cùng thẻ `onHomNay`) → {loai: "on", id: null};
 *      không thì {loai: "xong", id: null} (đã xong chuyên đề, chưa tới hạn ôn).
 * Dạng không có bài luyện thường (kho chỉ thu-thach) bỏ qua ở bước 2, 4 và 5. `cd` = kho.cd[id]; `bat_dau` = chuyên đề đã có lượt
 * nào chưa (trang ghi "Bắt đầu" thay vì "Tiếp tục").
 */
export function tiepTuc(cd, luot, now) {
  if (!cd) return { loai: "xong", id: null, bat_dau: false };
  const ls = chuan(luot, now);
  const co = new Set(ls.map((a) => a.i));
  const cid = idCD(cd);
  const dangs = cd.dang || [];
  const coBan = dangs.filter((d) => !d.nang_cao), nangCao = dangs.filter((d) => d.nang_cao);   // R33; thứ tự tương đối giữ nguyên
  const cuaCd = new Set([...(cd.kien_thuc || []), ...dangs.flatMap((d) => [...(d.buoc || []), ...(d.bai || []).map((b) => b.id)]),
    ...(cd.kiem_tra || []), `${cid}.kiem-tra`]);
  const bat_dau = ls.some((a) => cuaCd.has(a.i) || dangs.some((d) => d.id === a.c));
  const kt = cd.kien_thuc || [];
  const k1 = kt.findIndex((b) => !co.has(b));
  if (k1 >= 0) return { loai: "kien-thuc", id: kt[k1], k: k1 + 1, n: kt.length, bat_dau };
  const luyen = (d, r, them) => {
    const ds = r.xong ? r.moi : r.bai, id = r.xong ? r.moi[0] : r.tiep;
    return { loai: "luyen", dang: d.id, id, k: ds.indexOf(id) + 1, n: ds.length, them, bat_dau };
  };
  // Một dạng: bước bài giảng đầu tiên chưa có lượt › lượt luyện ĐẦU (chỉ khi dạng chưa có lượt nào xong — chưa bắt đầu / lượt đầu đang
  // mở — và còn dưới 🟢). null = dạng này xong phần học + lượt đầu.
  const hocDang = (d) => {
    const bs = d.buoc || [];
    const k = bs.findIndex((b) => !co.has(b));
    if (k >= 0) return { loai: "bai-giang", dang: d.id, id: bs[k], k: k + 1, n: bs.length, bat_dau };
    const r = luotLuyen(d, ls, now);
    return r.so_xong === 0 && r.bai.length && mucDang(d, ls, now) < 2 ? luyen(d, r, false) : null;
  };
  // "Luyện thêm" của các dạng dưới 🟢 (theo thứ tự): lượt đang mở thì làm tiếp, không thì lượt mới.
  const luyenThem = (ds) => {
    for (const d of ds) {
      if (mucDang(d, ls, now) >= 2) continue;
      const r = luotLuyen(d, ls, now);
      if ((r.xong ? r.moi : r.bai).length) return luyen(d, r, true);
    }
    return null;
  };
  for (const d of coBan) { const v = hocDang(d); if (v) return v; }
  if (!mucCD(cid, cd, ls, now).kt?.dat) return { loai: "kiem-tra", id: `${cid}.kiem-tra`, bat_dau };
  // R33: dạng nâng cao học SAU kiểm tra (kiểm tra chỉ gồm dạng cơ bản, nên không chặn trước nó); luyện thêm: cơ bản trước, nâng cao sau
  for (const d of nangCao) { const v = hocDang(d); if (v) return v; }
  const them = luyenThem(coBan) || luyenThem(nangCao);
  if (them) return them;
  if (theOn({ cd: { [cid]: cd } }, ls, now).some((x) => x.due <= now)) return { loai: "on", id: null, bat_dau };
  return { loai: "xong", id: null, bat_dau };
}

/**
 * Bài / bước / ô `id` đã được MỞ LỜI GIẢI hôm nay chưa? = sổ có lượt g 0 ("xem lời giải") của ĐÚNG id, trong cùng ngày lịch giờ VN
 * (UTC+7, `Math.floor((ts + 25200) / 86400)`) với `now`. Lượt có ts > now bị bỏ (như mọi hàm ở đây). RB-08 (chủ dự án 2026-10-23: "nhớ
 * trạng thái, nếu hôm sau làm lại thì mới cộng điểm"): `lan` / `nac` của trang chỉ sống trong một lần mở trang, nên tải lại thì con
 * thấy đáp số rồi gõ lại sẽ được g 3 / 2. Trang dùng hàm này để coi bài đó là ĐÃ mở lời giải (hiện lại lời giải, đáp số gõ lại ghi
 * g 0); sang ngày VN mới thì hàm trả false và bài chấm bình thường.
 */
export function daXemLoiGiai(id, luot, now) {
  const ngay = ngayCua(now);
  return luot.some((l) => l.i === id && l.g === 0 && l.ts <= now && ngayCua(l.ts) === ngay);
}
