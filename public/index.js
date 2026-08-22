const elements = {
  videoFrame: document.querySelector("#videoFrame"),
  video: document.querySelector("#video"),
  noVideo: document.querySelector("#noVideo"),
  sentence: document.querySelector("#sentence"),
  stats: document.querySelector("#stats"),
  counter: document.querySelector("#counter"),
  target: document.querySelector("#targetCount"),
  current: document.querySelector("#currentCount"),
  round: document.querySelector("#round"),
  minus: document.querySelector("#minus"),
  plus: document.querySelector("#plus"),
  message: document.querySelector("#message")
};

let currentSentence = null;
let changing = false;

elements.videoFrame.addEventListener("click", async () => {
  if (!currentSentence?.videoUrl) return;
  try {
    elements.video.currentTime = 0;
    await elements.video.play();
  } catch { showMessage("재생할 수 없는 영상입니다.", true); }
});
elements.minus.addEventListener("click", () => changeCount(-1));
elements.plus.addEventListener("click", () => changeCount(1));

loadCurrent();

async function loadCurrent() {
  lock(true);
  showMessage("");
  try {
    const response = await fetch("/api/sentences/current");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    currentSentence = data.sentence;
    render(data);
  } catch (error) {
    showMessage(error.message || "문장을 불러오지 못했습니다.", true);
  } finally { lock(false); }
}

async function changeCount(delta) {
  if (!currentSentence || changing) return;
  changing = true;
  lock(true);
  try {
    const response = await fetch(`/api/sentences/${currentSentence.id}/count`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delta })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (data.chunkCompleted || data.roundCompleted || data.completed) return await loadCurrent();
    currentSentence = data.sentence;
    render({ sentence: currentSentence });
  } catch (error) {
    showMessage(error.message || "횟수를 저장하지 못했습니다.", true);
  } finally {
    changing = false;
    lock(false);
  }
}

function render(data) {
  const sentence = data.sentence;
  const visible = Boolean(sentence);
  elements.videoFrame.hidden = !visible;
  elements.stats.hidden = !visible;
  elements.counter.hidden = !visible;
  if (!sentence) {
    elements.video.pause();
    elements.video.removeAttribute("src");
    elements.video.load();
    elements.sentence.classList.add("empty");
    elements.sentence.textContent = data.nextReviewDate
      ? `오늘 복습할 문장이 없습니다.\n다음 복습: ${data.nextReviewDate}`
      : "오늘 복습할 문장이 없습니다.";
    return;
  }
  if (sentence.videoUrl) {
    elements.video.pause();
    elements.video.src = sentence.videoUrl;
    elements.video.load();
    elements.video.hidden = false;
    elements.noVideo.hidden = true;
    document.querySelector(".video-hint").hidden = false;
  } else {
    elements.video.pause();
    elements.video.removeAttribute("src");
    elements.video.hidden = true;
    elements.noVideo.hidden = false;
    document.querySelector(".video-hint").hidden = true;
  }
  elements.sentence.classList.remove("empty");
  elements.sentence.textContent = sentence.text;
  elements.target.textContent = sentence.targetRepeatCount;
  elements.current.textContent = sentence.currentRepeatCount;
  elements.round.textContent = `${sentence.currentRound}/8`;
  elements.minus.disabled = sentence.currentRepeatCount === 0;
}

function lock(value) {
  elements.plus.disabled = value || !currentSentence;
  elements.minus.disabled = value || !currentSentence || currentSentence.currentRepeatCount === 0;
}

function showMessage(text, error = false) {
  elements.message.textContent = text;
  elements.message.classList.toggle("error", error);
}
