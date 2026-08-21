const list = document.querySelector("#dataList");
const message = document.querySelector("#message");
const dialog = document.querySelector("#manageDialog");
const form = document.querySelector("#manageForm");
const dialogText = document.querySelector("#dialogText");
const dayValue = document.querySelector("#dayValue");
const dialogMeta = document.querySelector("#dialogMeta");
const dialogVideo = document.querySelector("#dialogVideo");
const videoPickerLabel = document.querySelector("#videoPickerLabel");
const videoDropzone = document.querySelector("#videoDropzone");
const manageSaveButton = document.querySelector("#manageSaveButton");
let selected = null;
let remainingDays = 0;
let currentRound = 1;
let selectedVideo = null;
let saving = false;

document.querySelector("#dayMinus").addEventListener("click", () => setDays(remainingDays - 1));
document.querySelector("#dayPlus").addEventListener("click", () => setDays(remainingDays + 1));
document.querySelector("#roundMinus").addEventListener("click", () => setRound(currentRound - 1));
document.querySelector("#roundPlus").addEventListener("click", () => setRound(currentRound + 1));
document.querySelector("#cancelButton").addEventListener("click", () => dialog.close());
document.querySelector("#deleteButton").addEventListener("click", deleteSelected);
form.addEventListener("submit", saveSelected);
dialogVideo.addEventListener("change", () => {
  setSelectedVideo(dialogVideo.files[0] || null);
});
["dragenter", "dragover"].forEach((name) => videoDropzone.addEventListener(name, (event) => {
  event.preventDefault();
  videoDropzone.classList.add("dragging");
}));
["dragleave", "drop"].forEach((name) => videoDropzone.addEventListener(name, (event) => {
  event.preventDefault();
  videoDropzone.classList.remove("dragging");
}));
videoDropzone.addEventListener("drop", (event) => {
  const file = [...event.dataTransfer.files].find((item) => item.type.startsWith("video/"));
  if (!file) {
    dialogMeta.textContent = "영상 파일을 끌어 놓아 주세요.";
    dialogMeta.classList.add("error");
    return;
  }
  setSelectedVideo(file);
});
loadData();

async function loadData() {
  try {
    const response = await fetch("/api/sentences");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    list.replaceChildren(...data.sentences.map(createRow));
    message.textContent = data.sentences.length ? "" : "등록된 문장이 없습니다.";
  } catch (error) { showMessage(error.message || "데이터를 불러오지 못했습니다.", true); }
}

function createRow(sentence) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `data-row${sentence.remainingDays < 0 ? " overdue" : ""}`;
  const text = document.createElement("span");
  text.className = "row-content";
  const sentenceText = document.createElement("span");
  sentenceText.className = "row-text";
  sentenceText.textContent = sentence.text;
  const progress = document.createElement("small");
  progress.textContent = `${sentence.currentRound}/8회차 · ${sentence.currentRepeatCount}/${sentence.targetRepeatCount}회 반복 · 총 ${sentence.totalRepeatCount}회`;
  text.append(sentenceText, progress);
  const days = document.createElement("span");
  days.className = "days";
  days.textContent = dayLabel(sentence);
  button.append(text, days);
  button.addEventListener("click", () => openDialog(sentence));
  return button;
}

function dayLabel(sentence) {
  if (sentence.status === "completed") return "완료";
  if (sentence.remainingDays === 0) return "오늘";
  if (sentence.remainingDays < 0) return `${Math.abs(sentence.remainingDays)}일 지남`;
  return `${sentence.remainingDays}일 남음`;
}

function openDialog(sentence) {
  selected = sentence;
  dialogText.value = sentence.text;
  remainingDays = sentence.remainingDays ?? 0;
  currentRound = sentence.currentRound;
  dialogVideo.value = "";
  selectedVideo = null;
  videoPickerLabel.textContent = sentence.videoUrl ? "영상 교체 · 끌어 놓기 가능" : "영상 추가 · 끌어 놓기 가능";
  setDays(remainingDays);
  setRound(currentRound);
  dialogMeta.textContent = `현재 ${sentence.currentRepeatCount}/${sentence.targetRepeatCount}회 반복 · 총 ${sentence.totalRepeatCount}회`;
  dialogMeta.classList.remove("error");
  setSaving(false);
  dialog.showModal();
}

function setDays(value) {
  remainingDays = Math.max(-3650, Math.min(3650, value));
  dayValue.textContent = `${remainingDays}일`;
}

function setRound(value) {
  currentRound = Math.max(1, Math.min(8, value));
  document.querySelector("#roundValue").textContent = `${currentRound}회차`;
  document.querySelector("#roundMinus").disabled = currentRound === 1;
  document.querySelector("#roundPlus").disabled = currentRound === 8;
}

async function saveSelected(event) {
  event.preventDefault();
  if (!selected || saving) return;
  setSaving(true);
  dialogMeta.classList.remove("error");
  dialogMeta.textContent = selectedVideo ? "문장과 영상을 저장하고 있습니다…" : "변경 내용을 저장하고 있습니다…";
  try {
    const response = await fetch(`/api/sentences/${selected.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: dialogText.value.trim(), remainingDays, currentRound })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    const video = selectedVideo;
    if (video) {
      const body = new FormData();
      body.append("video", video);
      const videoResponse = await fetch(`/api/sentences/${selected.id}/video`, { method: "POST", body });
      const videoData = await videoResponse.json();
      if (!videoResponse.ok) throw new Error(videoData.error);
    }
    dialog.close();
    await loadData();
  } catch (error) {
    dialogMeta.textContent = error.message || "저장하지 못했습니다.";
    dialogMeta.classList.add("error");
  } finally {
    setSaving(false);
  }
}

async function deleteSelected() {
  if (!selected || !confirm("이 문장과 영상 파일을 완전히 삭제할까요?\n이 작업은 되돌릴 수 없습니다.")) return;
  try {
    const response = await fetch(`/api/sentences/${selected.id}`, { method: "DELETE" });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error);
    }
    dialog.close();
    await loadData();
  } catch (error) { dialogMeta.textContent = error.message || "삭제하지 못했습니다."; }
}

function showMessage(text, error = false) {
  message.textContent = text;
  message.classList.toggle("error", error);
}

function setSelectedVideo(file) {
  selectedVideo = file;
  videoPickerLabel.textContent = file?.name || (selected?.videoUrl ? "영상 교체 · 끌어 놓기 가능" : "영상 추가 · 끌어 놓기 가능");
  dialogMeta.classList.remove("error");
  if (file) dialogMeta.textContent = `${file.name} 선택됨`;
}

function setSaving(value) {
  saving = value;
  manageSaveButton.disabled = value;
  manageSaveButton.textContent = value ? "저장 중…" : "저장";
}
