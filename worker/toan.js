/**
 * Ôn tập Toán 6 (spec 2026-10-21 on-tap-toan-6): đọc lại lịch sử làm bài của trẻ.
 *
 * KHÔNG có đường ghi riêng. Trang Toán ghi bằng `POST /api/study?user=pl&course=toan-6` {attempts:[…]} — cùng `writeSession`
 * (worker/study.js) với trang ôn tập: kẹp mốc/box/ease/due, 2 câu lệnh bất kể độ dài, cộng điểm theo luật RIÊNG của Toán (`congToan`,
 * worker/toan_diem.js, ADR 0070) khi manifest điểm có môn `toan-6` kèm cấu trúc `toan` (src/builder.py `_mon_toan`). Bảng `attempt` là nguồn sự thật, nên mức thành thạo của từng
 * dạng bài (spec §6) TÍNH LẠI từ đây mỗi lần mở trang — không có bảng thứ hai để lệch.
 *
 * Đọc bằng một câu lệnh hai tham số, cột + hàng như `readCards` (≈ 1/3 số byte của mảng object; Worker Free chỉ có 10 ms CPU).
 * Không phân trang, cố ý: một năm học ≈ vài nghìn dòng × ~50 byte; chỉ phải nghĩ lại khi trang thật sự chậm (khi đó thêm
 * `ts >= ?3`, đừng cắt LIMIT — mức thành thạo cần "5 lần làm gần nhất" của MỖI dạng, cắt theo tổng làm mất dạng ít làm).
 */

export const MON_TOAN = "toan-6";   // slug môn ghi sổ — cùng hằng TOAN_SLUG của src/builder.py

/**
 * Mọi lượt làm Toán của học sinh, cũ trước mới sau (cùng mốc thì theo thứ tự ghi). Dạng cột + hàng:
 * i = id bài, c = id dạng (concept), g = điểm 0..3 (3 đúng không gợi ý · 2 đúng sau gợi ý · 1 sai · 0 xem lời giải),
 * ts = epoch giây (đã kẹp ở máy chủ), x = đáp số con gõ (≤ 64 ký tự) hoặc null. 1 câu lệnh, 2 tham số.
 */
export async function readLuot(env, user) {
  const r = await env.STUDY_DB.prepare(
    `SELECT item_id AS i, concept_id AS c, grade AS g, ts, chose AS x
       FROM attempt WHERE user_id = ?1 AND course = ?2 ORDER BY ts, id`
  )
    .bind(user, MON_TOAN)
    .all();
  const cols = ["i", "c", "g", "ts", "x"];
  return { cols, rows: (r.results || []).map((o) => cols.map((c) => o[c])) };
}
