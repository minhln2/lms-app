/**
 * Tra cứu: giải nghĩa một TỪ, hoặc dịch + giảng một ĐOẠN, bằng Gemini.
 *
 * Vì sao gọi lúc chạy chứ không dựng sẵn lúc build: nghĩa của một từ phụ thuộc
 * CÂU chứa nó và BÀI đang học. Dựng sẵn thì phải đoán trước mọi cặp (từ, câu) —
 * đo trên site hiện tại là 148.724 cặp.
 *
 * Ngữ cảnh (`ctx`) do TRÌNH DUYỆT gửi lên chứ không phải Worker tự dựng: trang
 * đã tải sẵn `study/{course}.json` rồi, bắt Worker tải lại và parse file ~200KB
 * cho MỖI lượt tra là đốt vô ích cái trần 10ms CPU của gói free. Đổi lại phải
 * kẹp độ dài `ctx` — client nói gì cũng không được dài quá.
 *
 * Chính ngữ cảnh đó là lý do dùng Gemini thay vì một máy dịch thường. Đo trên
 * cùng một câu: máy dịch trả "đá nham thạch" cho `igneous rock`; Gemini kèm
 * glossary của bài trả "đá mácma". Sai kiểu đó trôi chảy và tự nhiên, không có
 * dấu hiệu nào để nhận ra.
 *
 * Hàng rào — GĐ 1 cố ý chỉ có ba lớp, KHÔNG cache và KHÔNG đối chiếu học liệu:
 *   1. `x-progress-key`, cùng mã bí mật với /api/progress. Đây là hàng rào
 *      CHÍNH. Chuỗi trẻ bôi đen là thứ trẻ KHÔNG hiểu trong bài, tức một hồ sơ
 *      điểm yếu — nên nó theo luật của /api/study/stats (chặn), chứ không theo
 *      luật của /api/tts (công khai + danh sách trắng).
 *   2. Trần lượt gọi MỖI NGÀY trong D1. Đây là thứ duy nhất chặn được hoá đơn
 *      nếu mã bí mật lọt ra ngoài. Không có nó thì mã bí mật là điểm hỏng duy
 *      nhất, mà hỏng theo kiểu không ai biết cho tới lúc nhận hoá đơn.
 *   3. Giới hạn độ dài từng trường.
 *
 * ⚠️ `thinkingBudget: 0` phải đặt TƯỜNG MINH, đừng dựa vào mặc định. Model này
 * khai `thinking: true`. Hôm nay mặc định là TẮT — đo được: `vào + ra == tổng`
 * khớp từng token và không có trường `thoughtsTokenCount`. Nhưng mặc định là
 * thứ Google đổi được mà không báo ai, và khi nó đổi thì tiền tăng 47–83% còn
 * câu trả lời trông Y HỆT. Không nhìn ra được, nên phải ĐO: mỗi lượt gọi tự
 * kiểm `vào + ra == tổng` và báo ra `meta.thoughts` khi lệch.
 *
 * Secret: npx wrangler secret put GEMINI_API_KEY
 * ⚠️ Nhớ BẬT BILLING trên dự án Google. Gói free dùng dữ liệu để huấn luyện, mà
 * đây đúng là thứ không nên đưa vào đó.
 */

const MODEL = "gemini-3.1-flash-lite";
const ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

/** Trần lượt gọi mỗi ngày. Vượt thì 429 — mềm, không phải lỗi. */
export const CAP = 300;

/** Kẹp độ dài từng trường. Đầu ra mới là chỗ tốn tiền, nhưng đầu vào trôi nổi
 *  thì cũng kéo đầu ra dài theo. */
const MAX = { word: 40, sent: 300, text: 600, ctx: 1200, hoi: 300, su: 1400 };

const json = (d, s = 200) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/**
 * ⚠️ Dòng "sách giáo khoa Việt Nam" KHÔNG phải câu chữ cho đẹp — nó sửa một lỗi
 * đo được. Glossary của bài chỉ có định nghĩa TIẾNG ANH (các môn dạy bằng tiếng
 * Anh build với `--no-gloss`), nên `ctx` không có từ tiếng Việt nào để bám vào.
 * Thiếu dòng này, `igneous rock` ra "đá núi lửa" — 3/3 lượt; thêm vào thì ra
 * "đá mác-ma" — cũng 3/3. "Đá núi lửa" đọc rất xuôi tai và không ai thấy sai,
 * nhưng nó là tên của đá phun trào, không phải của cả nhóm đá mácma.
 * `test_lookup_route.mjs` canh dòng này còn nằm trong thân yêu cầu gửi đi.
 */
const HE = "Bạn là gia sư cho học sinh Việt Nam đang học môn này bằng tiếng Anh.\n" +
  "Viết như đang nói với một đứa trẻ: câu ngắn, từ dễ, không dùng từ Hán-Việt khó.\n" +
  "Bám đúng thuật ngữ đã cho bên dưới, đừng tự đặt cách gọi khác.\n" +
  "Với thuật ngữ khoa học, dùng ĐÚNG từ mà sách giáo khoa Việt Nam dùng cho khái " +
  "niệm đó, kể cả khi có cách gọi dân dã quen tai hơn. Điều này áp cho MỌI trường " +
  "— cả ví dụ lẫn phần lưu ý — không riêng trường nghĩa.";

/**
 * Hai chế độ khác nhau ở ĐẦU RA, nên tách hẳn schema chứ đừng nhồi vào một.
 *
 * Cả hai cùng trả `phan[]` — một mảng khối `{tieu_de, noi_dung, vi_du[]}` — vì
 * một schema PHẲNG không chứa nổi cả hai thứ người ta sẽ bôi đen. `beach` cần
 * đúng một dòng; `present perfect` cần công thức, từng trường hợp dùng, và phần
 * phân biệt với thì gần giống. Nhồi cả hai vào `giai_thich` thì hoặc từ đơn giản
 * bị viết lê thê, hoặc điểm ngữ pháp bị cắt cụt thành một câu vô dụng.
 *
 * Độ sâu do MODEL tự co giãn theo thứ được hỏi, không phải ta tự đoán loại rồi
 * đổi prompt: đoán "đây là điểm ngữ pháp" bằng luật thì hỏng ngay ở những thứ
 * nằm giữa (`used to`, `photosynthesis`, `a lot of`). Đo được: `beach` ra 221
 * token/1 phần, `present perfect` ra 255 token/3 phần — cùng một prompt.
 */
const SHAPE = {
  // Hỏi đáp tiếp về chính đoạn vừa tra. Đầu ra CHỈ một trường: popup vẽ nó
  // thành bong bóng chat, không cần khối `phan[]` nào.
  //
  // ⚠ Vẫn là JSON chứ không phải văn bản trần, để dùng chung đúng một đường
  // phân tích với hai chế độ kia — thêm một đường nữa là thêm một chỗ sẽ lệch.
  chat:
    'Trả về JSON thuần, không rào đầu, đúng khoá sau:\n' +
    '{"tra_loi":"câu trả lời bằng tiếng Việt"}\n' +
    'Trả lời NGẮN (2–5 câu), đúng trình độ học sinh tiểu học, bám vào đoạn đang ' +
    'học ở trên. Được phép ví von cho dễ hiểu.\n' +
    'Nếu câu hỏi nằm ngoài đoạn đang học nhưng vẫn thuộc môn này thì cứ trả lời; ' +
    'nếu lạc hẳn đề tài thì nói thẳng là câu đó không liên quan tới bài.\n' +
    'KHÔNG bịa số liệu hay dữ kiện không có trong đoạn. Thiếu dữ kiện thì nói rõ ' +
    'còn thiếu gì.\n' +
    'Nếu là câu hỏi ý kiến riêng thì đừng trả lời thay, chỉ gợi cách nghĩ.',

  word:
    'Trả về JSON thuần, không rào đầu, đúng các khoá sau:\n' +
    '{"tu":"từ gốc","loai":"","ipa":"phiên âm IPA","nghia":"",' +
    '"phan":[{"tieu_de":"","noi_dung":"","vi_du":[{"en":"","vi":""}]}],"luu_y":""}\n' +
    'loai: viết BẰNG TIẾNG VIỆT (danh từ · động từ · tính từ · trạng từ · cụm từ · ' +
    'thì trong ngữ pháp · cấu trúc câu). Không dùng tiếng Anh ở trường này.\n' +
    'nghia: TỪ tiếng Việt tương đương, NGẮN — thường 1–4 chữ ("tinh thể", "đá mác-ma", ' +
    '"sự bay hơi"). Tuyệt đối KHÔNG chép hay dịch lại câu định nghĩa ở phần Ngữ cảnh ' +
    'vào đây; định nghĩa dài thuộc về phần "Là gì" bên dưới.\n\n' +
    'Độ sâu phải VỪA VỚI THỨ ĐƯỢC HỎI, đừng viết dài đều nhau:\n' +
    "· Từ vựng thường: một phần 'Cách dùng', 1–2 ví dụ. Ngắn thôi.\n" +
    "· Điểm NGỮ PHÁP (thì, cấu trúc câu, loại từ): tách 'Công thức', 'Dùng khi nào' " +
    "(liệt kê từng trường hợp, mỗi trường hợp một ví dụ), 'Dễ nhầm với' (so với " +
    'cấu trúc gần giống, kèm ví dụ đối chiếu).\n' +
    "· KHÁI NIỆM khoa học: 'Là gì', 'Gặp ở đâu trong đời thường', và thêm 'Biết thêm' " +
    'nếu có một chi tiết thú vị — 1–2 câu, CHỈ nêu điều chắc chắn đúng, không đoán.\n' +
    'luu_y: chỗ dễ nhầm lẫn; để trống nếu không có gì đáng nói.\n\n' +
    'Giải nghĩa theo đúng nghĩa từ đó mang TRONG CÂU đã cho, không liệt kê nghĩa khác.',
  text:
    'Trả về JSON thuần, không rào đầu, đúng các khoá sau:\n' +
    '{"dich":"bản dịch tiếng Việt sát nghĩa",' +
    '"phan":[{"tieu_de":"","noi_dung":"","vi_du":[{"en":"","vi":""}]}],' +
    '"tu_kho":[{"en":"từ khó","vi":"nghĩa"}],"luu_y":""}\n' +
    "phan: một khối 'Giảng lại' (2–3 câu diễn giải ý chính cho dễ hiểu, được phép ví von), " +
    "và thêm khối 'Biết thêm' nếu đoạn này gắn với một điều thú vị ngoài sách — 1–2 câu, " +
    'CHỈ nêu điều chắc chắn đúng.\n' +
    // ── Đoạn được bôi đen là một CÂU HỎI / ĐỀ BÀI ──────────────────────────
    // Không thêm trường mới vào schema: `phan[]` vốn là mảng khối tự do và
    // popup đã vẽ được mọi tiêu đề khối, nên "trả lời câu hỏi" chỉ là hai khối
    // nữa. Thêm trường riêng thì phải sửa cả bộ vẽ lẫn nhánh offline, mà nhánh
    // offline là nhánh ít ai mở ra xem nhất nên nó sẽ lệch trước.
    //
    // ⚠ 'Vì sao' đứng SAU 'Trả lời' nhưng mới là phần chính. Chỉ đưa đáp án
    // thì trẻ chép xong là xong, và công cụ tra cứu biến thành máy làm hộ bài.
    'NẾU đoạn được hỏi là một CÂU HỎI hoặc ĐỀ BÀI (có dấu hỏi, hoặc mở đầu bằng ' +
    'Which/What/Why/How/Explain/Describe/Calculate/Circle/Tick/Name…), thì THAY ' +
    "khối 'Giảng lại' bằng hai khối theo đúng thứ tự:\n" +
    "· 'Trả lời' — đáp án, ngắn gọn, đi thẳng vào việc. Trắc nghiệm thì nêu rõ " +
    'phương án nào và nội dung của nó.\n' +
    "· 'Vì sao' — LÝ DO, 2–4 câu, dẫn từ kiến thức trong bài ra đáp án. Đây mới " +
    'là phần chính: nói rõ căn cứ để lần sau tự làm được, đừng chỉ khẳng định.\n' +
    '⚠ Câu hỏi trắc nghiệm mà đoạn được bôi đen KHÔNG kèm các phương án, hoặc câu ' +
    'hỏi cần số liệu/hình/bảng không có trong đoạn: ĐỪNG đoán. Nói rõ còn thiếu gì ' +
    "trong khối 'Trả lời' và giảng phần kiến thức liên quan ở khối 'Vì sao'.\n" +
    '⚠ Câu hỏi hỏi ý kiến riêng hoặc trải nghiệm của người học (What do you think…, ' +
    'Describe your…): KHÔNG trả lời thay, mà gợi ý cách nghĩ và một ví dụ mẫu.\n' +
    'tu_kho: tối đa 4 từ khó nhất; không có từ nào khó thì để mảng rỗng.\n' +
    'luu_y: chỗ dễ hiểu sai; để trống nếu không có.',
};

const cut = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");

/**
 * Ghi từ vừa tra vào lịch sử. CHỈ chế độ tra từ.
 *
 * ⚠️ Hỏng ở đây KHÔNG được làm hỏng lượt tra. Đứa trẻ đang chờ nghĩa của một từ;
 * mất một dòng lịch sử là chuyện nhỏ, mất câu trả lời mới là chuyện lớn. Vì vậy
 * bọc try/catch và nuốt lỗi — đây là một trong rất ít chỗ trong dự án được phép
 * nuốt, và được phép vì thứ bị mất có thể dựng lại bằng cách tra lần nữa.
 */
async function ghiLichSu(env, user, course, term, sec, data) {
  try {
    const now = Math.floor(Date.now() / 1000);
    await env.STUDY_DB.prepare(
      "INSERT INTO lookup_hist (user_id, course, term, tu, nghia, sec, n, first_ts, last_ts) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7) " +
      "ON CONFLICT(user_id, course, term) DO UPDATE SET " +
      "  n = n + 1, last_ts = ?7, " +
      "  tu = COALESCE(excluded.tu, tu), nghia = COALESCE(excluded.nghia, nghia)"
    ).bind(user, course, term.toLowerCase().slice(0, 80),
           cut(data?.tu, 80) || null, cut(data?.nghia, 160) || null,
           sec || null, now).run();
  } catch (e) {
    console.warn("lookup_hist hỏng:", String(e.message || e));
  }
}

/** Đọc lịch sử. Chặn bằng mã bí mật — đây là hồ sơ những chỗ trẻ chưa hiểu. */
export async function handleLookupHistory(request, env, url) {
  if (request.method !== "GET") return json({ error: "Method không hỗ trợ" }, 405);
  const secret = env.LMS_SECRET || "";
  if (!secret) return json({ error: "Chưa cấu hình LMS_SECRET" }, 503);
  if ((request.headers.get("x-progress-key") || "") !== secret) {
    return json({ error: "Mã bí mật không đúng" }, 401);
  }
  if (!env.STUDY_DB) return json({ error: "Chưa cấu hình STUDY_DB" }, 503);
  const user = url.searchParams.get("user") || "";
  const course = url.searchParams.get("course") || "";
  if (!/^[\w-]{1,32}$/.test(user) || !/^[\w-]{1,64}$/.test(course)) {
    return json({ error: "Thiếu hoặc sai 'user'/'course'" }, 400);
  }
  const r = await env.STUDY_DB.prepare(
    "SELECT term, tu, nghia, sec, n, first_ts, last_ts FROM lookup_hist " +
    "WHERE user_id = ?1 AND course = ?2 ORDER BY last_ts DESC LIMIT 500"
  ).bind(user, course).all();
  return json({ rows: r.results || [] });
}

/**
 * Tăng bộ đếm của NGÀY HÔM NAY và trả về số lượt sau khi tăng.
 *
 * Tăng TRƯỚC khi gọi Gemini, không phải sau. Gọi hỏng thì Google vẫn có thể đã
 * tính tiền, và quan trọng hơn: đếm-sau biến mọi lỗi thành một lượt gọi miễn
 * phí để thử lại, tức đúng cái vòng lặp mà trần sinh ra để chặn.
 *
 * `INSERT … VALUES … ON CONFLICT` nên KHÔNG cần `WHERE true` — cái bẫy đó chỉ
 * xảy ra với `INSERT … SELECT … ON CONFLICT`, khi SQLite không phân biệt được
 * `ON` của JOIN với `ON` của CONFLICT.
 */
async function tieuThu(env, day) {
  const r = await env.STUDY_DB.prepare(
    "INSERT INTO lookup_budget (day, n) VALUES (?1, 1) " +
    "ON CONFLICT(day) DO UPDATE SET n = n + 1 RETURNING n"
  ).bind(day).first();
  const n = Number(r?.n || 0);

  // Dọn dòng cũ, nhưng CHỈ ở lượt đầu tiên của ngày (`n === 1`, tức dòng hôm nay
  // vừa được tạo). Tự lên lịch: đúng một lần mỗi ngày, không thêm câu lệnh nào
  // cho 299 lượt còn lại. Chạy mỗi lượt là trả phí cho một việc mỗi năm mới có
  // ích một lần.
  //
  // Giữ 400 ngày chứ không phải 30: bảng này là thứ DUY NHẤT trả lời được "trần
  // 300 rộng hay chật", và câu đó cần nhìn trọn một năm học. 400 dòng × ~20 byte
  // là 8KB — rẻ hơn hẳn việc mất dữ liệu rồi phải đoán.
  if (n === 1) {
    try {
      const moc = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
      await env.STUDY_DB.prepare("DELETE FROM lookup_budget WHERE day < ?1").bind(moc).run();
    } catch (e) {
      // Dọn hỏng không được làm hỏng lượt tra — cùng lý do với ghiLichSu().
      console.warn("dọn lookup_budget hỏng:", String(e.message || e));
    }
  }
  return n;
}

/** Mã lỗi ĐÁNG thử lại. 412 nằm đây vì một lý do cụ thể, xem ghi chú dưới. */
const THU_LAI = new Set([412, 429, 500, 502, 503, 504]);

/**
 * Gọi Gemini, thử lại ĐÚNG MỘT LẦN khi gặp lỗi thoáng qua.
 *
 * ⚠️ 412 `FAILED_PRECONDITION` của API này nghĩa là "User location is not
 * supported" — chặn theo NƠI GỌI. Worker chạy ở colo Cloudflare và đi ra bằng IP
 * dùng chung của họ, mà IP đó định vị sang nước nào là chuyện Cloudflare quyết
 * theo từng lượt. Hệ quả đã gặp: hôm trước chạy bình thường, hôm sau 412, rồi tự
 * hết — cùng một khoá, cùng một mã, cùng một colo SIN.
 *
 * Giãn cách NGẮN (400ms) và chỉ MỘT lần: đứa trẻ đang chờ, tổng đã là ~1,6s rồi.
 * Thử lại lâu hơn thì cứu được thêm vài phần trăm số lượt nhưng đổi lấy một
 * khoảng chờ mà trẻ sẽ bỏ đi trước khi nó xong.
 *
 * KHÔNG thử lại 400/401/403: sai yêu cầu hay sai khoá thì gọi lại vẫn sai, chỉ
 * tốn thêm một khoảng chờ.
 */
async function goiLai(uri, colo, body) {
  const gui = () => fetch(uri, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const r = await gui();
  if (r.ok || !THU_LAI.has(r.status)) return r;
  console.warn(`Gemini ${r.status} @colo=${colo} — thử lại lần 2`);
  await new Promise((k) => setTimeout(k, 400));
  return gui();
}

export async function handleLookup(request, env) {
  if (request.method !== "POST") return json({ error: "Method không hỗ trợ" }, 405);

  const secret = env.LMS_SECRET || "";
  if (!secret) return json({ error: "Chưa cấu hình LMS_SECRET" }, 503);
  if ((request.headers.get("x-progress-key") || "") !== secret) {
    return json({ error: "Mã bí mật không đúng" }, 401);
  }
  const key = env.GEMINI_API_KEY || "";
  if (!key) return json({ error: "Chưa cấu hình GEMINI_API_KEY" }, 503);
  if (!env.STUDY_DB) return json({ error: "Chưa cấu hình STUDY_DB" }, 503);

  let b;
  try { b = await request.json(); } catch { return json({ error: "Body không hợp lệ" }, 400); }

  const user = cut(b?.user, 32);
  const course = cut(b?.course, 64);
  const sec = cut(b?.sec, 64);
  const mode = ["text", "chat"].includes(b?.mode) ? b.mode : "word";
  // Ngôn ngữ của phần GIẢI THÍCH. Mặc định tiếng Việt; môn dạy bằng
  // tiếng Anh thì trang tự gửi "en" lên.
  const nn = b?.nn === "en" ? "en" : "vi";
  // Ngôn ngữ DẠY của môn — khác `nn` ở trên (`nn` là ngôn ngữ người học chọn
  // cho phần giải thích). Môn dạy bằng tiếng Việt thì đoạn được bôi đen vốn
  // đã là tiếng Việt, nên hai trường sinh ra cho môn tiếng Anh trở thành rác.
  const mon_nn = b?.mon_nn === "en" ? "en" : "vi";
  const text = cut(b?.text, mode === "word" ? MAX.word : MAX.text);
  const hoi = cut(b?.hoi, MAX.hoi);
  // Lịch sử hội thoại do TRÌNH DUYỆT gửi lên, như `ctx` — Worker không giữ
  // trạng thái. Kẹp cả số lượt lẫn tổng độ dài: một cuộc chat dài là đầu vào
  // phình tuyến tính, mà đầu vào phình thì đầu ra cũng phình theo.
  const su = Array.isArray(b?.lich_su) ? b.lich_su.slice(-6) : [];
  const lich_su = cut(su.map((m) => (m && m.ai === "em" ? "Học sinh: " : "Gia sư: ")
                                    + cut(m && m.noi, 400)).join("\n"), MAX.su);
  if (mode === "chat" && !hoi) return json({ error: "Thiếu 'hoi'" }, 400);
  const sent = cut(b?.sent, MAX.sent);
  const ctx = cut(b?.ctx, MAX.ctx);
  if (!text) return json({ error: "Thiếu 'text'" }, 400);

  // Trần ngày. Theo giờ UTC cho khỏi phải mang múi giờ vào Worker — mốc reset
  // rơi vào 7 giờ sáng Việt Nam, tức trước giờ học, nên không ai để ý.
  const day = new Date().toISOString().slice(0, 10);
  const n = await tieuThu(env, day);
  if (n > CAP) {
    return json({ error: "Hôm nay đã tra nhiều rồi, mai nhé", cap: CAP, used: n }, 429);
  }

  // Nói rõ ctx là ĐỊNH NGHĨA, không phải bản dịch. Thiếu câu này thì model coi
  // vế phải của mỗi dòng là cách gọi tiếng Việt bắt buộc và chép nó vào `nghia`.
  const he = [HE, ctx && "Ngữ cảnh — định nghĩa TIẾNG ANH lấy từ sách, chỉ dùng để " +
    "biết từ đang mang nghĩa NÀO. Đây KHÔNG phải bản dịch, đừng chép lại:\n" + ctx,
    SHAPE[mode],
    // ⚠ Đặt SAU SHAPE, cùng lý do với phần ghi đè ngôn ngữ bên dưới: thứ nói
    // sau mới đè được thứ nói trước.
    //
    // Môn tiếng Việt thì `tu_kho` (chú từ tiếng Anh khó) không có gì để chú —
    // model vẫn cố sinh ra và cho ra những chip vô nghĩa kiểu
    // `dash · dấu gạch ngang`, `explanatory part · bộ phận chú thích`: dịch
    // NGƯỢC một từ tiếng Việt sang tiếng Anh rồi dịch lại. Còn `dich` ("bản
    // dịch tiếng Việt") thì chép lại gần nguyên văn đoạn gốc, mà đoạn gốc đã
    // nằm ngay phía trên trong popup. Cắt ở PROMPT chứ không chỉ ẩn ở giao
    // diện: ẩn thì vẫn trả tiền token cho thứ không ai đọc.
    mode === "text" && mon_nn !== "en" &&
      "MÔN DẠY BẰNG TIẾNG VIỆT — đoạn được hỏi vốn đã là tiếng Việt:\n"
      + "· `tu_kho`: trả về mảng RỖNG [] — không có từ tiếng Anh nào để chú.\n"
      + '· `dich`: trả về chuỗi RỖNG "" — đừng chép lại đoạn gốc.\n',
    // ⚠ Câu này đặt CUỐI CÙNG, sau SHAPE. Mọi mô tả trường ở trên đều viết
    // "tiếng Việt"; muốn đổi ngôn ngữ thì phải đè lên chúng, mà thứ nói sau
    // mới đè được thứ nói trước. Đặt trước SHAPE thì model theo SHAPE.
    nn === "en" && "GHI ĐÈ NGÔN NGỮ: viết phần GIẢI THÍCH bằng TIẾNG ANH đơn "
      + "giản, đúng trình độ học sinh tiểu học — `noi_dung`, `luu_y`, `dich`, "
      + "`tra_loi`, và trường `vi` của mỗi ví dụ. Giữ nguyên tên khoá JSON.\n"
      // ⚠ `nghia` là NGOẠI LỆ CÓ CHỦ Ý. Nó không phải phần giải thích mà là từ
      // tiếng Việt tương đương — thứ duy nhất trong cả schema mà tiếng mẹ đẻ
      // mới có tác dụng, và cũng là thứ trẻ cần nhất khi gặp thuật ngữ lạ. Bỏ
      // dòng này thì model vẫn giữ tiếng Việt (đã đo), nhưng lúc đó là ăn may
      // chứ không phải chủ đích.
      + "NGOẠI LỆ: `nghia` vẫn là TỪ TIẾNG VIỆT tương đương, giữ nguyên như mô "
      + "tả ở trên — đó là chỗ để đối chiếu với tiếng mẹ đẻ, không phải phần "
      + "giải thích.",
  ].filter(Boolean).join("\n\n");
  const nguoi = mode === "word"
    ? `Từ cần giải nghĩa: "${text}"` + (sent ? `\nCâu chứa từ đó: "${sent}"` : "")
    : mode === "chat"
      ? `Đoạn đang học:\n${text}\n\n`
        + (lich_su ? `Đã trao đổi:\n${lich_su}\n\n` : "")
        + `Câu hỏi của học sinh: ${hoi}`
      : text;

  const uri = `${ENDPOINT}?key=${encodeURIComponent(key)}`;
  const colo = (request.cf && request.cf.colo) || "?";
  let g;
  try {
    g = await goiLai(uri, colo, {
    contents: [{ role: "user", parts: [{ text: nguoi }] }],
    systemInstruction: { parts: [{ text: he }] },
    generationConfig: {
      temperature: 0.3,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 },
          // Chặn trên cho MỘT lượt. Đo được: dài nhất là điểm ngữ pháp, ~420
          // token; 1500 là gấp hơn ba lần chỗ đó, nên không cắt vào bài thật,
          // mà vẫn ghìm một lượt trả lời chạy loạn ở ~47đ thay vì không trần.
          // Bị cắt thì JSON hỏng → 502, tức lộ ra chứ không âm thầm cụt.
      maxOutputTokens: 1500,
    },
    });
  } catch (e) {
    return json({ error: "Không gọi được Gemini: " + String(e.message || e) }, 502);
  }
  if (!g.ok) {
    // In CÂU LỖI THẬT, đừng nuốt thành một mã trống. Cùng bài học với lượt sync
    // 2026-09-12: wrangler in dòng khác đè lên, câu 401 bị che, và mất nửa ngày.
    const t = await g.text().catch(() => "");
    // Ghi kèm COLO. Lỗi 412 `FAILED_PRECONDITION` của API này nghĩa là "User
    // location is not supported", tức chặn theo NƠI GỌI — mà Worker chạy ở colo
    // Cloudflare gần người dùng nhất, và colo đó đổi giữa các ngày. Không ghi
    // colo thì cùng một mã lỗi lúc xảy ra lúc không, không cách nào đối chiếu.
    console.warn(`Gemini ${g.status} @colo=${colo}: ${t.slice(0, 400)}`);
    // Ghi xuống D1 chứ không chỉ console: lỗi này phụ thuộc COLO nên lúc có lúc
    // không, và chỉ xảy ra khi TRẺ bấm. `wrangler tail` chỉ bắt được nếu đúng lúc
    // mình ngồi xem — đã hai lần thu log 4–5 phút mà không lượt nào đi qua.
    // Hỏng ở đây KHÔNG được che mất lỗi gốc, nên nuốt riêng.
    try {
      await env.STUDY_DB.prepare(
        "INSERT INTO lookup_loi (day, colo, ma, n, cuoi) VALUES (?1, ?2, ?3, 1, ?4) " +
        "ON CONFLICT(day, colo, ma) DO UPDATE SET n = n + 1, cuoi = ?4"
      ).bind(day, colo, g.status, t.slice(0, 200)).run();
    } catch (e) { /* sổ ghi lỗi hỏng thì thôi, đừng che lỗi gốc */ }
    return json({ error: `Gemini lỗi ${g.status}`, chi_tiet: t.slice(0, 300), colo }, 502);
  }

  const d = await g.json();
  const parts = d?.candidates?.[0]?.content?.parts || [];
  const raw = parts.map((p) => p.text || "").join("").trim();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return json({ error: "Gemini trả về không phải JSON", chi_tiet: raw.slice(0, 300) }, 502);
  }

  // Lịch sử: chỉ chế độ tra TỪ, và chỉ khi biết là của ai. `user`/`course` KHÔNG
  // đi vào prompt — chúng chỉ dùng cho dòng D1 này.
  if (mode === "word" && /^[\w-]{1,32}$/.test(user) && /^[\w-]{1,64}$/.test(course)) {
    await ghiLichSu(env, user, course, text, sec, data);
  }

  const u = d.usageMetadata || {};
  const vao = u.promptTokenCount || 0;
  const ra = u.candidatesTokenCount || 0;
  const tong = u.totalTokenCount || 0;
  // Lệch nghĩa là có token không nằm trong vào/ra — tức chế độ nghĩ đã bật.
  const nghi = (u.thoughtsTokenCount || 0) || Math.max(0, tong - vao - ra);

  return json({ mode, data, meta: { vao, ra, thoughts: nghi, used: n, cap: CAP } });
}
