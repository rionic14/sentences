const list = document.querySelector("#dataList");
const message = document.querySelector("#message");
const dialog = document.querySelector("#manageDialog");
const form = document.querySelector("#manageForm");
const dialogText = document.querySelector("#dialogText");
const dayValue = document.querySelector("#dayValue");
const dialogMeta = document.querySelector("#dialogMeta");
const dialogVideo = document.querySelector("#dialogVideo");
const videoPickerLabel = document.querySelector("#videoPickerLabel");
let selected = null;
let remainingDays = 0;

document.querySelector("#dayMinus").addEventListener("click", () => setDays(remainingDays - 1));
document.querySelector("#dayPlus").addEventListener("click", () => setDays(remainingDays + 1));
document.querySelector("#cancelButton").addEventListener("click", () => dialog.close());
document.querySelector("#deleteButton").addEventListener("click", deleteSelected);
form.addEventListener("submit", saveSelected);
dialogVideo.addEventListener("change", () => {
  videoPickerLabel.textContent = dialogVideo.files[0]?.name || (selected?.videoUrl ? "영상 교체" : "영상 추가");
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
  text.className = "row-text";
  text.textContent = sentence.text;
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
  dialogVideo.value = "";
  videoPickerLabel.textContent = sentence.videoUrl ? "영상 교체" : "영상 추가";
  setDays(remainingDays);
  dialogMeta.textContent = `${sentence.currentRound}/8회차 · 현재 ${sentence.currentRepeatCount}/${sentence.targetRepeatCount} · 총 ${sentence.totalRepeatCount}회`;
  dialog.showModal();
}

function setDays(value) {
  remainingDays = Math.max(-3650, Math.min(3650, value));
  dayValue.textContent = `${remainingDays}일`;
}

async function saveSelected(event) {
  event.preventDefault();
  if (!selected) return;
  try {
    const response = await fetch(`/api/sentences/${selected.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: dialogText.value.trim(), remainingDays })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    const video = dialogVideo.files[0];
    if (video) {
      const body = new FormData();
      body.append("video", video);
      const videoResponse = await fetch(`/api/sentences/${selected.id}/video`, { method: "POST", body });
      const videoData = await videoResponse.json();
      if (!videoResponse.ok) throw new Error(videoData.error);
    }
    dialog.close();
    await loadData();
  } catch (error) { dialogMeta.textContent = error.message || "저장하지 못했습니다."; }
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
