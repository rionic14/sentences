import express from "express";
import Database from "better-sqlite3";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(root, ".env"));

const port = numberEnv("PORT", 3000);
const maxVideoSizeMb = numberEnv("MAX_VIDEO_SIZE_MB", 200);
const configuredDataPath = process.env.DATA_VOLUME_PATH || "./volume";
const dataPath = path.resolve(root, configuredDataPath);
const videoPath = path.join(dataPath, "videos");
fs.mkdirSync(videoPath, { recursive: true });

const db = new Database(path.join(dataPath, "sentences.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS sentences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    video_file TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    current_round INTEGER NOT NULL DEFAULT 1 CHECK(current_round BETWEEN 1 AND 8),
    current_repeat_count INTEGER NOT NULL DEFAULT 0 CHECK(current_repeat_count >= 0),
    total_repeat_count INTEGER NOT NULL DEFAULT 0 CHECK(total_repeat_count >= 0),
    next_review_date TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed')),
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS review_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sentence_id INTEGER NOT NULL REFERENCES sentences(id) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    target_repeat_count INTEGER NOT NULL,
    completed_repeat_count INTEGER NOT NULL,
    started_at TEXT,
    completed_at TEXT NOT NULL,
    UNIQUE(sentence_id, round)
  );
`);

const app = express();
app.use(express.json());
app.use(express.static(path.join(root, "public")));
app.use("/videos", express.static(videoPath, { fallthrough: false }));

const upload = multer({
  storage: multer.diskStorage({
    destination: videoPath,
    filename: (_req, file, callback) => {
      const extension = safeVideoExtension(file.originalname, file.mimetype);
      callback(null, `${crypto.randomUUID()}${extension}`);
    }
  }),
  limits: { fileSize: maxVideoSizeMb * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    callback(file.mimetype.startsWith("video/") ? null : new Error("영상 파일만 업로드할 수 있습니다."), file.mimetype.startsWith("video/"));
  }
});

app.get("/api/sentences/current", (_req, res) => {
  const today = studyDate();
  const sentence = db.prepare(`
    SELECT * FROM sentences
    WHERE status = 'active' AND next_review_date <= ?
    ORDER BY next_review_date ASC,
      CASE current_round WHEN 1 THEN 100 WHEN 2 THEN 50 WHEN 3 THEN 30 ELSE 10 END DESC,
      created_at ASC
    LIMIT 1
  `).get(today);

  if (!sentence) {
    const next = db.prepare(`
      SELECT next_review_date FROM sentences
      WHERE status = 'active' AND next_review_date > ?
      ORDER BY next_review_date ASC LIMIT 1
    `).get(today);
    return res.json({ sentence: null, studyDate: today, nextReviewDate: next?.next_review_date || null });
  }

  res.json({ sentence: presentSentence(sentence, today), studyDate: today });
});

app.get("/api/sentences", (_req, res) => {
  const today = studyDate();
  const rows = db.prepare(`
    SELECT * FROM sentences
    ORDER BY CASE WHEN status = 'completed' THEN 1 ELSE 0 END,
      next_review_date ASC, created_at ASC
  `).all();
  res.json({ sentences: rows.map((row) => presentSentence(row, today)), studyDate: today });
});

app.post("/api/sentences", upload.single("video"), (req, res, next) => {
  const text = String(req.body.text || "").trim();
  if (!req.file || !text) {
    if (req.file) safeUnlink(path.join(videoPath, req.file.filename));
    return res.status(400).json({ error: "영상과 문장을 모두 입력해 주세요." });
  }

  try {
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO sentences (text, video_file, created_at, updated_at, next_review_date)
      VALUES (?, ?, ?, ?, ?)
    `).run(text, req.file.filename, now, now, studyDate());
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (error) {
    safeUnlink(path.join(videoPath, req.file.filename));
    next(error);
  }
});

const changeCount = db.transaction((id, delta) => {
  const sentence = db.prepare("SELECT * FROM sentences WHERE id = ? AND status = 'active'").get(id);
  if (!sentence) throw httpError(404, "활성 문장을 찾을 수 없습니다.");

  const target = targetForRound(sentence.current_round);
  const nextCurrent = Math.max(0, Math.min(target, sentence.current_repeat_count + delta));
  const actualDelta = nextCurrent - sentence.current_repeat_count;
  const nextTotal = Math.max(0, sentence.total_repeat_count + actualDelta);
  const now = new Date().toISOString();

  if (actualDelta > 0 && nextCurrent === target) {
    db.prepare(`
      INSERT OR IGNORE INTO review_history
        (sentence_id, round, target_repeat_count, completed_repeat_count, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, sentence.current_round, target, nextCurrent, sentence.updated_at, now);

    if (sentence.current_round === 8) {
      db.prepare(`
        UPDATE sentences SET current_repeat_count = ?, total_repeat_count = ?, status = 'completed',
          completed_at = ?, next_review_date = NULL, updated_at = ? WHERE id = ?
      `).run(nextCurrent, nextTotal, now, now, id);
      return { completed: true };
    }

    const nextRound = sentence.current_round + 1;
    const nextDate = addStudyDays(studyDate(), intervalForRound(nextRound));
    db.prepare(`
      UPDATE sentences SET current_round = ?, current_repeat_count = 0, total_repeat_count = ?,
        next_review_date = ?, updated_at = ? WHERE id = ?
    `).run(nextRound, nextTotal, nextDate, now, id);
    return { roundCompleted: true, nextReviewDate: nextDate };
  }

  db.prepare(`
    UPDATE sentences SET current_repeat_count = ?, total_repeat_count = ?, updated_at = ? WHERE id = ?
  `).run(nextCurrent, nextTotal, now, id);
  return { sentence: presentSentence(db.prepare("SELECT * FROM sentences WHERE id = ?").get(id), studyDate()) };
});

app.post("/api/sentences/:id/count", (req, res, next) => {
  try {
    const delta = Number(req.body.delta);
    if (![1, -1].includes(delta)) return res.status(400).json({ error: "delta는 1 또는 -1이어야 합니다." });
    res.json(changeCount(Number(req.params.id), delta));
  } catch (error) { next(error); }
});

app.patch("/api/sentences/:id", (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const sentence = db.prepare("SELECT * FROM sentences WHERE id = ?").get(id);
    if (!sentence) throw httpError(404, "문장을 찾을 수 없습니다.");

    const text = req.body.text === undefined ? sentence.text : String(req.body.text).trim();
    const remainingDays = req.body.remainingDays === undefined ? null : Number(req.body.remainingDays);
    if (!text) throw httpError(400, "문장을 입력해 주세요.");
    if (remainingDays !== null && (!Number.isInteger(remainingDays) || remainingDays < -3650 || remainingDays > 3650)) {
      throw httpError(400, "남은 일수가 올바르지 않습니다.");
    }
    const nextDate = remainingDays === null ? sentence.next_review_date : addStudyDays(studyDate(), remainingDays);
    db.prepare("UPDATE sentences SET text = ?, next_review_date = ?, updated_at = ? WHERE id = ?")
      .run(text, nextDate, new Date().toISOString(), id);
    res.json({ sentence: presentSentence(db.prepare("SELECT * FROM sentences WHERE id = ?").get(id), studyDate()) });
  } catch (error) { next(error); }
});

const removeSentence = db.transaction((id) => {
  const sentence = db.prepare("SELECT * FROM sentences WHERE id = ?").get(id);
  if (!sentence) throw httpError(404, "문장을 찾을 수 없습니다.");
  db.prepare("DELETE FROM sentences WHERE id = ?").run(id);
  return sentence.video_file;
});

app.delete("/api/sentences/:id", (req, res, next) => {
  try {
    const videoFile = removeSentence(Number(req.params.id));
    safeUnlink(path.join(videoPath, videoFile));
    res.status(204).end();
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `영상은 ${maxVideoSizeMb}MB 이하만 업로드할 수 있습니다.` });
  }
  console.error(error);
  res.status(error.status || 500).json({ error: error.status ? error.message : "서버 오류가 발생했습니다." });
});

app.listen(port, () => console.log(`문장외우기: http://localhost:${port}`));

function targetForRound(round) {
  if (round === 1) return 100;
  if (round === 2) return 50;
  if (round === 3) return 30;
  return 10;
}

function intervalForRound(round) {
  return ({ 2: 1, 3: 4, 4: 8, 5: 16, 6: 32, 7: 64, 8: 128 })[round];
}

function studyDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23"
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  const local = new Date(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00:00+09:00`);
  if (Number(parts.hour) < 4) local.setUTCDate(local.getUTCDate() - 1);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(local);
}

function addStudyDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(date);
}

function dateDifference(from, to) {
  return Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 86400000);
}

function presentSentence(row, today) {
  return {
    id: row.id,
    text: row.text,
    videoUrl: `/videos/${encodeURIComponent(row.video_file)}`,
    createdAt: row.created_at,
    currentRound: row.current_round,
    currentRepeatCount: row.current_repeat_count,
    targetRepeatCount: targetForRound(row.current_round),
    totalRepeatCount: row.total_repeat_count,
    nextReviewDate: row.next_review_date,
    remainingDays: row.next_review_date ? dateDifference(today, row.next_review_date) : null,
    status: row.status,
    completedAt: row.completed_at
  };
}

function safeVideoExtension(name, mime) {
  const allowed = new Set([".mp4", ".mov", ".m4v", ".webm"]);
  const extension = path.extname(name).toLowerCase();
  if (allowed.has(extension)) return extension;
  return mime === "video/webm" ? ".webm" : ".mp4";
}

function safeUnlink(file) {
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") console.error(error); }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}
