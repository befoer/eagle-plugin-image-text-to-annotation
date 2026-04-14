const SUPPORTED_INPUT_FORMATS = new Set(["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff"]);

const LANGUAGE_LABELS = {
  "chi_sim+eng": "简体中文 + 英文",
  chi_sim: "仅简体中文",
  eng: "仅英文",
};

const WRITE_MODE_LABELS = {
  append: "追加到注释",
  overwrite: "覆盖注释",
  empty_only: "仅注释为空时写入",
  name_overwrite: "写入文件名",
  name_append: "追加到文件名",
};

const RUNTIME_BOOTSTRAP = {
  pythonVersion: "3.12.10",
  pythonSeries: "3.12",
  pythonBaseUrl: "https://www.python.org/ftp/python/3.12.10/",
  paddleocrVersion: "3.4.0",
  paddlepaddleVersion: "3.3.1",
  paddleCpuIndex: "https://www.paddlepaddle.org.cn/packages/stable/cpu/",
  runtimeFolderName: "image-text-to-annotation",
  requiredPluginPaths: [
    ["python", "paddle_ocr_runner.py"],
    ["python", "bootstrap_paddle_runtime.py"],
  ],
  requiredDependencyPaths: [
    ["python_deps", "paddleocr", "__init__.py"],
    ["python_deps", "paddle", "base", "libpaddle.pyd"],
  ],
};

const CJK_CHAR_PATTERN = /[\u3400-\u9fff]/g;
const OCR_PSM = {
  SINGLE_BLOCK: 6,
  SINGLE_LINE: 7,
  SINGLE_WORD: 8,
  SINGLE_CHAR: 10,
  SPARSE_TEXT: 11,
  RAW_LINE: 13,
};

const state = {
  selectedItems: [],
  plan: [],
  busy: false,
  worker: null,
  workerLanguages: "",
  lastSelectionRefreshAt: 0,
  dialogResolver: null,
  dialogCancellable: false,
  runtimeStatus: "pending",
  runtimeTitle: "AI 本地 OCR 初始化",
  runtimeMessage: "正在初始化本地 OCR 模型，首次启动通常需要几分钟。",
  runtimeLogs: [],
  runtimeInstallPromise: null,
};

function getEl(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const el = getEl(id);
  if (el) {
    el.textContent = value;
  }
}

function setDisabled(id, disabled) {
  const el = getEl(id);
  if (el) {
    el.disabled = disabled;
  }
}

function setRuntimeState(patch = {}) {
  Object.assign(state, patch);
  renderRuntimeCard();
  updateActionState();
}

function appendRuntimeLog(message) {
  const line = String(message || "").trim();
  if (!line) {
    return;
  }

  const nextLogs = [...state.runtimeLogs, line].slice(-4);
  state.runtimeLogs = nextLogs;
  renderRuntimeCard();
}

function renderRuntimeCard() {
  const bootstrapScreen = getEl("bootstrapScreen");
  const pluginFrame = getEl("pluginFrame");
  const title = getEl("bootstrapTitle");
  const message = getEl("bootstrapMessage");
  const spinner = getEl("bootstrapSpinner");
  const retryButton = getEl("bootstrapRetryButton");

  if (!bootstrapScreen || !pluginFrame || !title || !message || !spinner || !retryButton) {
    return;
  }

  const previewMode = !window.eagle?.item?.getSelected;
  const status = String(state.runtimeStatus || "pending");
  const showBootstrap = !previewMode && status !== "ready";

  bootstrapScreen.hidden = !showBootstrap;
  pluginFrame.hidden = showBootstrap;
  title.textContent = state.runtimeTitle || "AI 本地 OCR 初始化";
  message.textContent = state.runtimeMessage || "";
  spinner.hidden = status === "error";
  retryButton.hidden = status !== "error";
}

function isDialogOpen() {
  const root = getEl("dialogRoot");
  return Boolean(root && !root.hidden);
}

function closeDialog(result) {
  const root = getEl("dialogRoot");
  if (!root || root.hidden) {
    return;
  }

  root.hidden = true;
  const resolver = state.dialogResolver;
  state.dialogResolver = null;
  state.dialogCancellable = false;

  if (resolver) {
    resolver(result);
  }
}

function showDialog({ title, message, variant = "info", confirmText = "确认", cancelText = "取消", cancellable = false }) {
  const root = getEl("dialogRoot");
  const titleEl = getEl("dialogTitle");
  const messageEl = getEl("dialogMessage");
  const iconEl = getEl("dialogIcon");
  const actionsEl = getEl("dialogActions");
  const confirmButton = getEl("dialogConfirmButton");
  const cancelButton = getEl("dialogCancelButton");

  if (!root || !titleEl || !messageEl || !iconEl || !actionsEl || !confirmButton || !cancelButton) {
    return Promise.resolve(true);
  }

  titleEl.textContent = title;
  messageEl.textContent = message;
  confirmButton.textContent = confirmText;
  cancelButton.textContent = cancelText;
  cancelButton.hidden = !cancellable;
  actionsEl.classList.toggle("single", !cancellable);
  iconEl.className = `dialog-icon ${variant}`;
  iconEl.textContent = variant === "success" ? "✓" : variant === "error" ? "!" : variant === "confirm" ? "?" : "i";
  root.hidden = false;
  state.dialogCancellable = cancellable;

  return new Promise((resolve) => {
    state.dialogResolver = resolve;
    window.setTimeout(() => {
      confirmButton.focus();
    }, 0);
  });
}

function showNotice(message, options = {}) {
  return showDialog({
    title: options.title || "提示",
    message,
    variant: options.variant || "info",
    confirmText: options.confirmText || "确认",
    cancellable: false,
  });
}

function showConfirm(message, options = {}) {
  return showDialog({
    title: options.title || "确认操作",
    message,
    variant: options.variant || "confirm",
    confirmText: options.confirmText || "确认",
    cancelText: options.cancelText || "取消",
    cancellable: true,
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function getCanvasContext(canvas, options = {}) {
  const context = canvas.getContext("2d", options);
  if (!context) {
    throw new Error("无法创建画布上下文。");
  }
  return context;
}

function getNodeModule(name) {
  try {
    if (window.require) {
      return window.require(name);
    }
  } catch (error) {
    return null;
  }

  try {
    return require(name);
  } catch (error) {
    return null;
  }
}

function normalizeExtension(item) {
  const candidates = [item?.ext, item?.extension, item?.name, item?.filename, item?.filePath];

  for (const candidate of candidates) {
    const value = String(candidate || "");
    const match = value.match(/\.?([a-zA-Z0-9]+)$/);
    if (match?.[1]) {
      return match[1].toLowerCase();
    }
  }

  return "";
}

function buildDisplayName(item) {
  const baseName = String(item?.name || item?.filename || item?.id || "未命名项目").trim();
  const extension = normalizeExtension(item);
  if (!extension) {
    return baseName;
  }

  const suffix = `.${extension}`;
  if (baseName.toLowerCase().endsWith(suffix.toLowerCase())) {
    return baseName;
  }

  return `${baseName}${suffix}`;
}

function stripKnownExtension(value, extension) {
  const text = String(value || "").trim();
  const safeExtension = String(extension || "").trim();
  if (!text || !safeExtension) {
    return text;
  }

  const suffix = `.${safeExtension}`;
  if (!text.toLowerCase().endsWith(suffix.toLowerCase())) {
    return text;
  }

  return text.slice(0, -suffix.length).trim();
}

function getPSM(name) {
  return window.Tesseract?.PSM?.[name] ?? OCR_PSM[name] ?? OCR_PSM.SPARSE_TEXT;
}

function clampRect(rect, width, height) {
  const left = Math.max(0, Math.min(width - 1, Math.round(rect.left)));
  const top = Math.max(0, Math.min(height - 1, Math.round(rect.top)));
  const rectWidth = Math.max(1, Math.min(width - left, Math.round(rect.width)));
  const rectHeight = Math.max(1, Math.min(height - top, Math.round(rect.height)));

  return {
    left,
    top,
    width: rectWidth,
    height: rectHeight,
  };
}

function extractRegionCanvas(source, rect, scale = 1) {
  const safeRect = clampRect(rect, source.width, source.height);
  const canvas = createCanvas(safeRect.width * scale, safeRect.height * scale);
  const context = getCanvasContext(canvas);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    source,
    safeRect.left,
    safeRect.top,
    safeRect.width,
    safeRect.height,
    0,
    0,
    canvas.width,
    canvas.height
  );
  return canvas;
}

function binarizeCanvas(canvas, threshold = 208) {
  const context = getCanvasContext(canvas, { willReadFrequently: true });
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  for (let index = 0; index < data.length; index += 4) {
    const luminance = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
    const value = luminance < threshold ? 0 : 255;
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
    data[index + 3] = 255;
  }

  context.putImageData(imageData, 0, 0);
}

function detectInkBounds(canvas) {
  const context = getCanvasContext(canvas, { willReadFrequently: true });
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let minX = canvas.width;
  let minY = canvas.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const offset = (y * canvas.width + x) * 4;
      if (data[offset] < 180) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < 0 || maxY < 0) {
    return null;
  }

  return {
    left: minX,
    top: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function trimCanvasToInk(canvas, padding = 8) {
  const bounds = detectInkBounds(canvas);
  if (!bounds) {
    return canvas;
  }

  const trimmedRect = clampRect(
    {
      left: bounds.left - padding,
      top: bounds.top - padding,
      width: bounds.width + padding * 2,
      height: bounds.height + padding * 2,
    },
    canvas.width,
    canvas.height
  );

  const trimmedCanvas = createCanvas(trimmedRect.width, trimmedRect.height);
  const context = getCanvasContext(trimmedCanvas);
  context.drawImage(
    canvas,
    trimmedRect.left,
    trimmedRect.top,
    trimmedRect.width,
    trimmedRect.height,
    0,
    0,
    trimmedCanvas.width,
    trimmedCanvas.height
  );
  return trimmedCanvas;
}

function prepareRecognitionCanvas(canvas, threshold) {
  const preparedCanvas = createCanvas(canvas.width, canvas.height);
  const context = getCanvasContext(preparedCanvas);
  context.drawImage(canvas, 0, 0);
  if (Number.isFinite(threshold)) {
    binarizeCanvas(preparedCanvas, threshold);
  }
  return trimCanvasToInk(preparedCanvas);
}

function getLanguageLabel(value) {
  return LANGUAGE_LABELS[value] || value;
}

function getWriteModeLabel(value) {
  return WRITE_MODE_LABELS[value] || value;
}

function readSettings() {
  const language = String(getEl("ocrLanguageSelect")?.value || "chi_sim+eng");
  const writeMode = String(getEl("writeModeSelect")?.value || "append");
  const trimText = Boolean(getEl("trimTextCheckbox")?.checked);

  if (!LANGUAGE_LABELS[language]) {
    throw new Error("识别语言选项无效。");
  }

  if (!WRITE_MODE_LABELS[writeMode]) {
    throw new Error("写入方式选项无效。");
  }

  return {
    language,
    writeMode,
    trimText,
  };
}

function createPlanEntry(item, settings) {
  const extension = normalizeExtension(item);
  const existingAnnotation = String(item?.annotation || "").trim();
  const existingName = stripKnownExtension(item?.name || item?.filename || item?.id || "", extension);

  if (!SUPPORTED_INPUT_FORMATS.has(extension)) {
    return {
      item,
      status: "skip",
      message: `暂不支持 ${extension || "未知"} 格式`,
      recognizedText: "",
      recognizedPreview: "",
      confidence: null,
    };
  }

  if (!item?.filePath && !item?.fileURL) {
    return {
      item,
      status: "skip",
      message: "没有可用的原图路径",
      recognizedText: "",
      recognizedPreview: "",
      confidence: null,
    };
  }

  if (settings.writeMode === "empty_only" && existingAnnotation) {
    return {
      item,
      status: "skip",
      message: "当前注释不为空",
      recognizedText: "",
      recognizedPreview: "",
      confidence: null,
    };
  }

  if (settings.writeMode === "name_append" && !existingName) {
    return {
      item,
      status: "skip",
      message: "当前文件名为空，无法追加",
      recognizedText: "",
      recognizedPreview: "",
      confidence: null,
    };
  }

  return {
    item,
    status: "ready",
    message: `${getLanguageLabel(settings.language)} | ${getWriteModeLabel(settings.writeMode)}`,
    recognizedText: "",
    recognizedPreview: "",
    confidence: null,
  };
}

function derivePlan() {
  let settings = null;

  try {
    settings = readSettings();
  } catch (error) {
    state.plan = state.selectedItems.map((item) => ({
      item,
      status: "skip",
      message: error?.message || String(error),
      recognizedText: "",
      recognizedPreview: "",
      confidence: null,
    }));
    renderSelectionList();
    updateActionState();
    return;
  }

  state.plan = state.selectedItems.map((item) => createPlanEntry(item, settings));
  renderSelectionList();
  updateActionState();
}

function getStatusLabel(status) {
  switch (status) {
    case "ready":
      return "将识别";
    case "processing":
      return "识别中";
    case "done":
      return "已写入";
    case "error":
      return "失败";
    default:
      return "跳过";
  }
}

function createPreview(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return "";
  }

  if (normalized.length <= 140) {
    return normalized;
  }

  return `${normalized.slice(0, 140)}...`;
}

function sanitizeFileNameText(value) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
}

function normalizeCjkSpaces(text) {
  let nextValue = String(text || "");
  let previousValue = "";

  while (nextValue !== previousValue) {
    previousValue = nextValue;
    nextValue = nextValue.replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1");
  }

  return nextValue;
}

function stripChineseLineNoise(line, language) {
  const value = String(line || "");
  if (!hasChineseLanguage(language)) {
    return value;
  }

  const { cjkCount } = getTextStats(value);
  if (cjkCount < 4) {
    return value;
  }

  return value
    .replace(/^[^A-Za-z0-9\u3400-\u9fff]*[A-Za-z0-9]{1,4}\s+(?=[\u3400-\u9fff])/g, "")
    .replace(/\s+[A-Za-z0-9]{1,6}[^A-Za-z0-9\u3400-\u9fff]*$/g, "")
    .replace(/^[^A-Za-z0-9\u3400-\u9fff]+|[^A-Za-z0-9\u3400-\u9fff]+$/g, "");
}

function hasChineseLanguage(language) {
  return String(language || "").includes("chi_sim");
}

function countMatches(text, pattern) {
  const matches = String(text || "").match(pattern);
  return matches ? matches.length : 0;
}

function getTextStats(text) {
  const value = String(text || "").trim();
  return {
    text: value,
    cjkCount: countMatches(value, CJK_CHAR_PATTERN),
    letterCount: countMatches(value, /[A-Za-z]/g),
    digitCount: countMatches(value, /\d/g),
    symbolCount: countMatches(value, /[^A-Za-z0-9\u3400-\u9fff\s]/g),
    lineCount: value ? value.split("\n").filter(Boolean).length : 0,
  };
}

function isLikelyNoiseLine(line, language) {
  const text = String(line || "").trim();
  if (!text) {
    return true;
  }

  const { cjkCount, letterCount, digitCount, symbolCount } = getTextStats(text);
  const signalCount = cjkCount + letterCount + digitCount;

  if (signalCount === 0) {
    return true;
  }

  if (language !== "eng" && cjkCount === 0 && letterCount > 0 && symbolCount >= letterCount) {
    return true;
  }

  if (language !== "eng" && cjkCount === 0 && text.length <= 3 && letterCount <= 2) {
    return true;
  }

  if (hasChineseLanguage(language) && cjkCount > 0) {
    const nonCjkSignal = letterCount + digitCount;
    if (nonCjkSignal >= 2 && cjkCount <= nonCjkSignal + 1 && text.length <= 12) {
      return true;
    }
  }

  if (symbolCount > signalCount) {
    return true;
  }

  return false;
}

function normalizeRecognizedText(text, trimText, language) {
  const raw = normalizeCjkSpaces(String(text || "").replaceAll("\r", ""));
  const normalizedLines = raw
    .split("\n")
    .map((line) => (trimText ? line.trim() : line))
    .map((line) => normalizeCjkSpaces(line))
    .map((line) => stripChineseLineNoise(line, language))
    .filter((line) => line.trim())
    .filter((line) => !isLikelyNoiseLine(line, language));

  return trimText ? normalizedLines.join("\n").trim() : normalizedLines.join("\n");
}

function normalizeCompactChineseText(text) {
  return normalizeCjkSpaces(String(text || "").replaceAll(/\s+/g, "").trim());
}

function scoreRecognitionCandidate(candidate, language) {
  const text = String(candidate?.text || "").trim();
  if (!text) {
    return -9999;
  }

  const { cjkCount, letterCount, digitCount, lineCount } = getTextStats(text);
  let score = Number(candidate?.confidence || 0);

  score += cjkCount * (language === "eng" ? 0.25 : 5);
  score += letterCount * (language === "eng" ? 3 : 1.2);
  score += digitCount * 1.5;

  if (candidate?.name === "top-line-rect" || candidate?.name === "bottom-line-rect") {
    score += 19;
  } else if (candidate?.name === "top-line-tight" || candidate?.name === "bottom-line-tight") {
    score += 17;
  } else if (candidate?.name === "top-raw-line" || candidate?.name === "bottom-raw-line") {
    score += 15;
  } else if (
    candidate?.name === "top-line" ||
    candidate?.name === "top-line-soft" ||
    candidate?.name === "bottom-line" ||
    candidate?.name === "bottom-line-soft"
  ) {
    score += 14;
  } else if (candidate?.name === "top-block" || candidate?.name === "bottom-block") {
    score += 9;
  } else if (candidate?.name === "left-char") {
    score += 8;
  } else if (candidate?.name === "left-word") {
    score += 4;
  }

  if (lineCount > 2) {
    score -= (lineCount - 2) * 5;
  }

  return score;
}

function buildRecognitionJobs(source) {
  const width = source.width;
  const height = source.height;

  return [
    {
      name: "top-line-rect",
      rectangle: clampRect({ left: width * 0.08, top: 0, width: width * 0.84, height: height * 0.24 }, width, height),
      psm: getPSM("SINGLE_LINE"),
      threshold: null,
      asciiRestricted: true,
    },
    {
      name: "top-line-tight",
      canvas: extractRegionCanvas(
        source,
        { left: width * 0.08, top: 0, width: width * 0.84, height: height * 0.24 },
        4
      ),
      psm: getPSM("SINGLE_LINE"),
      threshold: 226,
      asciiRestricted: true,
    },
    {
      name: "top-line",
      canvas: extractRegionCanvas(source, { left: 0, top: 0, width, height: height * 0.34 }, 3),
      psm: getPSM("SINGLE_LINE"),
      threshold: 220,
      asciiRestricted: true,
    },
    {
      name: "top-raw-line",
      canvas: extractRegionCanvas(
        source,
        { left: width * 0.06, top: 0, width: width * 0.88, height: height * 0.26 },
        4.2
      ),
      psm: getPSM("RAW_LINE"),
      threshold: 222,
      asciiRestricted: true,
    },
    {
      name: "top-block",
      canvas: extractRegionCanvas(source, { left: 0, top: 0, width, height: height * 0.42 }, 2.5),
      psm: getPSM("SINGLE_BLOCK"),
      threshold: 214,
      asciiRestricted: true,
    },
    {
      name: "left-word",
      canvas: extractRegionCanvas(
        source,
        { left: 0, top: height * 0.34, width: width * 0.35, height: height * 0.42 },
        3
      ),
      psm: getPSM("SINGLE_WORD"),
      threshold: 210,
      asciiRestricted: true,
    },
    {
      name: "left-char",
      canvas: extractRegionCanvas(
        source,
        { left: width * 0.04, top: height * 0.44, width: width * 0.29, height: height * 0.28 },
        4.4
      ),
      psm: getPSM("SINGLE_CHAR"),
      threshold: 212,
      asciiRestricted: true,
    },
    {
      name: "top-line-soft",
      canvas: extractRegionCanvas(source, { left: 0, top: 0, width, height: height * 0.32 }, 3.4),
      psm: getPSM("SINGLE_LINE"),
      threshold: null,
      asciiRestricted: true,
    },
    {
      name: "bottom-line-rect",
      rectangle: clampRect(
        { left: width * 0.08, top: height * 0.74, width: width * 0.84, height: height * 0.22 },
        width,
        height
      ),
      psm: getPSM("SINGLE_LINE"),
      threshold: null,
      asciiRestricted: true,
    },
    {
      name: "bottom-line-tight",
      canvas: extractRegionCanvas(
        source,
        { left: width * 0.08, top: height * 0.74, width: width * 0.84, height: height * 0.22 },
        4
      ),
      psm: getPSM("SINGLE_LINE"),
      threshold: 226,
      asciiRestricted: true,
    },
    {
      name: "bottom-line",
      canvas: extractRegionCanvas(source, { left: 0, top: height * 0.7, width, height: height * 0.26 }, 3.2),
      psm: getPSM("SINGLE_LINE"),
      threshold: 220,
      asciiRestricted: true,
    },
    {
      name: "bottom-raw-line",
      canvas: extractRegionCanvas(
        source,
        { left: width * 0.04, top: height * 0.7, width: width * 0.92, height: height * 0.28 },
        4.2
      ),
      psm: getPSM("RAW_LINE"),
      threshold: 222,
      asciiRestricted: true,
    },
    {
      name: "bottom-block",
      canvas: extractRegionCanvas(source, { left: 0, top: height * 0.68, width, height: height * 0.32 }, 2.6),
      psm: getPSM("SINGLE_BLOCK"),
      threshold: 214,
      asciiRestricted: true,
    },
    {
      name: "bottom-line-soft",
      canvas: extractRegionCanvas(source, { left: 0, top: height * 0.72, width, height: height * 0.24 }, 3.4),
      psm: getPSM("SINGLE_LINE"),
      threshold: null,
      asciiRestricted: true,
    },
    {
      name: "full-sparse",
      canvas: extractRegionCanvas(source, { left: 0, top: 0, width, height }, 1.8),
      psm: getPSM("SPARSE_TEXT"),
      threshold: 205,
    },
  ];
}

function isShortCjkSupplement(candidateText, language) {
  if (!hasChineseLanguage(language)) {
    return false;
  }

  const { cjkCount, letterCount, digitCount, lineCount } = getTextStats(candidateText);
  return cjkCount >= 1 && cjkCount <= 4 && letterCount === 0 && digitCount === 0 && lineCount === 1;
}

function shouldPreferPrimaryCandidate(primaryCandidate, settings) {
  if (!primaryCandidate || !hasChineseLanguage(settings.language)) {
    return false;
  }

  const { cjkCount, lineCount, letterCount, digitCount } = getTextStats(primaryCandidate.text);
  const isTopCandidate =
    primaryCandidate.name === "top-line-rect" ||
    primaryCandidate.name === "top-line-tight" ||
    primaryCandidate.name === "top-raw-line" ||
    primaryCandidate.name === "top-line" ||
    primaryCandidate.name === "top-line-soft" ||
    primaryCandidate.name === "top-block" ||
    primaryCandidate.name === "bottom-line-rect" ||
    primaryCandidate.name === "bottom-line-tight" ||
    primaryCandidate.name === "bottom-raw-line" ||
    primaryCandidate.name === "bottom-line" ||
    primaryCandidate.name === "bottom-line-soft" ||
    primaryCandidate.name === "bottom-block";

  return isTopCandidate && cjkCount >= 4 && lineCount <= 2 && letterCount + digitCount <= 1;
}

function buildChineseTitleConsensus(sortedCandidates, settings) {
  if (!hasChineseLanguage(settings.language)) {
    return "";
  }

  const titleCandidateNames = new Set([
    "top-line-rect",
    "top-line-tight",
    "top-raw-line",
    "top-line",
    "top-line-soft",
    "top-block",
    "bottom-line-rect",
    "bottom-line-tight",
    "bottom-raw-line",
    "bottom-line",
    "bottom-line-soft",
    "bottom-block",
  ]);
  const titleCandidates = sortedCandidates
    .filter((candidate) => titleCandidateNames.has(candidate.name))
    .map((candidate) => ({
      ...candidate,
      compactText: normalizeCompactChineseText(candidate.text),
    }))
    .filter((candidate) => {
      const { cjkCount, letterCount, digitCount, lineCount } = getTextStats(candidate.compactText);
      return cjkCount >= 4 && letterCount === 0 && digitCount === 0 && lineCount <= 2;
    });

  if (titleCandidates.length < 2) {
    return "";
  }

  const primaryCandidate = titleCandidates[0];
  const targetLength = primaryCandidate.compactText.length;
  const alignedCandidates = titleCandidates.filter((candidate) => candidate.compactText.length === targetLength);
  if (alignedCandidates.length < 2) {
    return primaryCandidate.compactText;
  }

  const lastIndex = targetLength - 1;
  const voteBuckets = Array.from({ length: targetLength }, () => new Map());

  for (const candidate of alignedCandidates) {
    const weight = Math.max(1, scoreRecognitionCandidate({ ...candidate, text: candidate.compactText }, settings.language));
    for (let index = 0; index < targetLength; index += 1) {
      const currentChar = candidate.compactText[index];
      if (!currentChar) {
        continue;
      }
      voteBuckets[index].set(currentChar, (voteBuckets[index].get(currentChar) || 0) + weight);
    }
  }

  const singleCharCandidates = sortedCandidates
    .filter((candidate) => candidate.name === "left-char" || candidate.name === "left-word")
    .map((candidate) => normalizeCompactChineseText(candidate.text))
    .filter((text) => /^[\u3400-\u9fff]{1,2}$/.test(text));

  for (const text of singleCharCandidates) {
    const currentChar = text[text.length - 1];
    voteBuckets[lastIndex].set(currentChar, (voteBuckets[lastIndex].get(currentChar) || 0) + 12);
  }

  const consensus = voteBuckets
    .map((bucket, index) => {
      if (!bucket.size) {
        return primaryCandidate.compactText[index] || "";
      }
      return [...bucket.entries()].sort((left, right) => right[1] - left[1])[0][0];
    })
    .join("")
    .trim();

  return consensus;
}

function mergeRecognitionCandidates(candidates, settings) {
  const validCandidates = candidates.filter((candidate) => String(candidate?.text || "").trim());
  if (!validCandidates.length) {
    return {
      text: "",
      confidence: null,
    };
  }

  const sortedCandidates = [...validCandidates].sort(
    (left, right) => scoreRecognitionCandidate(right, settings.language) - scoreRecognitionCandidate(left, settings.language)
  );

  const primaryCandidate = sortedCandidates[0];
  const mergedTexts = [];
  const mergedConfidences = [];

  if (shouldPreferPrimaryCandidate(primaryCandidate, settings)) {
    const consensusTitle = buildChineseTitleConsensus(sortedCandidates, settings);
    mergedTexts.push(consensusTitle || String(primaryCandidate.text || "").trim());
    if (Number.isFinite(primaryCandidate.confidence)) {
      mergedConfidences.push(primaryCandidate.confidence);
    }

    for (const candidate of sortedCandidates.slice(1)) {
      const candidateText = String(candidate?.text || "").trim();
      if (!candidateText || mergedTexts.includes(candidateText)) {
        continue;
      }

      if (mergedTexts.some((existingText) => existingText.includes(candidateText) || candidateText.includes(existingText))) {
        continue;
      }

      if (candidate.name === "left-char" || candidate.name === "left-word") {
        if (!isShortCjkSupplement(candidateText, settings.language)) {
          continue;
        }

        mergedTexts.push(candidateText);
        if (Number.isFinite(candidate.confidence)) {
          mergedConfidences.push(candidate.confidence);
        }
      }
    }

    return {
      text: mergedTexts.join("\n").trim(),
      confidence: mergedConfidences.length
        ? Math.round(mergedConfidences.reduce((sum, current) => sum + current, 0) / mergedConfidences.length)
        : null,
    };
  }

  for (const candidate of sortedCandidates) {
    const candidateText = String(candidate.text || "").trim();
    if (!candidateText) {
      continue;
    }

    if (hasChineseLanguage(settings.language) && candidate.name === "full-sparse") {
      const { cjkCount, letterCount, digitCount, lineCount } = getTextStats(candidateText);
      if (cjkCount < 2 || letterCount + digitCount >= cjkCount || lineCount > 2) {
        continue;
      }
    }

    const isDuplicate = mergedTexts.some(
      (existingText) => existingText.includes(candidateText) || candidateText.includes(existingText)
    );
    if (isDuplicate) {
      continue;
    }

    if (candidate.name === "left-word" && mergedTexts.some((existingText) => existingText.includes(candidateText))) {
      continue;
    }

    mergedTexts.push(candidateText);
    if (Number.isFinite(candidate.confidence)) {
      mergedConfidences.push(candidate.confidence);
    }
  }

  return {
    text: mergedTexts.join("\n").trim(),
    confidence: mergedConfidences.length
      ? Math.round(mergedConfidences.reduce((sum, current) => sum + current, 0) / mergedConfidences.length)
      : null,
  };
}

function renderSelectionList() {
  const container = getEl("selectionList");
  if (!container) {
    return;
  }

  setText("selectedCount", String(state.selectedItems.length));
  setText(
    "processableCount",
    String(state.plan.filter((entry) => entry.status === "ready" || entry.status === "done").length)
  );

  if (!state.selectedItems.length) {
    container.innerHTML =
      '<div class="selection-empty">还没有读取到已选图片。请先在 Eagle 中选中需要处理的图片，再点击“刷新已选项目”。</div>';
    return;
  }

  container.innerHTML = state.plan
    .map((entry) => {
      const note =
        entry.status === "done" ? "" : String(entry.message || "").trim();
      const noteHtml = note ? `<div class="selection-item-note">${escapeHtml(note)}</div>` : "";
      const preview = entry.recognizedPreview
        ? `<div class="selection-item-preview">${escapeHtml(entry.recognizedPreview)}</div>`
        : "";
      return `
        <div class="selection-item">
          <div class="selection-item-main">
            <div class="selection-item-title">${escapeHtml(buildDisplayName(entry.item))}</div>
            ${noteHtml}
            ${preview}
          </div>
          <span class="status-badge ${escapeHtml(entry.status)}">${escapeHtml(getStatusLabel(entry.status))}</span>
        </div>
      `;
    })
    .join("");
}

function updateActionState() {
  const hasReadyItems = state.plan.some((entry) => entry.status === "ready");
  const runtimeInstalling = state.runtimeStatus === "installing";
  setDisabled("refreshSelectionButton", state.busy || runtimeInstalling);
  setDisabled("runButton", state.busy || runtimeInstalling || !hasReadyItems || !window.eagle?.item?.getSelected);
  setDisabled("ocrLanguageSelect", state.busy || runtimeInstalling);
  setDisabled("writeModeSelect", state.busy || runtimeInstalling);
  setDisabled("trimTextCheckbox", state.busy || runtimeInstalling);
  setDisabled("bootstrapRetryButton", runtimeInstalling);
}

async function readSelectedItems() {
  if (!window.eagle?.item?.getSelected) {
    setText("selectionHint", "");
    setText("listHint", "浏览器预览模式下不会真的识别和写入结果。");
    state.selectedItems = [];
    state.plan = [];
    renderSelectionList();
    updateActionState();
    return;
  }

  try {
    const items = await window.eagle.item.getSelected();
    state.selectedItems = Array.isArray(items) ? items : [];
    if (state.selectedItems.length) {
      state.lastSelectionRefreshAt = Date.now();
    }
    setText("selectionHint", "");
    setText("listHint", "会调用本地 PaddleOCR 识别并写入结果；首次运行会自动下载依赖和模型文件。");
    derivePlan();
  } catch (error) {
    state.selectedItems = [];
    state.plan = [];
    renderSelectionList();
    updateActionState();
    showNotice(`读取已选项目失败：${error?.message || error}`, {
      title: "读取失败",
      variant: "error",
    });
  }
}

async function refreshSelectionWithRetry(delays = [0, 120, 320]) {
  for (const waitMs of delays) {
    if (waitMs > 0) {
      await delay(waitMs);
    }

    await readSelectedItems();
    if (state.selectedItems.length) {
      return;
    }
  }
}

function updatePlanEntry(itemId, patch) {
  const entry = state.plan.find((candidate) => candidate.item?.id === itemId);
  if (!entry) {
    return;
  }

  Object.assign(entry, patch);
}

function resolveTesseractPaths() {
  const baseUrl = new URL(".", window.location.href);
  return {
    workerPath: new URL("vendor/worker.min.js", baseUrl).href,
    corePath: new URL("vendor/tesseract-core/", baseUrl).href,
    langPath: new URL("vendor/tessdata/", baseUrl).href,
  };
}

function buildRecognitionParameters(job, settings) {
  const params = {
    tessedit_pageseg_mode: job.psm,
    preserve_interword_spaces: "1",
  };

  if (settings.language === "chi_sim" && job.asciiRestricted) {
    params.tessedit_char_blacklist =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789`~!@#$%^&*()_+-=[]{}\\\\|;:'\",./<>?";
  }

  return params;
}

async function ensureWorker(language) {
  if (!window.Tesseract?.createWorker) {
    throw new Error("未找到 Tesseract.js 运行文件，请先补齐本地 OCR 资源。");
  }

  if (state.worker && state.workerLanguages === language) {
    return state.worker;
  }

  if (state.worker) {
    await state.worker.terminate();
    state.worker = null;
    state.workerLanguages = "";
  }

  const paths = resolveTesseractPaths();
  state.worker = await window.Tesseract.createWorker(language, 1, {
    workerPath: paths.workerPath,
    corePath: paths.corePath,
    langPath: paths.langPath,
  });
  state.workerLanguages = language;
  return state.worker;
}

function ensureNodeRuntime() {
  const fs = getNodeModule("fs");
  const path = getNodeModule("path");
  const url = getNodeModule("url");
  const childProcess = getNodeModule("child_process");
  const processModule = getNodeModule("process");

  if (!fs || !path || !url || !childProcess || !processModule) {
    throw new Error("当前 Eagle 运行环境未提供文件系统能力。");
  }

  return { fs, path, url, childProcess, process: processModule };
}

function normalizeCandidatePath(rawValue, nodeRuntime) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return "";
  }

  let normalized = value.replace(/[?#].*$/, "").replace(/\//g, nodeRuntime.path.sep);

  normalized = normalized.replace(/^[\\/]+(?=[A-Za-z]:[\\/])/, "");

  if (/^[A-Za-z]:\\/.test(normalized)) {
    return normalized;
  }

  if (/^[\\/]+[A-Za-z]:\\/.test(normalized)) {
    return normalized.replace(/^[\\/]+/, "");
  }

  return "";
}

function isPluginRoot(candidatePath, nodeRuntime) {
  const normalized = normalizeCandidatePath(candidatePath, nodeRuntime);
  if (!normalized) {
    return false;
  }

  const scriptPath = nodeRuntime.path.join(normalized, "python", "paddle_ocr_runner.py");
  const indexPath = nodeRuntime.path.join(normalized, "index.html");
  return nodeRuntime.fs.existsSync(scriptPath) && nodeRuntime.fs.existsSync(indexPath);
}

function resolveRuntimeRoot(nodeRuntime) {
  const env = nodeRuntime.process.env || {};
  const baseDir = [env.LOCALAPPDATA, env.APPDATA, env.USERPROFILE, env.HOME]
    .map((value) => String(value || "").trim())
    .find(Boolean);

  if (!baseDir) {
    throw new Error("无法定位本机缓存目录，请确认系统环境变量中包含 LOCALAPPDATA 或 USERPROFILE。");
  }

  return nodeRuntime.path.join(baseDir, "EaglePluginRuntime", RUNTIME_BOOTSTRAP.runtimeFolderName);
}

function buildRuntimeEnv(nodeRuntime, runtimeRoot) {
  const cacheRoot = nodeRuntime.path.join(runtimeRoot, "cache");
  return {
    ...nodeRuntime.process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    EAGLE_PLUGIN_RUNTIME_ROOT: runtimeRoot,
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True",
    PADDLE_HOME: nodeRuntime.path.join(runtimeRoot, "paddle_home"),
    PADDLEX_HOME: nodeRuntime.path.join(runtimeRoot, "paddlex_home"),
    XDG_CACHE_HOME: cacheRoot,
    HF_HOME: nodeRuntime.path.join(cacheRoot, "huggingface"),
  };
}

function isOcrRuntimeReady(pluginRoot, runtimeRoot, nodeRuntime) {
  const pluginReady = RUNTIME_BOOTSTRAP.requiredPluginPaths.every((segments) =>
    nodeRuntime.fs.existsSync(nodeRuntime.path.join(pluginRoot, ...segments))
  );
  const depsReady = RUNTIME_BOOTSTRAP.requiredDependencyPaths.every((segments) =>
    nodeRuntime.fs.existsSync(nodeRuntime.path.join(runtimeRoot, ...segments))
  );
  return pluginReady && depsReady;
}

function resolvePluginRoot(nodeRuntime) {
  const candidates = [];
  const href = String(window.location?.href || "");

  if (href.startsWith("file:")) {
    try {
      candidates.push(nodeRuntime.url.fileURLToPath(new URL(".", href)));
    } catch (error) {
      // ignore and continue with the fallback chain below
    }
  }

  const pathname = String(window.location?.pathname || "");
  if (pathname) {
    try {
      const decoded = decodeURIComponent(pathname);
      candidates.push(decoded.replace(/[\\/]index\.html?$/i, ""));
    } catch (error) {
      candidates.push(pathname.replace(/[\\/]index\.html?$/i, ""));
    }
  }

  const scriptSources = Array.from(document.scripts || [])
    .map((script) => String(script?.src || "").trim())
    .filter(Boolean);

  for (const source of scriptSources) {
    if (!/\/js\/plugin\.js(?:\?|#|$)/i.test(source)) {
      continue;
    }

    if (source.startsWith("file:")) {
      try {
        candidates.push(nodeRuntime.url.fileURLToPath(new URL("..", source)));
        continue;
      } catch (error) {
        // ignore and continue with string-based fallback
      }
    }

    try {
      const scriptUrl = new URL(source, href || undefined);
      const decodedPath = decodeURIComponent(scriptUrl.pathname || "");
      candidates.push(decodedPath.replace(/[\\/]js[\\/]plugin\.js$/i, ""));
    } catch (error) {
      candidates.push(source.replace(/[\\/]js[\\/]plugin\.js(?:\?.*)?$/i, ""));
    }
  }

  try {
    const cwd = nodeRuntime.process.cwd?.();
    if (cwd) {
      candidates.push(cwd);
    }
  } catch (error) {
    // ignore
  }

  for (const candidate of candidates) {
    if (isPluginRoot(candidate, nodeRuntime)) {
      return normalizeCandidatePath(candidate, nodeRuntime);
    }
  }

  const details = [href || "(empty href)", pathname || "(empty pathname)"].join(" | ");
  throw new Error(`无法解析插件目录路径。当前页面地址不是 file://，且无法从 Eagle 环境还原本地插件目录。${details}`);
}

function getBundledPythonInfo(nodeRuntime, runtimeRoot) {
  const suffixMap = {
    x64: "amd64",
    arm64: "arm64",
  };
  const archSuffix = suffixMap[nodeRuntime.process.arch];
  if (!archSuffix) {
    return null;
  }

  return {
    pythonDir: nodeRuntime.path.join(runtimeRoot, "python"),
    pythonExe: nodeRuntime.path.join(runtimeRoot, "python", "python.exe"),
    archiveName: `python-${RUNTIME_BOOTSTRAP.pythonVersion}-${archSuffix}.zip`,
    downloadUrl: `${RUNTIME_BOOTSTRAP.pythonBaseUrl}python-${RUNTIME_BOOTSTRAP.pythonVersion}-${archSuffix}.zip`,
  };
}

function extractPythonVersion(output) {
  const text = String(output || "").trim();
  const match = text.match(/Python\s+(\d+\.\d+\.\d+)/i);
  return match?.[1] || "";
}

function isSupportedPythonVersion(version) {
  return String(version || "").startsWith(`${RUNTIME_BOOTSTRAP.pythonSeries}.`);
}

function resolvePythonCommand(nodeRuntime, runtimeRoot) {
  const bundled = runtimeRoot ? getBundledPythonInfo(nodeRuntime, runtimeRoot) : null;
  if (bundled?.pythonExe && nodeRuntime.fs.existsSync(bundled.pythonExe)) {
    try {
      const bundledResult = nodeRuntime.childProcess.spawnSync(bundled.pythonExe, ["--version"], {
        encoding: "utf8",
        windowsHide: true,
      });
      const bundledVersion = extractPythonVersion(`${bundledResult.stdout || ""}\n${bundledResult.stderr || ""}`);
      if (bundledResult.status === 0 && isSupportedPythonVersion(bundledVersion)) {
        return { command: bundled.pythonExe, args: [], source: "bundled" };
      }
    } catch (error) {
      // fall through to system Python checks
    }
  }

  const candidates = [
    { command: "python", args: [], source: "system" },
    { command: "py", args: ["-3"], source: "py-launcher" },
  ];

  for (const candidate of candidates) {
    try {
      const result = nodeRuntime.childProcess.spawnSync(candidate.command, [...candidate.args, "--version"], {
        encoding: "utf8",
        windowsHide: true,
      });
      const version = extractPythonVersion(`${result.stdout || ""}\n${result.stderr || ""}`);
      if (result.status === 0 && isSupportedPythonVersion(version)) {
        return candidate;
      }
    } catch (error) {
      continue;
    }
  }

  return null;
}

async function ensureBundledPythonInstalled(nodeRuntime, runtimeRoot) {
  if (nodeRuntime.process.platform !== "win32") {
    throw new Error("当前系统未安装 Python，且该插件目前只支持在 Windows 上自动下载 Python 运行环境。");
  }

  const bundled = getBundledPythonInfo(nodeRuntime, runtimeRoot);
  if (!bundled) {
    throw new Error(`当前系统架构 ${nodeRuntime.process.arch} 暂不支持自动下载 Python 运行环境。`);
  }

  if (nodeRuntime.fs.existsSync(bundled.pythonExe)) {
    try {
      const versionResult = nodeRuntime.childProcess.spawnSync(bundled.pythonExe, ["--version"], {
        encoding: "utf8",
        windowsHide: true,
      });
      const bundledVersion = extractPythonVersion(`${versionResult.stdout || ""}\n${versionResult.stderr || ""}`);
      if (versionResult.status === 0 && isSupportedPythonVersion(bundledVersion)) {
        return { command: bundled.pythonExe, args: [], source: "bundled" };
      }
    } catch (error) {
      // If the existing bundled runtime is broken, reinstall it below.
    }
  }

  const downloadsDir = nodeRuntime.path.join(runtimeRoot, "downloads");
  const archivePath = nodeRuntime.path.join(downloadsDir, bundled.archiveName);
  const extractDir = bundled.pythonDir;

  await nodeRuntime.fs.promises.mkdir(downloadsDir, { recursive: true });

  setRuntimeState({
    runtimeStatus: "installing",
    runtimeTitle: "AI 本地 OCR 初始化",
    runtimeMessage: "正在准备 Python 运行环境，请稍候。",
    runtimeLogs: [],
  });

  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const script = [
    "$ErrorActionPreference='Stop'",
    `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`,
    `$zip='${archivePath.replace(/'/g, "''")}'`,
    `$extract='${extractDir.replace(/'/g, "''")}'`,
    `if (-not (Test-Path -LiteralPath $zip)) { Invoke-WebRequest -UseBasicParsing '${bundled.downloadUrl}' -OutFile $zip }`,
    `if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }`,
    `Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force`,
  ].join("; ");

  await runProcess(
    powershell,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      cwd: runtimeRoot,
      windowsHide: true,
      onStdoutLine() {},
      onStderrLine() {},
    },
    nodeRuntime
  );

  if (!nodeRuntime.fs.existsSync(bundled.pythonExe)) {
    throw new Error("Python 运行环境下载完成，但未找到 python.exe。");
  }

  setRuntimeState({
    runtimeStatus: "installing",
    runtimeTitle: "AI 本地 OCR 初始化",
    runtimeMessage: "正在初始化 Python 运行环境。",
  });

  await runProcess(
    bundled.pythonExe,
    ["-m", "ensurepip", "--upgrade"],
    {
      cwd: bundled.pythonDir,
      windowsHide: true,
      env: buildRuntimeEnv(nodeRuntime, runtimeRoot),
      onStdoutLine() {},
      onStderrLine() {},
    },
    nodeRuntime
  );

  return { command: bundled.pythonExe, args: [], source: "bundled" };
}

async function ensurePythonRuntime(nodeRuntime, runtimeRoot) {
  const resolved = resolvePythonCommand(nodeRuntime, runtimeRoot);
  if (resolved) {
    return resolved;
  }

  return ensureBundledPythonInstalled(nodeRuntime, runtimeRoot);
}

async function writeJsonFile(filePath, value, nodeRuntime) {
  await nodeRuntime.fs.promises.writeFile(filePath, JSON.stringify(value), "utf8");
}

async function readJsonFile(filePath, nodeRuntime) {
  const raw = await nodeRuntime.fs.promises.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function createTempJsonPath(nodeRuntime, pluginRoot, prefix) {
  return nodeRuntime.path.join(
    pluginRoot,
    "tmp",
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
}

function createLineStreamHandler(handler) {
  let buffer = "";

  return {
    push(chunk) {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          handler(trimmed);
        }
      }
    },
    flush() {
      const trimmed = buffer.trim();
      if (trimmed) {
        handler(trimmed);
      }
      buffer = "";
    },
  };
}

function runProcess(command, args, options, nodeRuntime) {
  return new Promise((resolve, reject) => {
    const { onStdoutLine, onStderrLine, ...spawnOptions } = options || {};
    const child = nodeRuntime.childProcess.spawn(command, args, spawnOptions);
    let stdout = "";
    let stderr = "";
    const stdoutLineHandler = createLineStreamHandler((line) => {
      onStdoutLine?.(line);
    });
    const stderrLineHandler = createLineStreamHandler((line) => {
      onStderrLine?.(line);
    });

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      stdoutLineHandler.push(chunk);
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      stderrLineHandler.push(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      stdoutLineHandler.flush();
      stderrLineHandler.flush();

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `本地 OCR 进程退出，状态码 ${code}`));
    });
  });
}

function parseInstallerLine(line) {
  try {
    return JSON.parse(line);
  } catch (error) {
    return null;
  }
}

async function refreshRuntimeStatus() {
  if (!window.eagle?.item?.getSelected) {
    setRuntimeState({
      runtimeStatus: "ready",
      runtimeTitle: "浏览器预览模式",
      runtimeMessage: "当前环境不会真的下载或运行本地 OCR 依赖。",
      runtimeLogs: [],
    });
    return;
  }

  try {
    const nodeRuntime = ensureNodeRuntime();
    const pluginRoot = resolvePluginRoot(nodeRuntime);
    const runtimeRoot = resolveRuntimeRoot(nodeRuntime);
    if (isOcrRuntimeReady(pluginRoot, runtimeRoot, nodeRuntime)) {
      setRuntimeState({
        runtimeStatus: "ready",
        runtimeTitle: "本地 OCR 已就绪",
        runtimeMessage: "可以直接开始识别，无需再次下载。",
        runtimeLogs: [],
      });
      return;
    }

    setRuntimeState({
      runtimeStatus: "pending",
      runtimeTitle: "AI 本地 OCR 初始化",
      runtimeMessage: "正在自动初始化本地 OCR 模型，首次启动通常需要几分钟。",
      runtimeLogs: [],
    });
  } catch (error) {
    setRuntimeState({
      runtimeStatus: "error",
      runtimeTitle: "本地 OCR 初始化失败",
      runtimeMessage: error?.message || String(error),
      runtimeLogs: [],
    });
  }
}

async function ensureRuntimeInstalled(nodeRuntime) {
  const pluginRoot = resolvePluginRoot(nodeRuntime);
  const runtimeRoot = resolveRuntimeRoot(nodeRuntime);
  if (isOcrRuntimeReady(pluginRoot, runtimeRoot, nodeRuntime)) {
    setRuntimeState({
      runtimeStatus: "ready",
      runtimeTitle: "本地 OCR 已就绪",
      runtimeMessage: "可以直接开始识别，无需再次下载。",
      runtimeLogs: [],
    });
    return;
  }

  if (state.runtimeInstallPromise) {
    return state.runtimeInstallPromise;
  }

  const installPromise = (async () => {
    const python = await ensurePythonRuntime(nodeRuntime, runtimeRoot);
    const bootstrapScript = nodeRuntime.path.join(pluginRoot, "python", "bootstrap_paddle_runtime.py");

    setRuntimeState({
      runtimeStatus: "installing",
      runtimeTitle: "AI 本地 OCR 初始化",
      runtimeMessage: "正在初始化本地 OCR 模型，请保持网络连接，完成后会自动进入操作界面。",
      runtimeLogs: [],
    });

    await nodeRuntime.fs.promises.mkdir(nodeRuntime.path.join(runtimeRoot, "python_deps"), { recursive: true });
    await nodeRuntime.fs.promises.mkdir(nodeRuntime.path.join(runtimeRoot, "cache"), { recursive: true });

    const runBootstrapInstall = async () => {
      await runProcess(
        python.command,
        [...python.args, bootstrapScript],
        {
          cwd: pluginRoot,
          windowsHide: true,
          env: buildRuntimeEnv(nodeRuntime, runtimeRoot),
          onStdoutLine(line) {
            const payload = parseInstallerLine(line);
            if (!payload) {
              appendRuntimeLog(line);
              return;
            }

            if (payload.type === "status") {
              setRuntimeState({
                runtimeStatus: "installing",
                runtimeTitle: "AI 本地 OCR 初始化",
                runtimeMessage: payload.message || state.runtimeMessage,
              });
              return;
            }

            if (payload.type === "log") {
              appendRuntimeLog(payload.message || "");
              return;
            }

            if (payload.type === "done") {
              setRuntimeState({
                runtimeStatus: "ready",
                runtimeTitle: "本地 OCR 已就绪",
                runtimeMessage: payload.message || "本地 OCR 依赖已准备完成。",
              });
              return;
            }

            if (payload.type === "error") {
              appendRuntimeLog(payload.message || "");
            }
          },
          onStderrLine(line) {
            appendRuntimeLog(line);
          },
        },
        nodeRuntime
      );

      if (!isOcrRuntimeReady(pluginRoot, runtimeRoot, nodeRuntime)) {
        throw new Error("依赖安装已完成，但本地 OCR 运行文件仍不完整。");
      }
    };

    let lastInstallError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        if (attempt > 1) {
          setRuntimeState({
            runtimeStatus: "installing",
            runtimeTitle: "AI 本地 OCR 初始化",
            runtimeMessage: "正在完成本地 OCR 初始化，请稍候。",
          });
          await delay(900);
        }

        await runBootstrapInstall();
        lastInstallError = null;
        break;
      } catch (error) {
        lastInstallError = error;
      }
    }

    if (lastInstallError) {
      throw lastInstallError;
    }

    setRuntimeState({
      runtimeStatus: "ready",
      runtimeTitle: "本地 OCR 已就绪",
      runtimeMessage: "依赖已下载完成，后续识别可直接使用。",
    });
  })();

  state.runtimeInstallPromise = installPromise;

  try {
    await installPromise;
  } catch (error) {
    setRuntimeState({
      runtimeStatus: "error",
      runtimeTitle: "本地 OCR 初始化失败",
      runtimeMessage: error?.message || String(error),
    });
    throw error;
  } finally {
    state.runtimeInstallPromise = null;
    updateActionState();
  }
}

async function runPaddleOcrBatch(entries, settings, nodeRuntime) {
  const pluginRoot = resolvePluginRoot(nodeRuntime);
  const runtimeRoot = resolveRuntimeRoot(nodeRuntime);
  const scriptPath = nodeRuntime.path.join(pluginRoot, "python", "paddle_ocr_runner.py");
  const requestPath = createTempJsonPath(nodeRuntime, pluginRoot, "paddleocr-request");
  const responsePath = createTempJsonPath(nodeRuntime, pluginRoot, "paddleocr-response");
  const python = await ensurePythonRuntime(nodeRuntime, runtimeRoot);

  await nodeRuntime.fs.promises.mkdir(nodeRuntime.path.join(pluginRoot, "tmp"), { recursive: true });
  await writeJsonFile(
    requestPath,
    {
      language: settings.language,
      items: entries.map((entry) => ({
        id: entry.item?.id,
        path: entry.item?.filePath || "",
      })),
    },
    nodeRuntime
  );

  try {
    await runProcess(
      python.command,
      [...python.args, scriptPath, "--input", requestPath, "--output", responsePath],
      {
        cwd: pluginRoot,
        windowsHide: true,
        env: buildRuntimeEnv(nodeRuntime, runtimeRoot),
      },
      nodeRuntime
    );

    const payload = await readJsonFile(responsePath, nodeRuntime);
    if (!payload?.ok) {
      throw new Error(payload?.error || "本地 PaddleOCR 返回了失败结果。");
    }

    return payload;
  } finally {
    await Promise.allSettled([
      nodeRuntime.fs.promises.unlink(requestPath),
      nodeRuntime.fs.promises.unlink(responsePath),
    ]);
  }
}

function resolveSourceUrl(item, nodeRuntime) {
  if (item.fileURL) {
    return item.fileURL;
  }

  if (item.filePath) {
    return nodeRuntime.url.pathToFileURL(item.filePath).href;
  }

  return "";
}

async function loadSourceInput(item, nodeRuntime) {
  if (item.filePath) {
    const fileBytes = await nodeRuntime.fs.promises.readFile(item.filePath);
    return new Blob([fileBytes]);
  }

  const sourceUrl = resolveSourceUrl(item, nodeRuntime);
  if (!sourceUrl) {
    throw new Error("缺少原图路径");
  }

  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`读取原图失败（${response.status}）`);
  }

  return response.blob();
}

async function recognizeText(entry, settings, worker, nodeRuntime) {
  const sourceInput = await loadSourceInput(entry.item, nodeRuntime);
  const sourceBitmap = await createImageBitmap(sourceInput);

  try {
    const jobs = buildRecognitionJobs(sourceBitmap);
    const candidates = [];

    for (const job of jobs) {
      await worker.setParameters(buildRecognitionParameters(job, settings));

      const result = job.rectangle
        ? await worker.recognize(sourceInput, { rectangle: job.rectangle })
        : await worker.recognize(prepareRecognitionCanvas(job.canvas, job.threshold));
      const text = normalizeRecognizedText(result?.data?.text || "", settings.trimText, settings.language);
      const confidence = Number.isFinite(result?.data?.confidence) ? Math.round(result.data.confidence) : null;

      candidates.push({
        name: job.name,
        text,
        confidence,
      });
    }

    return mergeRecognitionCandidates(candidates, settings);
  } finally {
    sourceBitmap.close?.();
  }
}

async function resolveWorkingItem(item) {
  if (typeof item?.save === "function") {
    return item;
  }

  const result = await window.eagle?.item?.get?.({ id: item.id });
  return Array.isArray(result) ? result[0] : result;
}

function buildNextAnnotation(existingAnnotation, recognizedText, writeMode) {
  const current = String(existingAnnotation || "").trim();
  const next = String(recognizedText || "").trim();

  if (writeMode === "overwrite") {
    return next;
  }

  if (writeMode === "empty_only") {
    return current || next;
  }

  if (!current) {
    return next;
  }

  if (!next) {
    return current;
  }

  return `${current}\n\n${next}`;
}

function buildNextName(existingName, recognizedText, writeMode, extension) {
  const current = stripKnownExtension(existingName, extension);
  const next = sanitizeFileNameText(recognizedText);

  if (!next) {
    return current;
  }

  if (writeMode === "name_overwrite") {
    return next;
  }

  if (!current) {
    return next;
  }

  return `${current} ${next}`.trim();
}

async function writeResult(entry, recognizedText, settings) {
  const workingItem = await resolveWorkingItem(entry.item);
  if (!workingItem || typeof workingItem.save !== "function") {
    throw new Error("当前项目不支持保存内容。");
  }

  if (settings.writeMode === "name_overwrite" || settings.writeMode === "name_append") {
    const extension = normalizeExtension(workingItem) || normalizeExtension(entry.item);
    const nextName = buildNextName(workingItem.name, recognizedText, settings.writeMode, extension);
    if (!nextName) {
      throw new Error("识别结果无法转换为有效文件名。");
    }
    workingItem.name = nextName;
    await workingItem.save();
    return;
  }

  const nextAnnotation = buildNextAnnotation(workingItem.annotation, recognizedText, settings.writeMode);
  workingItem.annotation = nextAnnotation;
  await workingItem.save();
}

async function handleRun() {
  let settings = null;
  try {
    settings = readSettings();
  } catch (error) {
    derivePlan();
    showNotice(error?.message || String(error), {
      title: "参数错误",
      variant: "error",
    });
    return;
  }

  const readyEntries = state.plan.filter((entry) => entry.status === "ready");
  if (!readyEntries.length) {
    showNotice("当前没有可处理的图片。请先选择图片，并确认写入方式允许这些项目写入结果。", {
      title: "没有可处理项",
      variant: "info",
    });
    return;
  }

  let doneCount = 0;
  let skippedNoTextCount = 0;
  let errorCount = 0;
  state.busy = true;
  updateActionState();

  try {
    const nodeRuntime = ensureNodeRuntime();
    await ensureRuntimeInstalled(nodeRuntime);

    for (const entry of readyEntries) {
      updatePlanEntry(entry.item.id, {
        status: "processing",
        message: `正在识别 | PaddleOCR | ${getLanguageLabel(settings.language)}`,
        recognizedText: "",
        recognizedPreview: "",
        confidence: null,
      });
    }
    renderSelectionList();

    const batchResult = await runPaddleOcrBatch(readyEntries, settings, nodeRuntime);
    const resultMap = new Map((batchResult?.items || []).map((item) => [String(item?.id || ""), item]));

    for (const entry of readyEntries) {
      const paddleResult = resultMap.get(String(entry.item?.id || ""));
      if (!paddleResult) {
        errorCount += 1;
        updatePlanEntry(entry.item.id, {
          status: "error",
          message: "本地 PaddleOCR 没有返回该图片的识别结果",
          recognizedText: "",
          recognizedPreview: "",
          confidence: null,
        });
        continue;
      }

      if (!paddleResult.ok) {
        errorCount += 1;
        updatePlanEntry(entry.item.id, {
          status: "error",
          message: `处理失败：${paddleResult.error || "本地 OCR 失败"}`,
          recognizedText: "",
          recognizedPreview: "",
          confidence: null,
        });
        continue;
      }

      const recognizedText = normalizeRecognizedText(paddleResult.text || "", settings.trimText, settings.language);
      const recognized = {
        text: recognizedText,
        confidence: Number.isFinite(paddleResult.averageScore) ? Math.round(paddleResult.averageScore) : null,
      };

      if (!recognized.text) {
        skippedNoTextCount += 1;
        updatePlanEntry(entry.item.id, {
          status: "skip",
          message: "未识别到文字",
          recognizedText: "",
          recognizedPreview: "",
          confidence: recognized.confidence,
        });
        continue;
      }

      try {
        await writeResult(entry, recognized.text, settings);
        doneCount += 1;
        updatePlanEntry(entry.item.id, {
          status: "done",
          message: "",
          recognizedText: recognized.text,
          recognizedPreview: createPreview(recognized.text),
          confidence: recognized.confidence,
        });
      } catch (error) {
        errorCount += 1;
        updatePlanEntry(entry.item.id, {
          status: "error",
          message: `处理失败：${error?.message || error}`,
          recognizedText: recognized.text,
          recognizedPreview: createPreview(recognized.text),
          confidence: recognized.confidence,
        });
      }
    }

    renderSelectionList();

    const resultLines = [`已成功写入 ${doneCount} 张图片的结果。`];
    if (skippedNoTextCount > 0) {
      resultLines.push(`跳过 ${skippedNoTextCount} 张未识别到文字的图片。`);
    }
    if (errorCount > 0) {
      resultLines.push(`失败 ${errorCount} 张。`);
    }
    await showNotice(resultLines.join("\n"), {
      title: "识别完成！",
      variant: "success",
    });
  } catch (error) {
    await showNotice(`执行失败：${error?.message || error}`, {
      title: "执行失败",
      variant: "error",
    });
  } finally {
    state.busy = false;
    updateActionState();
  }
}

function bindEvents() {
  getEl("refreshSelectionButton")?.addEventListener("click", () => {
    readSelectedItems();
  });

  getEl("runButton")?.addEventListener("click", () => {
    handleRun();
  });

  ["ocrLanguageSelect", "writeModeSelect", "trimTextCheckbox"].forEach((id) => {
    getEl(id)?.addEventListener("change", () => {
      derivePlan();
    });
  });

  getEl("dialogConfirmButton")?.addEventListener("click", () => {
    closeDialog(true);
  });

  getEl("dialogCancelButton")?.addEventListener("click", () => {
    closeDialog(false);
  });

  getEl("dialogBackdrop")?.addEventListener("click", () => {
    if (state.dialogCancellable) {
      closeDialog(false);
      return;
    }
    closeDialog(true);
  });

  getEl("bootstrapCloseButton")?.addEventListener("click", () => {
    if (typeof window.close === "function") {
      window.close();
    }
  });

  getEl("bootstrapRetryButton")?.addEventListener("click", async () => {
    if (state.runtimeStatus === "installing") {
      return;
    }

    try {
      const nodeRuntime = ensureNodeRuntime();
      await ensureRuntimeInstalled(nodeRuntime);
      await refreshSelectionWithRetry([0, 120, 320, 640]);
    } catch (error) {
      // ensureRuntimeInstalled already updates the bootstrap state
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!isDialogOpen()) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog(state.dialogCancellable ? false : true);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      closeDialog(true);
    }
  });
}

async function initializeRuntimeAndSelection() {
  await refreshRuntimeStatus();

  if (!window.eagle?.item?.getSelected) {
    await readSelectedItems();
    return;
  }

  if (state.runtimeStatus !== "ready") {
    try {
      const nodeRuntime = ensureNodeRuntime();
      await ensureRuntimeInstalled(nodeRuntime);
    } catch (error) {
      return;
    }
  }

  renderRuntimeCard();
  await refreshSelectionWithRetry([0, 120, 320, 640, 900]);
}

function registerEagleEvents() {
  if (!window.eagle) {
    return;
  }

  window.eagle.onPluginCreate(async () => {
    if (state.runtimeStatus !== "ready") {
      return;
    }
    await refreshSelectionWithRetry([0, 120, 320, 640]);
  });

  window.eagle.onPluginRun(async () => {
    if (state.runtimeStatus !== "ready") {
      return;
    }
    await refreshSelectionWithRetry([0, 120, 320]);
  });

  window.eagle.onPluginShow(async () => {
    if (state.runtimeStatus !== "ready") {
      return;
    }
    if (!state.selectedItems.length) {
      await refreshSelectionWithRetry([0, 120, 320, 640, 900]);
      return;
    }
    const elapsed = Date.now() - state.lastSelectionRefreshAt;
    if (elapsed < 150) {
      return;
    }
    await refreshSelectionWithRetry([0, 120, 320]);
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  renderSelectionList();
  updateActionState();

  if (window.eagle) {
    registerEagleEvents();
  }

  await initializeRuntimeAndSelection();
});
