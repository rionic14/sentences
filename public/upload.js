const form = document.querySelector("#uploadForm");
const dropzone = document.querySelector("#dropzone");
const videoInput = document.querySelector("#videoInput");
const preview = document.querySelector("#preview");
const dropCopy = document.querySelector("#dropCopy");
const textInput = document.querySelector("#textInput");
const submitButton = document.querySelector("#submitButton");
const message = document.querySelector("#message");
let previewUrl = null;

videoInput.addEventListener("change", () => showPreview(videoInput.files[0]));
["dragenter", "dragover"].forEach((name) => dropzone.addEventListener(name, (event) => {
  event.preventDefault(); dropzone.classList.add("dragging");
}));
["dragleave", "drop"].forEach((name) => dropzone.addEventListener(name, (event) => {
  event.preventDefault(); dropzone.classList.remove("dragging");
}));
dropzone.addEventListener("drop", (event) => {
  const file = [...event.dataTransfer.files].find((item) => item.type.startsWith("video/"));
  if (!file) return setMessage("영상 파일을 선택해 주세요.", true);
  const transfer = new DataTransfer();
  transfer.items.add(file);
  videoInput.files = transfer.files;
  showPreview(file);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = videoInput.files[0];
  const text = textInput.value.trim();
  if (!text) return setMessage("문장을 입력해 주세요.", true);
  if (!confirm(`이 문장을 업로드할까요?\n\n${text}\n\n영상: ${file?.name || "없음 (나중에 추가 가능)"}`)) return;

  submitButton.disabled = true;
  submitButton.textContent = "업로드 중…";
  setMessage("영상을 업로드하고 있습니다.");
  try {
    const body = new FormData();
    if (file) body.append("video", file);
    body.append("text", text);
    const response = await fetch("/api/sentences", { method: "POST", body });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    location.href = "/";
  } catch (error) {
    setMessage(error.message || "업로드하지 못했습니다.", true);
    submitButton.disabled = false;
    submitButton.textContent = "업로드!";
  }
});

function showPreview(file) {
  if (!file) return;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  preview.src = previewUrl;
  preview.hidden = false;
  dropCopy.hidden = true;
  setMessage(file.name);
}

function setMessage(text, error = false) {
  message.textContent = text;
  message.classList.toggle("error", error);
}
