const form = document.getElementById("analyze-form");
const videoInput = document.getElementById("video-input");
const submitButton = document.getElementById("submit-button");
const stopButton = document.getElementById("stop-button");

const statusMessage = document.getElementById("status-message");
const progressLog = document.getElementById("progress-log");
const flashcardsEl = document.getElementById("flashcards");
const emptyResults = document.getElementById("empty-results");

function setStatus(text) {
  statusMessage.textContent = text;
}

function appendLog(line) {
  const li = document.createElement("li");
  li.textContent = line;
  progressLog.appendChild(li);
  progressLog.scrollTop = progressLog.scrollHeight;
}

function clearLog() {
  progressLog.replaceChildren();
}

function describeProgress(event) {
  switch (event.phase) {
    case "extracting":
      return "Extracting frames with ffmpeg…";
    case "extracted":
      return `Extracted ${event.frameCount} frame(s).`;
    case "detecting":
      return "Detecting brands in frames…";
    case "detected":
      return `Found ${event.brands.length} brand(s): ${event.brands.map((b) => b.name).join(", ") || "none"}.`;
    case "placement":
      return "Rating placement sentiment from visuals…";
    case "placement-done":
      return `Placement rated for ${event.brands.length} brand(s).`;
    case "rate-limit":
      return event.message;
    case "info":
      return event.message;
    case "researching":
      return `Researching ${event.brand} (${event.index}/${event.total})…`;
    case "agent-step": {
      const s = event.step;
      if (s.type === "decide") {
        return `${event.brand}: ${s.needsSearch ? "using search" : "skipping search"} — ${s.reason}`;
      }
      if (s.type === "verdict") {
        return `${event.brand}: verdict ${s.confidence}`;
      }
      if (s.type === "retry") {
        return `${event.brand}: retry — ${s.hints.join("; ")}`;
      }
      if (s.type === "accept") {
        return `${event.brand}: ${s.reason}`;
      }
      return `${event.brand}: draft (search=${s.groundedInSearch})`;
    }
    case "complete":
      return "Analysis complete.";
    case "stopped":
      return "Analysis stopped.";
    default:
      return "";
  }
}

function setRunning(running) {
  submitButton.disabled = running;
  stopButton.disabled = !running;
  videoInput.disabled = running;
}

async function stopAnalysis() {
  try {
    await fetch("/api/abort-analysis", { method: "POST" });
  } catch {
    /* ignore */
  }
}

function placementBadgeClass(sentiment) {
  if (sentiment === "positive") return "placement-positive";
  if (sentiment === "negative") return "placement-negative";
  return "placement-neutral";
}

function renderFlashcards(result) {
  const flashcards = result.flashcards;
  const metaByName = new Map(
    (result.brandsDetected || []).map((b) => [b.name.toLowerCase(), b]),
  );

  flashcardsEl.replaceChildren();
  if (!flashcards.length) {
    emptyResults.classList.remove("hidden");
    emptyResults.textContent = "No brands detected in this clip.";
    return;
  }
  emptyResults.classList.add("hidden");

  for (const item of flashcards) {
    const card = item.flashcard;
    const article = document.createElement("article");
    article.className = "flashcard";
    article.setAttribute("data-testid", "flashcard-item");

    const title = document.createElement("h3");
    title.textContent = card.brand;

    const brandMeta = metaByName.get(card.brand.toLowerCase());

    const meta = document.createElement("div");
    meta.className = "flashcard-meta";
    meta.innerHTML = `
      <span><strong>Industry:</strong> ${escapeHtml(card.industry)}</span>
      ${card.founded ? `<span><strong>Founded:</strong> ${escapeHtml(card.founded)}</span>` : ""}
      ${card.headquarters ? `<span><strong>HQ:</strong> ${escapeHtml(card.headquarters)}</span>` : ""}
      ${
        brandMeta
          ? `<span class="badge ${placementBadgeClass(brandMeta.placementSentiment)}">Placement: ${escapeHtml(brandMeta.placementSentiment)}</span>`
          : ""
      }
      <span class="badge ${card.groundedInSearch ? "search-yes" : ""}">${card.groundedInSearch ? "Web search" : "Model knowledge"}</span>
      <span class="badge">Attempts: ${item.attempts}</span>
    `;

    const summary = document.createElement("p");
    summary.className = "summary";
    summary.textContent = card.summary;

    const factsTitle = document.createElement("p");
    factsTitle.innerHTML = "<strong>Key facts</strong>";
    const facts = document.createElement("ul");
    for (const fact of card.keyFacts) {
      const li = document.createElement("li");
      li.textContent = fact;
      facts.appendChild(li);
    }

    article.append(title, meta, summary);

    if (brandMeta?.placementRationale) {
      const placementNote = document.createElement("p");
      placementNote.className = "placement-note";
      placementNote.textContent = `Placement note (${brandMeta.placementConfidence} confidence): ${brandMeta.placementRationale}`;
      article.appendChild(placementNote);
    }

    article.append(factsTitle, facts);

    if (card.sources?.length) {
      const sources = document.createElement("div");
      sources.className = "sources";
      sources.innerHTML = "<strong>Sources</strong>";
      const list = document.createElement("ul");
      for (const url of card.sources) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = url;
        li.appendChild(a);
        list.appendChild(li);
      }
      sources.appendChild(list);
      article.appendChild(sources);
    }

    const details = document.createElement("details");
    details.className = "agent-steps";
    const summaryEl = document.createElement("summary");
    summaryEl.textContent = "Agent steps";
    details.appendChild(summaryEl);
    const stepsList = document.createElement("ul");
    for (const step of item.steps) {
      const li = document.createElement("li");
      li.textContent = JSON.stringify(step);
      stepsList.appendChild(li);
    }
    details.appendChild(stepsList);
    article.appendChild(details);

    flashcardsEl.appendChild(article);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function streamAnalyze(file, includePlacement, allowGoogleSearch) {
  const body = new FormData();
  body.append("video", file);
  if (includePlacement) {
    body.append("includePlacement", "true");
  }
  if (allowGoogleSearch) {
    body.append("allowGoogleSearch", "true");
  }

  const response = await fetch("/api/analyze", { method: "POST", body });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Request failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const payload = JSON.parse(line.slice(6));
      if (payload.type === "progress") {
        const text = describeProgress(payload.event);
        if (text) {
          setStatus(text);
          appendLog(text);
        }
      } else if (payload.type === "result") {
        renderFlashcards(payload.result);
        if (payload.result.stoppedEarly) {
          setStatus(
            `Stopped early — showing ${payload.result.flashcards.length} result(s) from completed work.`,
          );
          appendLog(
            `Partial result: ${payload.result.flashcards.length} brand(s).`,
          );
        } else {
          setStatus("Done. Scroll down for results.");
        }
      } else if (payload.type === "cancelled") {
        setStatus(payload.message || "Analysis stopped.");
        appendLog(payload.message || "Stopped.");
        return;
      } else if (payload.type === "error") {
        throw new Error(payload.message);
      }
    }
  }
}

stopButton.addEventListener("click", () => {
  stopAnalysis();
  setStatus("Stopping… saving partial results when possible");
  appendLog("Stop requested.");
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = videoInput.files?.[0];
  if (!file) return;

  const includePlacement = document.getElementById("include-placement").checked;
  const allowGoogleSearch = document.getElementById("allow-google-search").checked;
  setRunning(true);
  clearLog();
  flashcardsEl.replaceChildren();
  emptyResults.classList.remove("hidden");
  emptyResults.textContent = "Analyzing…";
  setStatus("Starting…");

  try {
    await streamAnalyze(file, includePlacement, allowGoogleSearch);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    appendLog(err.message);
  } finally {
    setRunning(false);
  }
});
