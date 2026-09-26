const STORE_KEY = "scene-lexicon-state-v1";

class BrowserStorage {
  load() { const defaults = { batches: [], viewed: {}, drillResults: [], profile: { streak: 0, lastStudyDate: null }, ui: { learnMode: "composer" } }; try { const saved = JSON.parse(localStorage.getItem(STORE_KEY)); return saved ? { ...defaults, ...saved, profile:{ ...defaults.profile, ...saved.profile }, ui:{ ...defaults.ui, ...saved.ui } } : defaults; } catch { return defaults; } }
  save(value) { localStorage.setItem(STORE_KEY, JSON.stringify(value)); }
  reset() { localStorage.removeItem(STORE_KEY); }
  export() { return new Blob([JSON.stringify(this.load(), null, 2)], { type: "application/json" }); }
}

const storage = new BrowserStorage();
let state = storage.load();
if (normalizeStoredDrillPrompts(state)) storage.save(state);
let modelCredentials = null;
let current = state.batches.at(-1) ?? null;
let activeFilter = "all";
const annotationReviewAttempts = new Set();
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[character]);

function normalizeStoredDrillPrompts(savedState) {
  let changed = false;
  for (const batch of savedState.batches ?? []) {
    for (const drill of batch.drills ?? []) {
      const prompt = String(drill.prompt ?? "").replace(/造一个中文句子/g, "造一个英文句子").replace(/写一个中文句子/g, "写一个英文句子");
      if (prompt === drill.prompt) continue;
      drill.prompt = prompt;
      changed = true;
    }
  }
  return changed;
}

function boot() {
  lucide.createIcons();
  bindEvents();
  void initializeModelConfiguration();
  updateBatchIndex();
  if (current && state.ui.learnMode === "batch") renderBatch(current);
  renderContexts();
  renderProgress();
}

async function initializeModelConfiguration() {
  try {
    const payload = await fetch("/api/llm/providers", { cache:"no-store" }).then((response) => response.json());
    $("#providerInput").innerHTML = payload.providers.map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.label)}</option>`).join("");
    updateModelStatus();
    setTimeout(() => openModelDialog(), 0);
  } catch { $("#modelConfigBtn").className = "service-status offline"; $("#serviceStatus").textContent = "服务离线"; }
}

function updateModelStatus() {
  $("#modelConfigBtn").className = `service-status ${modelCredentials ? "ready" : "offline"}`;
  $("#serviceStatus").textContent = modelCredentials ? "模型已就绪" : "配置模型";
  $("#disconnectModel").classList.toggle("hidden", !modelCredentials);
}

function openModelDialog() {
  $("#apiKeyInput").value = "";
  if (modelCredentials) { $("#providerInput").value = modelCredentials.provider; $("#modelInput").value = modelCredentials.model; }
  if (!$("#modelDialog").open) $("#modelDialog").showModal();
  lucide.createIcons();
}

function saveModelConfiguration(event) {
  event.preventDefault();
  const apiKey = $("#apiKeyInput").value.trim();
  if (!/^[\x21-\x7E]+$/.test(apiKey)) {
    $("#apiKeyInput").setCustomValidity("API Key 只能包含半角英文字符，不能包含中文或空格");
    $("#apiKeyInput").reportValidity();
    return;
  }
  $("#apiKeyInput").setCustomValidity("");
  modelCredentials = Object.freeze({ provider:$("#providerInput").value, model:$("#modelInput").value.trim(), apiKey });
  $("#apiKeyInput").value = "";
  $("#modelDialog").close(); updateModelStatus(); toast("模型配置仅在当前页面生效");
}

function disconnectModel() {
  modelCredentials = null; $("#modelForm").reset(); $("#apiKeyInput").value = ""; $("#modelDialog").close(); updateModelStatus(); toast("临时模型配置已清除");
}

function requireModelConfiguration() {
  if (modelCredentials) return true;
  openModelDialog(); toast("请先配置本次页面使用的模型"); return false;
}

async function modelFetch(url, payload) {
  if (!modelCredentials) throw new Error("请先配置本次页面使用的模型");
  return fetch(url, { method:"POST", cache:"no-store", headers:{ "content-type":"application/json" }, body:JSON.stringify({ ...payload, llm:modelCredentials }) });
}

function bindEvents() {
  $(".brand").addEventListener("click", (event) => { event.preventDefault(); showComposer(); });
  $$(".tab").forEach((button) => button.addEventListener("click", () => button.dataset.view === "learn" ? showComposer() : switchView(button.dataset.view)));
  $("#wordInput").addEventListener("input", updateInputHint);
  $("#batchForm").addEventListener("submit", generateBatch);
  $("#modelConfigBtn").addEventListener("click", openModelDialog);
  $("#modelForm").addEventListener("submit", saveModelConfiguration);
  $("#cancelModel").addEventListener("click", () => $("#modelDialog").close());
  $("#disconnectModel").addEventListener("click", disconnectModel);
  $("#homeBtn").addEventListener("click", showComposer);
  $("#annotationToggle").addEventListener("change", (event) => $("#sceneText").classList.toggle("annotations-off", !event.target.checked));
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("#occurrencePanel") && !event.target.closest("#sceneText mark")) closeOccurrence();
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeOccurrence(); });
  $$(".filter").forEach((button) => button.addEventListener("click", () => { activeFilter = button.dataset.filter; $$(".filter").forEach((item) => item.classList.toggle("active", item === button)); renderSenses(current); }));
  $("#exportBtn").addEventListener("click", exportState);
  $("#resetBtn").addEventListener("click", () => $("#confirmDialog").showModal());
  $("#cancelReset").addEventListener("click", () => $("#confirmDialog").close());
  $("#confirmReset").addEventListener("click", resetState);
}

function showComposer() {
  switchView("learn"); closeOccurrence(); clearInterval(window.pipelineTimer);
  $("#loadingPanel").classList.add("hidden"); $("#workspace").classList.add("hidden"); $("#composer").classList.remove("hidden");
  $("#wordInput").value = ""; updateInputHint(); hideError(); state.ui.learnMode = "composer"; storage.save(state);
  window.scrollTo({ top:0, behavior:"smooth" }); $("#wordInput").focus();
}

function switchView(view) {
  $$(".tab").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $$(".view").forEach((item) => item.classList.remove("active"));
  $(`#${view}View`).classList.add("active");
}

function parseWords() { return $("#wordInput").value.split(/[\r\n,，;；]+/).map((item) => item.trim()).filter(Boolean); }
function updateInputHint() { const words = parseWords(); const unique = new Set(words.map((word) => word.toLowerCase())); $("#inputHint").textContent = words.length ? `${unique.size} 个不同词条${words.length > unique.size ? ` · 检测到 ${words.length - unique.size} 个重复项` : ""}` : "等待输入"; }
function updateBatchIndex() { $("#nextBatchIndex").textContent = String(state.batches.length + 1).padStart(2, "0"); }

async function generateBatch(event) {
  event.preventDefault(); hideError();
  if (!requireModelConfiguration()) return;
  const words = parseWords();
  if (new Set(words.map((word) => word.toLowerCase())).size < 3) return showError("至少输入 3 个不同的英文词条。单词或短语均可，请用换行或逗号分隔。");
  $("#composer").classList.add("hidden"); $("#workspace").classList.add("hidden"); $("#loadingPanel").classList.remove("hidden");
  animatePipeline();
  try {
    const response = await modelFetch("/api/generate", { rawInput:$("#wordInput").value, batchIndex:state.batches.length + 1, learnerLevel:$("#levelInput").value, examTarget:$("#examInput").value, lengthPreference:$("#lengthInput").value, history:state.batches.map(({ senses, scene, report }) => ({ senses, scene, report })) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
    current = payload; state.batches.push(payload); state.ui.learnMode = "batch"; updateStreak(); storage.save(state);
    $("#loadingPanel").classList.add("hidden"); renderBatch(payload); renderContexts(); renderProgress(); updateBatchIndex(); toast("批次已完成并保存");
  } catch (error) { $("#loadingPanel").classList.add("hidden"); $("#composer").classList.remove("hidden"); showError(error.message); }
}

function animatePipeline() {
  const titles = ["获取完整义项", "计算场景容量", "编织连贯场景", "独立语义校验", "保存学习状态"];
  let index = 0; clearInterval(window.pipelineTimer);
  const paint = () => { $("#loadingTitle").textContent = titles[index]; $("#loadingDetail").textContent = index === 3 ? "生成器与校验器使用独立请求，正在逐条判断义项…" : "流水线正在运行，内容不会来自内置词表或示例场景。"; $$("#pipelineSteps li").forEach((item, step) => item.className = step < index ? "done" : step === index ? "active" : ""); index = Math.min(index + 1, titles.length - 1); };
  paint(); window.pipelineTimer = setInterval(paint, 3500);
}

function renderBatch(batch) {
  clearInterval(window.pipelineTimer); $("#composer").classList.add("hidden"); $("#workspace").classList.remove("hidden");
  $("#sceneTitle").textContent = batch.scene.sceneTitleZh; $("#sceneTitleEn").textContent = batch.scene.sceneTitle; $("#sceneSummary").textContent = batch.scene.sceneSummaryZh;
  $("#batchMeta").textContent = `第 ${batch.batch.batchIndex} 批 · 输入 ${batch.batch.words.length} 个词条 · 场景 ${batch.scene.wordCount} 词 · ${batch.batch.learnerLevel}`;
  const annotation = annotationCoverage(batch); $("#coveredCount").textContent = `${annotation.coveredCount} 项`; $("#targetCount").textContent = `${annotation.targetCount} 项`; $("#allSenseCount").textContent = `${batch.senses.length} 项`;
  $("#allSenseLabel").textContent = `${batch.batch.words.length} 个输入词的完整义项`;
  $("#coverageBar").style.width = `${Math.round(annotation.coverageRate * 100)}%`;
  const banner = $("#degradationBanner"); banner.classList.toggle("hidden", !batch.degradation); banner.textContent = batch.degradation ?? "";
  renderScene(batch); renderSenses(batch); renderDrills(batch);
  $("#debugOutput").textContent = JSON.stringify({ trace:batch.trace, verification:batch.report, dispersal:batch.deferrals.dispersalCheck, metrics:metricsFor(batch) }, null, 2);
  lucide.createIcons(); window.scrollTo({ top:0, behavior:"smooth" });
}

async function reverifyAnnotations(batch) {
  if (!modelCredentials) return;
  const batchId = batch.batch.batchId;
  if (annotationReviewAttempts.has(batchId)) return;
  annotationReviewAttempts.add(batchId);
  const banner = $("#degradationBanner"); banner.classList.remove("hidden"); banner.textContent = "正在按上下文重新校验旧批次标注…";
  try {
    const response = await modelFetch("/api/annotations/reverify", { senses:batch.senses, scene:batch.scene });
    const payload = await response.json(); if (!response.ok) throw new Error(payload.error || `标注校验失败 (${response.status})`);
    batch.scene = payload.scene; batch.report.semantic = payload.semantic; batch.drills = [];
    batch.degradation = payload.semantic.coveredCount ? `旧批次标注已重新校验：仅展示 ${payload.semantic.coveredCount} 个经上下文确认的义项。` : "独立语义校验未能确认任何标注，本批次需要重新生成。";
    storage.save(state); renderBatch(batch); renderProgress();
  } catch (error) { banner.textContent = `旧批次标注重新校验失败：${error.message}`; }
}

function renderableOccurrences(batch) {
  const senses = new Map(batch.senses.map((sense) => [sense.senseId, sense])); let previousEnd = -1;
  const verified = new Set((batch.report?.semantic?.judgments ?? [])
    .filter((judgment) => judgment.verdict === "covered")
    .map((judgment) => `${judgment.word}:${judgment.senseId}:${judgment.charStart}`));
  return [...batch.scene.occurrences].sort((a,b) => a.charStart - b.charStart).filter((occurrence) => {
    const sense = senses.get(occurrence.senseId); const { charStart, charEnd, surfaceForm } = occurrence;
    const key = `${occurrence.word}:${occurrence.senseId}:${charStart}`;
    const inRange = Number.isInteger(charStart) && Number.isInteger(charEnd) && charStart >= 0 && charStart < charEnd && charEnd <= batch.scene.sceneText.length;
    if (!verified.has(key) || !sense || sense.word !== occurrence.word || !inRange || charStart < previousEnd || batch.scene.sceneText.slice(charStart,charEnd) !== surfaceForm) return false;
    const before = batch.scene.sceneText[charStart-1] ?? "", after = batch.scene.sceneText[charEnd] ?? "";
    if (/[A-Za-z]/.test(before) || /[A-Za-z]/.test(after)) return false;
    previousEnd = charEnd; return true;
  });
}

function annotationCoverage(batch) {
  const coveredIds = new Set(renderableOccurrences(batch).map((occurrence) => occurrence.senseId));
  return { coveredIds, coveredCount:coveredIds.size, targetCount:batch.senses.length, coverageRate:batch.senses.length ? coveredIds.size/batch.senses.length : 0 };
}

function semanticStatus(batch, senseId) {
  const covered = annotationCoverage(batch).coveredIds.has(senseId);
  if (covered) return "covered";
  return "pending";
}

function renderScene(batch) {
  const target = $("#sceneText"); target.textContent = "";
  const occurrences = renderableOccurrences(batch); let cursor = 0;
  occurrences.forEach((occurrence, index) => {
    target.append(document.createTextNode(batch.scene.sceneText.slice(cursor, occurrence.charStart)));
    const mark = document.createElement("mark"); mark.textContent = batch.scene.sceneText.slice(occurrence.charStart, occurrence.charEnd); mark.tabIndex = 0; mark.dataset.occurrence = index; mark.dataset.senseId = occurrence.senseId;
    if (state.viewed[`${batch.batch.batchId}:${occurrence.charStart}`]) mark.classList.add("viewed");
    const open = () => showOccurrence(batch, occurrence, mark); mark.addEventListener("click", open); mark.addEventListener("keydown", (event) => { if (["Enter"," "].includes(event.key)) { event.preventDefault(); open(); } });
    target.append(mark); cursor = occurrence.charEnd;
  });
  target.append(document.createTextNode(batch.scene.sceneText.slice(cursor)));
}

function showOccurrence(batch, occurrence, mark) {
  if ($("#sceneText").classList.contains("annotations-off")) return;
  $$("#sceneText mark").forEach((item) => item.classList.remove("focused")); mark.classList.add("focused","viewed");
  state.viewed[`${batch.batch.batchId}:${occurrence.charStart}`] = true; storage.save(state);
  const sense = batch.senses.find((item) => item.senseId === occurrence.senseId); const panel = $("#occurrencePanel");
  panel.innerHTML = `<strong>${escapeHtml(occurrence.surfaceForm)}</strong> <span class="pos">${escapeHtml(sense?.pos)}</span><p>${escapeHtml(sense?.zhDef)}</p><small>${escapeHtml(sense?.enDef)}<br>${escapeHtml(occurrence.contextSnippet)}</small>`; panel.classList.remove("hidden");
}

function closeOccurrence() {
  $("#occurrencePanel")?.classList.add("hidden");
  $$("#sceneText mark.focused").forEach((item) => item.classList.remove("focused"));
}

function renderSenses(batch) {
  if (!batch) return; const target = $("#senseList"); target.textContent = "";
  batch.batch.words.forEach((word) => {
    const senses = batch.senses.filter((sense) => sense.word === word && (activeFilter === "all" || semanticStatus(batch, sense.senseId) === activeFilter));
    if (!senses.length) return;
    const details = document.createElement("details"); details.className = "word-card"; details.open = true;
    details.innerHTML = `<summary><h4>${escapeHtml(word)}</h4><span class="phonetic">${escapeHtml(senses[0]?.phonetic ?? "")}</span><span class="sense-total">${batch.senses.filter((sense) => sense.word === word).length} 个义项</span></summary><div>${senses.map((sense) => senseTemplate(batch,sense)).join("")}</div>`;
    target.append(details);
  });
  $$(".locate-btn").forEach((button) => button.addEventListener("click", () => locateSense(button.dataset.senseId)));
}

function senseTemplate(batch, sense) {
  const status = semanticStatus(batch,sense.senseId);
  const labels = { covered:"已在本场景出现", pending:"未覆盖" };
  return `<section class="sense-item ${status}" data-status="${status}"><div class="sense-head"><span class="pos">${escapeHtml(sense.pos)}</span><span class="status-chip">${labels[status]}</span></div><h5>${escapeHtml(sense.zhDef)}</h5><p>${escapeHtml(sense.enDef)}</p><div class="collocations">${sense.collocations.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>${sense.note ? `<p>${escapeHtml(sense.note)}</p>`:""}${status === "covered" ? `<button class="locate-btn" data-sense-id="${escapeHtml(sense.senseId)}">定位到原文</button>` : ""}<details class="rank-reason"><summary>查看排序理由</summary><p>${escapeHtml(sense.rankReason)}</p></details></section>`;
}

function locateSense(senseId) {
  const mark = $(`#sceneText mark[data-sense-id="${CSS.escape(senseId)}"]`); if (!mark) return;
  $("#annotationToggle").checked = true; $("#sceneText").classList.remove("annotations-off"); mark.scrollIntoView({ behavior:"smooth", block:"center" }); mark.click();
}

function renderDrills(batch, generateIfMissing = true) {
  const target = $("#drillList");
  if (!batch.drills.length) {
    if (generateIfMissing) { target.innerHTML = `<p class="pending-context">正在根据正文标注生成练习…</p>`; void generateDrills(batch); }
    else target.innerHTML = `<div class="pending-context">当前正文没有可用标注，或练习生成暂时失败。<button id="retryDrillsBtn" class="secondary-btn" type="button">重新生成练习</button></div>`;
    return;
  }
  target.innerHTML = batch.drills.map((drill,index) => `<article class="drill-card"><span class="drill-number">TASK ${String(index+1).padStart(2,"0")} · ${drill.kind}</span><h3>${escapeHtml(drill.prompt)}</h3><textarea data-drill-id="${drill.drillId}" placeholder="在这里写下英文句子"></textarea><div class="drill-actions"><button class="secondary-btn judge-btn" data-drill-id="${drill.drillId}">检查表达</button></div><div class="drill-feedback hidden" id="feedback-${drill.drillId}"></div></article>`).join("");
  $$(".judge-btn").forEach((button) => button.addEventListener("click", () => judgeDrill(batch,button.dataset.drillId)));
}

async function generateDrills(batch) {
  try {
    const response = await modelFetch("/api/drills/generate", { senses:batch.senses, scene:batch.scene, judgments:batch.report?.semantic?.judgments ?? [] });
    const payload = await response.json(); if (!response.ok) throw new Error(payload.error || `练习生成失败 (${response.status})`);
    batch.drills = payload.drills ?? []; storage.save(state); renderDrills(batch, false);
  } catch { renderDrills(batch, false); }
  $("#retryDrillsBtn")?.addEventListener("click", () => { $("#drillList").innerHTML = `<p class="pending-context">正在重新生成练习…</p>`; void generateDrills(batch); });
}

async function judgeDrill(batch, drillId) {
  const drill = batch.drills.find((item) => item.drillId === drillId); const sentence = $(`textarea[data-drill-id="${CSS.escape(drillId)}"]`).value.trim();
  if (!sentence) return toast("请先写一个英文句子");
  const button = $(`.judge-btn[data-drill-id="${CSS.escape(drillId)}"]`); const panel = $(`#feedback-${CSS.escape(drillId)}`); button.disabled = true; button.textContent = "正在检查…";
  try {
    const sense = batch.senses.find((item) => item.senseId === drill.senseId); const response = await modelFetch("/api/drill/judge", { sentence,sense,prompt:drill.prompt }); const result = await response.json();
    if (!response.ok) throw new Error(result.error || `检查失败 (${response.status})`);
    const checks = [["题目要求",result.instructionFollowed],["指定词义",result.senseCorrect],["语法",result.grammarCorrect],["自然度",result.natural]].map(([label,passed]) => `${passed ? "通过" : "需修改"} · ${label}`);
    panel.textContent = `${checks.join("\n")}\n\n${result.feedback}${result.correctedSentence && result.correctedSentence !== sentence ? `\n\n推荐改写：${result.correctedSentence}` : ""}`; panel.classList.remove("hidden");
    state.drillResults.push({ drillId, word:drill.word, senseId:drill.senseId, userInput:sentence, verdict:result.verdict, checks:{ instructionFollowed:result.instructionFollowed, senseCorrect:result.senseCorrect, grammarCorrect:result.grammarCorrect, natural:result.natural }, correctedSentence:result.correctedSentence, at:new Date().toISOString() }); storage.save(state);
  } catch (error) { panel.textContent = error.message; panel.classList.remove("hidden"); }
  finally { button.disabled = false; button.textContent = "检查表达"; }
}

function renderContexts() {
  if (!state.batches.length) return; const words = [...new Set(state.batches.flatMap((batch) => batch.batch.words))].sort(); const target = $("#contextContent"); target.className = "context-layout";
  target.innerHTML = `<aside class="word-index">${words.map((word,index) => `<button class="${index===0?"active":""}" data-context-word="${escapeHtml(word)}">${escapeHtml(word)}</button>`).join("")}</aside><div id="timeline" class="timeline"></div>`;
  $$("[data-context-word]").forEach((button) => button.addEventListener("click", () => { $$("[data-context-word]").forEach((item) => item.classList.toggle("active",item===button)); renderTimeline(button.dataset.contextWord); })); renderTimeline(words[0]);
}

function renderTimeline(word) {
  const records = state.batches.flatMap((batch) => renderableOccurrences(batch).filter((occ) => occ.word === word).map((occ) => ({ batch,occ,sense:batch.senses.find((sense) => sense.senseId === occ.senseId) }))).filter((item) => item.sense);
  $("#timeline").innerHTML = `<h2 class="timeline-title">${escapeHtml(word)} · ${records.length} 次语境记录</h2>${records.map(({batch,occ,sense}) => `<article class="timeline-item"><h3>第 ${batch.batch.batchIndex} 批 · ${escapeHtml(batch.scene.sceneTitleZh)}</h3><span class="status-chip">${escapeHtml(sense.zhDef)}</span><blockquote>${escapeHtml(occ.contextSnippet)}</blockquote><p>在「${escapeHtml(batch.scene.sceneTitleZh)}」场景中意为「${escapeHtml(sense.zhDef)}」。</p></article>`).join("")}${records.length < 2 ? `<div class="pending-context">目前只有一个已生成场景，完成后续批次后可进行语境对照。</div>`:""}`;
}

function coverageRows() {
  const map = new Map();
  state.batches.forEach((batch) => batch.senses.forEach((sense) => { const key=`${sense.word}:${sense.senseId}`; const row=map.get(key)??{word:sense.word,senseId:sense.senseId,scenes:new Set(),status:"pending"}; const status=semanticStatus(batch,sense.senseId); if(status==="covered"){row.status="covered";row.scenes.add(batch.batch.batchIndex);} map.set(key,row); })); return [...map.values()];
}

function renderProgress() {
  if (!state.batches.length) return; const rows=coverageRows(),covered=rows.filter((row)=>row.status==="covered"),pending=rows.length-covered.length,repeated=covered.filter((row)=>row.scenes.size>1).length; const distribution=[1,2,3].map((count)=>count===3?covered.filter((row)=>row.scenes.size>=3).length:covered.filter((row)=>row.scenes.size===count).length); const max=Math.max(1,...distribution); const target=$("#progressContent"); target.className="";
  target.innerHTML=`<div class="metric-grid"><div class="metric"><strong>${covered.length}</strong><span>已覆盖义项</span></div><div class="metric"><strong>${pending}</strong><span>待学义项</span></div><div class="metric"><strong>${repeated}</strong><span>跨场景重复义项</span></div><div class="metric"><strong>${state.profile.streak}</strong><span>连续学习天数</span></div></div><section class="distribution"><h2>多语境接触分布</h2>${["1 个场景","2 个场景","3 个及以上"].map((label,index)=>`<div class="bar-row"><span>${label}</span><div class="bar-track"><span style="width:${distribution[index]/max*100}%"></span></div><strong>${distribution[index]}</strong></div>`).join("")}</section><table class="history-table"><thead><tr><th>批次</th><th>场景</th><th>词数</th><th>覆盖率</th><th>尝试</th></tr></thead><tbody>${state.batches.map((batch)=>`<tr><td>#${batch.batch.batchIndex}</td><td>${escapeHtml(batch.scene.sceneTitleZh)}</td><td>${batch.batch.words.length}</td><td>${Math.round(annotationCoverage(batch).coverageRate*100)}%</td><td>${batch.report.attempt}</td></tr>`).join("")}</tbody></table>`;
}

function metricsFor(batch) { const judgments=batch.report.semantic.judgments,attemptsRun=batch.trace.filter((item)=>item.startsWith("生成与校验：第 ")).length; return { coverage_rate:batch.report.semantic.coverageRate, accepted:batch.report.accepted?1:0, first_pass_rate:batch.report.accepted&&batch.report.attempt===1?1:0, selected_attempt:batch.report.attempt, attempts_run:attemptsRun, positional_pass_rate:batch.report.positional.passed?1:0, narrative_pass_rate:batch.report.narrative.passed?1:0, language_pass_rate:batch.report.narrative.languagePassed?1:0, wrong_sense_rate:judgments.length?judgments.filter((item)=>item.sourceSenseId&&item.sourceSenseId!==item.senseId).length/judgments.length:0, ambiguous_rate:judgments.length?judgments.filter((item)=>item.verdict==="ambiguous").length/judgments.length:0, deferral_rate:batch.senses.length?batch.deferrals.entries.length/batch.senses.length:0, dispersal_compliance:batch.deferrals.dispersalCheck.allCompliant?1:0, degradation_rate:batch.degradation?1:0 }; }
function updateStreak() { const today=new Date().toISOString().slice(0,10),last=state.profile.lastStudyDate; if(last!==today){const yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10);state.profile.streak=last===yesterday?state.profile.streak+1:1;state.profile.lastStudyDate=today;} }
function exportState() { const url=URL.createObjectURL(storage.export()),anchor=document.createElement("a");anchor.href=url;anchor.download=`scene-lexicon-${new Date().toISOString().slice(0,10)}.json`;anchor.click();URL.revokeObjectURL(url);toast("学习状态已导出"); }
function resetState() { storage.reset(); state=storage.load(); current=null; $("#confirmDialog").close(); $("#workspace").classList.add("hidden"); $("#composer").classList.remove("hidden"); $("#wordInput").value=""; updateInputHint(); updateBatchIndex(); location.reload(); }
function showError(message) { $("#errorMessage").textContent=message; $("#errorPanel").classList.remove("hidden"); lucide.createIcons(); }
function hideError() { $("#errorPanel").classList.add("hidden"); }
function toast(message) { const target=$("#toast");target.textContent=message;target.classList.add("show");setTimeout(()=>target.classList.remove("show"),2200); }

window.addEventListener("pagehide", () => { modelCredentials = null; $("#apiKeyInput").value = ""; });

boot();