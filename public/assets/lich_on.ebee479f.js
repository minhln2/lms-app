/**
 * Lịch ôn giãn cách (Leitner + SM-2 rút gọn) — MỘT bản cho cả trình duyệt và Worker (ADR 0063):
 *   - trang ôn tập (templates/study.html) nạp CHÍNH file này bằng <script type="module"> — builder chép sang dist/assets/
 *     với tên có hash (ADR 0048);
 *   - Worker (worker/quantri.js) gọi `phatLai` khi bố mẹ gỡ một ngày ôn: dựng lại `card` từ các lượt làm bài còn lại.
 * Hàm thuần, không import, không đụng DOM / API riêng của Worker.
 *
 * Tính bằng SỐ NGUYÊN từ đầu tới cuối: ease lưu ×100 để trình duyệt và mọi phép dựng lại phía máy chủ ra cùng kết quả từng
 * bit. Máy chủ kẹp lại mọi giá trị lần nữa (writeSession), không tin trình duyệt.
 */
export const BOX = [0, 1, 2, 4, 8, 16, 32];   // số ngày theo bậc 1..6

/** Một lượt chấm `g` (0..3) trên thẻ `c` ({box, ease} — null = thẻ mới) lúc `now` (epoch giây) → {box, ease, due}. */
export function sched(id, c, g, now) {
  let box = c ? c.box : 1, ease = c ? c.ease : 250;
  if (g <= 1) {
    box = Math.max(1, box - 1);
    ease = Math.max(130, ease - 20);
    return { box, ease, due: now + 600 };   // gặp lại NGAY trong phiên
  }
  box = Math.min(6, box + 1);
  ease = Math.min(350, Math.max(130, ease + (g === 3 ? 10 : -10)));
  // Nhiễu ±10% suy TẤT ĐỊNH từ id: để các mốc ôn không dồn hết vào một
  // ngày, mà vẫn tính lại được y hệt khi phát lại lịch sử.
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const days = BOX[box] * ease / 250 * (1 + ((h % 21) - 10) / 100);
  return { box, ease, due: now + Math.max(1, Math.round(days)) * 86400 };
}

/**
 * Phát lại các lượt `luot` = [{g, ok, ts}] (ĐÃ xếp theo ts, cùng ts theo id) của thẻ `id` thành MỘT card — đúng luật
 * upsertCards của writeSession: n + 1, wrong + (ok ? 0 : 1), streak ok ? + 1 : 0, box / ease / due theo sched lúc ts,
 * last_ts = ts. Không lượt nào → card như thẻ mới (n = wrong = streak = 0, box 1, ease 250, due 0, last_ts 0).
 */
export function phatLai(id, luot) {
  let c = null;
  for (const a of luot || []) {
    const st = sched(id, c, a.g, a.ts);
    c = {
      n: (c ? c.n : 0) + 1,
      wrong: (c ? c.wrong : 0) + (a.ok ? 0 : 1),
      streak: a.ok ? (c ? c.streak : 0) + 1 : 0,
      box: st.box, ease: st.ease, due: st.due, last_ts: a.ts,
    };
  }
  return c || { n: 0, wrong: 0, streak: 0, box: 1, ease: 250, due: 0, last_ts: 0 };
}
