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
    video_original_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    current_round INTEGER NOT NULL DEFAULT 1 CHECK(current_round BETWEEN 1 AND 8),
    current_repeat_count INTEGER NOT NULL DEFAULT 0 CHECK(current_repeat_count >= 0),
    rotation_chunk_count INTEGER NOT NULL DEFAULT 0 CHECK(rotation_chunk_count BETWEEN 0 AND 9),
    total_repeat_count INTEGER NOT NULL DEFAULT 0 CHECK(total_repeat_count >= 0),
    registered_study_date TEXT,
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

  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

if (!db.prepare("PRAGMA table_info(sentences)").all().some((column) => column.name === "video_original_name")) {
  db.exec("ALTER TABLE sentences ADD COLUMN video_original_name TEXT");
}
if (!db.prepare("PRAGMA table_info(sentences)").all().some((column) => column.name === "registered_study_date")) {
  db.exec("ALTER TABLE sentences ADD COLUMN registered_study_date TEXT");
}
if (!db.prepare("PRAGMA table_info(sentences)").all().some((column) => column.name === "rotation_chunk_count")) {
  db.exec("ALTER TABLE sentences ADD COLUMN rotation_chunk_count INTEGER NOT NULL DEFAULT 0");
}

const missingRegistrationDates = db.prepare(`
  SELECT id, created_at, current_round, next_review_date
  FROM sentences WHERE registered_study_date IS NULL
`).all();
const setRegistrationDate = db.prepare("UPDATE sentences SET registered_study_date = ? WHERE id = ?");
db.transaction(() => {
  for (const sentence of missingRegistrationDates) {
    const registrationDate = sentence.next_review_date
      ? addStudyDays(sentence.next_review_date, -reviewDayOffset(sentence.current_round))
      : studyDate(new Date(sentence.created_at));
    setRegistrationDate.run(registrationDate, sentence.id);
  }
})();

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
  const candidates = db.prepare(`
    SELECT * FROM sentences
    WHERE status = 'active' AND next_review_date <= ?
    ORDER BY
      next_review_date ASC,
      CASE WHEN current_repeat_count % 10 <> 0 THEN 0 ELSE 1 END ASC,
      current_repeat_count ASC,
      CASE current_round WHEN 1 THEN 100 WHEN 2 THEN 50 WHEN 3 THEN 30 ELSE 10 END DESC,
      id ASC
  `).all(today);
  const priorityDate = candidates[0]?.next_review_date;
  const prioritizedCandidates = candidates.filter((candidate) => candidate.next_review_date === priorityDate);
  const inProgress = prioritizedCandidates.find((candidate) => candidate.current_repeat_count % 10 !== 0);
  const lastChunkSentenceId = getLastChunkSentenceId(today);
  const sentence = inProgress
    || prioritizedCandidates.find((candidate) => candidate.id !== lastChunkSentenceId)
    || prioritizedCandidates[0];

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
      next_review_date ASC,
      CASE current_round WHEN 1 THEN 100 WHEN 2 THEN 50 WHEN 3 THEN 30 ELSE 10 END DESC,
      created_at ASC
  `).all();
  res.json({ sentences: rows.map((row) => presentSentence(row, today)), studyDate: today });
});

app.post("/api/sentences", upload.single("video"), (req, res, next) => {
  const text = String(req.body.text || "").trim();
  if (!text) {
    if (req.file) safeUnlink(path.join(videoPath, req.file.filename));
    return res.status(400).json({ error: "문장을 입력해 주세요." });
  }

  try {
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO sentences
        (text, video_file, video_original_name, created_at, updated_at, registered_study_date, next_review_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(text, req.file?.filename || "", req.file?.originalname || null, now, now, studyDate(), studyDate());
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (error) {
    if (req.file) safeUnlink(path.join(videoPath, req.file.filename));
    next(error);
  }
});

app.post("/api/sentences/:id/video", upload.single("video"), (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: "추가할 영상을 선택해 주세요." });
  try {
    const id = Number(req.params.id);
    const sentence = db.prepare("SELECT * FROM sentences WHERE id = ?").get(id);
    if (!sentence) {
      safeUnlink(path.join(videoPath, req.file.filename));
      throw httpError(404, "문장을 찾을 수 없습니다.");
    }
    db.prepare("UPDATE sentences SET video_file = ?, video_original_name = ?, updated_at = ? WHERE id = ?")
      .run(req.file.filename, req.file.originalname, new Date().toISOString(), id);
    if (sentence.video_file) safeUnlink(path.join(videoPath, sentence.video_file));
    res.json({ sentence: presentSentence(db.prepare("SELECT * FROM sentences WHERE id = ?").get(id), studyDate()) });
  } catch (error) {
    if (req.file) safeUnlink(path.join(videoPath, req.file.filename));
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
        UPDATE sentences SET current_repeat_count = ?, rotation_chunk_count = 0,
          total_repeat_count = ?, status = 'completed',
          completed_at = ?, next_review_date = NULL, updated_at = ? WHERE id = ?
      `).run(nextCurrent, nextTotal, now, now, id);
      return { completed: true };
    }

    const nextRound = sentence.current_round + 1;
    const registrationDate = sentence.registered_study_date
      || addStudyDays(sentence.next_review_date, -reviewDayOffset(sentence.current_round));
    const nextDate = addStudyDays(registrationDate, reviewDayOffset(nextRound));
    db.prepare(`
      UPDATE sentences SET current_round = ?, current_repeat_count = 0, rotation_chunk_count = 0,
        total_repeat_count = ?,
        next_review_date = ?, updated_at = ? WHERE id = ?
    `).run(nextRound, nextTotal, nextDate, now, id);
    return { roundCompleted: true, nextReviewDate: nextDate };
  }

  if (actualDelta > 0 && nextCurrent > 0 && nextCurrent % 10 === 0) {
    db.prepare(`
      UPDATE sentences SET current_repeat_count = ?, rotation_chunk_count = 0,
        total_repeat_count = ?, updated_at = ? WHERE id = ?
    `).run(nextCurrent, nextTotal, now, id);
    setLastChunkSentenceId(studyDate(), id);
    return { chunkCompleted: true };
  }
  db.prepare(`
    UPDATE sentences SET current_repeat_count = ?, rotation_chunk_count = 0,
      total_repeat_count = ?, updated_at = ? WHERE id = ?
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
    const requestedRound = req.body.currentRound === undefined ? sentence.current_round : Number(req.body.currentRound);
    const requestedRepeatCount = req.body.currentRepeatCount === undefined
      ? (requestedRound === sentence.current_round ? sentence.current_repeat_count : 0)
      : Number(req.body.currentRepeatCount);
    if (!text) throw httpError(400, "문장을 입력해 주세요.");
    if (remainingDays !== null && (!Number.isInteger(remainingDays) || remainingDays < -3650 || remainingDays > 3650)) {
      throw httpError(400, "남은 일수가 올바르지 않습니다.");
    }
    if (!Number.isInteger(requestedRound) || requestedRound < 1 || requestedRound > 8) {
      throw httpError(400, "회차는 1부터 8 사이여야 합니다.");
    }
    const repeatLimit = targetForRound(requestedRound) - (sentence.status === "completed" ? 0 : 1);
    if (!Number.isInteger(requestedRepeatCount) || requestedRepeatCount < 0 || requestedRepeatCount > repeatLimit) {
      throw httpError(400, "현재 반복 횟수가 올바르지 않습니다.");
    }
    const nextDate = remainingDays === null ? sentence.next_review_date : addStudyDays(studyDate(), remainingDays);
    const nextRepeatCount = requestedRepeatCount;
    const nextTotalRepeatCount = requestedRound === sentence.current_round
      ? sentence.total_repeat_count + nextRepeatCount - sentence.current_repeat_count
      : sentence.total_repeat_count;
    const registrationDate = nextDate
      ? addStudyDays(nextDate, -reviewDayOffset(requestedRound))
      : sentence.registered_study_date;
    db.prepare(`
      UPDATE sentences SET text = ?, next_review_date = ?, current_round = ?,
        current_repeat_count = ?, rotation_chunk_count = 0,
        total_repeat_count = ?, registered_study_date = ?, updated_at = ? WHERE id = ?
    `).run(text, nextDate, requestedRound, nextRepeatCount, sentence.current_round === requestedRound
      ? nextTotalRepeatCount : sentence.total_repeat_count, registrationDate, new Date().toISOString(), id);
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
    if (videoFile) safeUnlink(path.join(videoPath, videoFile));
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
  return ({ 2: 1, 3: 2, 4: 4, 5: 8, 6: 16, 7: 32, 8: 64 })[round];
}

function reviewDayOffset(round) {
  return ({ 1: 0, 2: 1, 3: 3, 4: 7, 5: 15, 6: 31, 7: 63, 8: 127 })[round];
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
    videoFile: row.video_file ? (row.video_original_name || row.video_file) : null,
    videoUrl: row.video_file ? `/videos/${encodeURIComponent(row.video_file)}` : null,
    createdAt: row.created_at,
    currentRound: row.current_round,
    currentRepeatCount: row.current_repeat_count,
    rotationChunkCount: row.rotation_chunk_count,
    targetRepeatCount: targetForRound(row.current_round),
    totalRepeatCount: row.total_repeat_count,
    registeredStudyDate: row.registered_study_date,
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

function getLastChunkSentenceId(date) {
  const state = db.prepare("SELECT value FROM app_state WHERE key = ?").get(`last-chunk:${date}`);
  return state ? Number(state.value) : null;
}

function setLastChunkSentenceId(date, sentenceId) {
  db.prepare(`
    INSERT INTO app_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(`last-chunk:${date}`, String(sentenceId));
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
