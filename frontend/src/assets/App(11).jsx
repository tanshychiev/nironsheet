import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Rnd } from "react-rnd";
import { createPortal } from "react-dom";

const MIN_ITEM_CM = 0.2;
const PASTEBOARD_PADDING_CM = 10;
const MIN_PASTEBOARD_PADDING_PX = 220;
const MAX_PASTEBOARD_PADDING_PX = 1600;
const MIN_SHEET_ZOOM = 0.05;
const MAX_SHEET_ZOOM = 500.00;
const SHEET_ZOOM_FACTOR = 1.25;

function numberValue(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function apiConfig() {
  return window.NIRON_API || {};
}

function isTypingTarget(target) {
  if (!target) return false;
  const tagName = String(target.tagName || "").toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    target.isContentEditable
  );
}

function cacheBustUrl(url, token) {
  if (!url) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}v=${token}`;
}

function normalizedSize(item) {
  const quarterTurn = Number(item.rotation || 0) % 180 !== 0;
  return quarterTurn
    ? { width: item.height_cm, height: item.width_cm }
    : { width: item.width_cm, height: item.height_cm };
}

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

function getPointerOnCanvas(event, canvas, zoom = 1) {
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
  return {
    x: clamp(x, 0, canvas.width),
    y: clamp(y, 0, canvas.height),
    viewX: event.clientX - rect.left,
    viewY: event.clientY - rect.top,
  };
}

function pathToSvg(points) {
  if (!points.length) return "";
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ") + " Z";
}

function ensureOffscreenCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function isImageFile(file) {
  return !!file && typeof file.type === "string" && file.type.startsWith("image/");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load image: ${url}`));
    image.src = url;
  });
}

function drawContainImage(ctx, image, boxWidth, boxHeight) {
  if (!image || boxWidth <= 0 || boxHeight <= 0) return;

  const scale = Math.min(
    boxWidth / Math.max(image.naturalWidth || image.width || 1, 1),
    boxHeight / Math.max(image.naturalHeight || image.height || 1, 1),
  );

  const drawWidth = (image.naturalWidth || image.width) * scale;
  const drawHeight = (image.naturalHeight || image.height) * scale;
  const offsetX = (boxWidth - drawWidth) / 2;
  const offsetY = (boxHeight - drawHeight) / 2;

  ctx.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
}

export default function App() {
  const api = apiConfig();
  const [sheet, setSheet] = useState(null);
  const [items, setItems] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [marqueeRect, setMarqueeRect] = useState(null);
  const [sheetWidthDraft, setSheetWidthDraft] = useState("58");
  const [sheetHeightDraft, setSheetHeightDraft] = useState("30");
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [allowRotate, setAllowRotate] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [exportDpi, setExportDpi] = useState(150);
  const [metrics, setMetrics] = useState(null);
  const [activeMainTool, setActiveMainTool] = useState("move");
  const [isCanvasPanning, setIsCanvasPanning] = useState(false);
  const [spacePanActive, setSpacePanActive] = useState(false);
  const [historyStack, setHistoryStack] = useState([]);
  const [clipboardItem, setClipboardItem] = useState(null);
  const [isDragImportActive, setIsDragImportActive] = useState(false);
  const [sheetColor, setSheetColor] = useState("#fffdf8");
  const [taskProgress, setTaskProgress] = useState(null);
  const [sheetResizePreview, setSheetResizePreview] = useState(null);
  const [newSheetOpen, setNewSheetOpen] = useState(false);
  const [newSheetDraft, setNewSheetDraft] = useState({
    name: "New Print Sheet",
    width_cm: "58",
    height_cm: "100",
    spacing_cm: "0.20",
    margin_cm: "0.20",
  });
  const [expandedLayerGroups, setExpandedLayerGroups] = useState({});
  const fileInputRef = useRef(null);
  const fileDragCounterRef = useRef(0);
  const taskProgressTimerRef = useRef(null);
  const sheetResizeRef = useRef(null);
  const canvasScrollRef = useRef(null);
  const printSheetRef = useRef(null);
  const marqueeStartRef = useRef(null);
  const groupDragRef = useRef(null);
  const spacePanRef = useRef(false);
  const panSessionRef = useRef(null);

  const selectedIdSet = useMemo(
    () => new Set(selectedIds.map((id) => String(id))),
    [selectedIds],
  );

  const selectedItems = useMemo(
    () => items.filter((item) => selectedIdSet.has(String(item.id))),
    [items, selectedIdSet],
  );

  const selectionCount = selectedItems.length;

  const selected = useMemo(
    () =>
      items.find((item) => String(item.id) === String(selectedId)) ||
      selectedItems[0] ||
      null,
    [items, selectedId, selectedItems],
  );

  const layerGroups = useMemo(() => {
    const groups = new Map();

    for (const item of items) {
      const size = normalizedSize(item);
      const key = `${item.asset_id}|${item.use_processed ? "p" : "o"}|${item.use_upscaled ? "u" : "n"}|${round2(size.width)}|${round2(size.height)}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          assetId: item.asset_id,
          name: item.name || `Artwork ${item.asset_id}`,
          ids: [],
          items: [],
        });
      }
      const group = groups.get(key);
      group.ids.push(item.id);
      group.items.push(item);
    }

    return Array.from(groups.values()).sort((a, b) => {
      if (b.items.length !== a.items.length) return b.items.length - a.items.length;
      return String(a.name).localeCompare(String(b.name));
    });
  }, [items]);

  const matchingQuantity = useMemo(() => {
    if (!selected) return 1;
    const selectedSize = normalizedSize(selected);
    return items.filter((item) => {
      const itemSize = normalizedSize(item);
      return (
        item.asset_id === selected.asset_id &&
        Math.abs(itemSize.width - selectedSize.width) < 0.01 &&
        Math.abs(itemSize.height - selectedSize.height) < 0.01 &&
        item.use_processed === selected.use_processed &&
        item.use_upscaled === selected.use_upscaled
      );
    }).length;
  }, [items, selected]);

  useEffect(() => {
    setQuantity(matchingQuantity || 1);
  }, [matchingQuantity, selectedId]);

  const loadSheet = useCallback(async (keepSelection = true) => {
    if (!api.detail) return;
    try {
      const data = await readJson(await fetch(api.detail));
      const cacheToken = Date.now();
      const loaded = (data.items || []).map((item) => ({
        ...item,
        x_cm: numberValue(item.x_cm),
        y_cm: numberValue(item.y_cm),
        width_cm: numberValue(item.width_cm, 5),
        height_cm: numberValue(item.height_cm, 5),
        rotation: Number.parseInt(item.rotation || 0, 10) % 360,
        image_url: cacheBustUrl(item.image_url, cacheToken),
        original_url: cacheBustUrl(item.original_url, cacheToken),
        processed_url: cacheBustUrl(item.processed_url, cacheToken),
        upscaled_url: cacheBustUrl(item.upscaled_url, cacheToken),
      }));

      const loadedSheet = {
        ...data.sheet,
        width_cm: numberValue(data.sheet?.width_cm, 58),
        height_cm: numberValue(data.sheet?.height_cm, 30),
        spacing_cm: numberValue(data.sheet?.spacing_cm, 0.2),
        margin_cm: numberValue(data.sheet?.margin_cm, 0.2),
      };

      setSheet(loadedSheet);
      setSheetWidthDraft(String(loadedSheet.width_cm));
      setSheetHeightDraft(String(loadedSheet.height_cm));
      setItems(loaded);

      const validIds = new Set(loaded.map((item) => String(item.id)));

      setSelectedIds((current) => {
        const next = keepSelection
          ? current.filter((id) => validIds.has(String(id)))
          : loaded[0]
            ? [loaded[0].id]
            : [];

        setSelectedId((currentPrimary) => {
          if (
            currentPrimary != null &&
            next.some((id) => String(id) === String(currentPrimary))
          ) {
            return currentPrimary;
          }
          return next[next.length - 1] ?? null;
        });

        return next;
      });
    } catch (error) {
      setMessage(error.message || "Could not load the sheet.");
    }
  }, [api.detail]);

  useEffect(() => {
    loadSheet(false);
  }, [loadSheet]);

  function startTaskProgress(label) {
    if (taskProgressTimerRef.current) {
      window.clearInterval(taskProgressTimerRef.current);
    }

    setTaskProgress({ label, value: 0 });

    taskProgressTimerRef.current = window.setInterval(() => {
      setTaskProgress((current) => {
        if (!current) return current;
        const next = current.value < 75
          ? current.value + 5
          : current.value < 90
            ? current.value + 2
            : current.value < 96
              ? current.value + 1
              : current.value;
        return { ...current, value: Math.min(next, 96) };
      });
    }, 120);
  }

  function finishTaskProgress(doneLabel) {
    if (taskProgressTimerRef.current) {
      window.clearInterval(taskProgressTimerRef.current);
      taskProgressTimerRef.current = null;
    }

    setTaskProgress((current) =>
      current ? { ...current, label: doneLabel || current.label, value: 100 } : null,
    );

    window.setTimeout(() => {
      setTaskProgress(null);
    }, 450);
  }

  useEffect(() => {
    return () => {
      if (taskProgressTimerRef.current) {
        window.clearInterval(taskProgressTimerRef.current);
      }
    };
  }, []);

  const uploadIncomingFiles = useCallback(
    async (incomingFiles, sourceLabel = "artwork") => {
      const files = Array.from(incomingFiles || []).filter(isImageFile);

      if (!files.length) {
        setMessage("Please drop, paste, or choose image files only.");
        return;
      }

      setBusy(true);
      setMessage(`Uploading ${files.length} ${sourceLabel} file(s)...`);

      try {
        for (const file of files) {
          const form = new FormData();
          form.append("file", file);
          await readJson(await fetch(api.upload, { method: "POST", body: form }));
        }

        if (fileInputRef.current) fileInputRef.current.value = "";
        await loadSheet(false);
        setMessage(
          files.length === 1
            ? `${sourceLabel} imported.`
            : `${files.length} ${sourceLabel} files imported.`,
        );
      } catch (error) {
        setMessage(error.message || "Upload failed.");
      } finally {
        setBusy(false);
      }
    },
    [api.upload, loadSheet],
  );

  const cmToPx = 15 * zoom;
  const sheetWidthCm = Math.max(sheetResizePreview?.widthCm ?? sheet?.width_cm ?? 58, 1);
  const sheetHeightCm = Math.max(sheetResizePreview?.heightCm ?? sheet?.height_cm ?? 30, 1);
  const sheetWidthPx = Math.max(sheetWidthCm * cmToPx, 1);
  const sheetHeightPx = Math.max(sheetHeightCm * cmToPx, 1);
  const pasteboardPaddingPx = clamp(
    PASTEBOARD_PADDING_CM * cmToPx,
    MIN_PASTEBOARD_PADDING_PX,
    MAX_PASTEBOARD_PADDING_PX,
  );
  const sheetOriginX = pasteboardPaddingPx;
  const sheetOriginY = pasteboardPaddingPx;
  const pasteboardWidthPx =
    sheetWidthPx + pasteboardPaddingPx * 2;
  const pasteboardHeightPx =
    sheetHeightPx + pasteboardPaddingPx * 2;

  const artworkBounds = useMemo(() => {
    if (!items.length) {
      return {
        minX: 0,
        minY: 0,
        maxX: sheetWidthCm,
        maxY: sheetHeightCm,
      };
    }

    return items.reduce(
      (bounds, item) => ({
        minX: Math.min(bounds.minX, item.x_cm),
        minY: Math.min(bounds.minY, item.y_cm),
        maxX: Math.max(bounds.maxX, item.x_cm + item.width_cm),
        maxY: Math.max(bounds.maxY, item.y_cm + item.height_cm),
      }),
      {
        minX: 0,
        minY: 0,
        maxX: sheetWidthCm,
        maxY: sheetHeightCm,
      },
    );
  }, [items, sheetWidthCm, sheetHeightCm]);

  const setSheetZoom = useCallback(
    (requestedZoom, anchor = null) => {
      const nextZoom = clamp(
        Math.round(requestedZoom * 1000) / 1000,
        MIN_SHEET_ZOOM,
        MAX_SHEET_ZOOM,
      );

      if (Math.abs(nextZoom - zoom) < 0.0001) return;

      const scroller = canvasScrollRef.current;
      let viewportX = 0;
      let viewportY = 0;
      let logicalX = 0;
      let logicalY = 0;

      if (scroller) {
        const rect = scroller.getBoundingClientRect();

        viewportX =
          anchor && Number.isFinite(anchor.clientX)
            ? clamp(anchor.clientX - rect.left, 0, rect.width)
            : rect.width / 2;

        viewportY =
          anchor && Number.isFinite(anchor.clientY)
            ? clamp(anchor.clientY - rect.top, 0, rect.height)
            : rect.height / 2;

        logicalX =
          (scroller.scrollLeft + viewportX) / Math.max(zoom, 0.001);
        logicalY =
          (scroller.scrollTop + viewportY) / Math.max(zoom, 0.001);
      }

      setZoom(nextZoom);

      if (scroller) {
        window.requestAnimationFrame(() => {
          scroller.scrollLeft = Math.max(
            0,
            logicalX * nextZoom - viewportX,
          );
          scroller.scrollTop = Math.max(
            0,
            logicalY * nextZoom - viewportY,
          );
        });
      }
    },
    [zoom],
  );

  const zoomSheetIn = useCallback(
    (anchor = null) => {
      setSheetZoom(zoom * SHEET_ZOOM_FACTOR, anchor);
    },
    [setSheetZoom, zoom],
  );

  const zoomSheetOut = useCallback(
    (anchor = null) => {
      setSheetZoom(zoom / SHEET_ZOOM_FACTOR, anchor);
    },
    [setSheetZoom, zoom],
  );

  const resetSheetZoom = useCallback(() => {
    setSheetZoom(1);
  }, [setSheetZoom]);

  const panCanvasBy = useCallback((left, top) => {
    const scroller = canvasScrollRef.current;
    if (!scroller) return;

    scroller.scrollBy({
      left,
      top,
      behavior: "auto",
    });
  }, []);

  const centerElementInCanvas = useCallback((element) => {
    const scroller = canvasScrollRef.current;
    if (!scroller || !element) return;

    scroller.scrollLeft = Math.max(
      0,
      element.offsetLeft +
        element.offsetWidth / 2 -
        scroller.clientWidth / 2,
    );

    scroller.scrollTop = Math.max(
      0,
      element.offsetTop +
        element.offsetHeight / 2 -
        scroller.clientHeight / 2,
    );
  }, []);

  const fitSheetToViewport = useCallback(() => {
    const scroller = canvasScrollRef.current;
    if (!scroller) return;

    const availableWidth = Math.max(scroller.clientWidth - 120, 120);
    const availableHeight = Math.max(scroller.clientHeight - 120, 120);

    const nextZoom = clamp(
      Math.min(
        availableWidth / Math.max(sheetWidthCm * 15, 1),
        availableHeight / Math.max(sheetHeightCm * 15, 1),
      ),
      MIN_SHEET_ZOOM,
      MAX_SHEET_ZOOM,
    );

    setSheetZoom(nextZoom);

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const sheetElement =
          canvasScrollRef.current?.querySelector(".print-sheet");
        centerElementInCanvas(sheetElement);
      });
    });

    setMessage(`Fit sheet: ${Math.round(nextZoom * 100)}%.`);
  }, [
    centerElementInCanvas,
    setSheetZoom,
    sheetHeightCm,
    sheetWidthCm,
  ]);

  const fitSelectionToViewport = useCallback(() => {
    if (!selectionCount) {
      setMessage("Select one or more artwork layers first.");
      return;
    }

    const scroller = canvasScrollRef.current;
    if (!scroller) return;

    const minX = Math.min(...selectedItems.map((item) => item.x_cm));
    const minY = Math.min(...selectedItems.map((item) => item.y_cm));
    const maxX = Math.max(
      ...selectedItems.map((item) => item.x_cm + item.width_cm),
    );
    const maxY = Math.max(
      ...selectedItems.map((item) => item.y_cm + item.height_cm),
    );

    const widthCm = Math.max(maxX - minX, MIN_ITEM_CM);
    const heightCm = Math.max(maxY - minY, MIN_ITEM_CM);
    const availableWidth = Math.max(scroller.clientWidth - 140, 120);
    const availableHeight = Math.max(scroller.clientHeight - 140, 120);

    const nextZoom = clamp(
      Math.min(
        availableWidth / Math.max(widthCm * 15, 1),
        availableHeight / Math.max(heightCm * 15, 1),
      ),
      MIN_SHEET_ZOOM,
      MAX_SHEET_ZOOM,
    );

    setSheetZoom(nextZoom);

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const selectedElements = Array.from(
          canvasScrollRef.current?.querySelectorAll(
            ".sheet-item.multi-selected",
          ) || [],
        );

        if (!selectedElements.length) return;

        const left = Math.min(
          ...selectedElements.map((element) => element.offsetLeft),
        );
        const top = Math.min(
          ...selectedElements.map((element) => element.offsetTop),
        );
        const right = Math.max(
          ...selectedElements.map(
            (element) => element.offsetLeft + element.offsetWidth,
          ),
        );
        const bottom = Math.max(
          ...selectedElements.map(
            (element) => element.offsetTop + element.offsetHeight,
          ),
        );

        const currentScroller = canvasScrollRef.current;
        if (!currentScroller) return;

        currentScroller.scrollLeft = Math.max(
          0,
          (left + right) / 2 - currentScroller.clientWidth / 2,
        );
        currentScroller.scrollTop = Math.max(
          0,
          (top + bottom) / 2 - currentScroller.clientHeight / 2,
        );
      });
    });

    setMessage(`Fit selection: ${Math.round(nextZoom * 100)}%.`);
  }, [
    selectedItems,
    selectionCount,
    setSheetZoom,
  ]);

  function beginCanvasPan(event) {
    const scroller = canvasScrollRef.current;
    if (!scroller) return;

    const shouldPan =
      event.button === 1 ||
      activeMainTool === "hand" ||
      spacePanRef.current;

    if (!shouldPan) return;

    event.preventDefault();
    event.stopPropagation();

    panSessionRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: scroller.scrollLeft,
      scrollTop: scroller.scrollTop,
    };

    setIsCanvasPanning(true);

    function handleMove(moveEvent) {
      const session = panSessionRef.current;
      if (!session) return;

      scroller.scrollLeft =
        session.scrollLeft - (moveEvent.clientX - session.startX);
      scroller.scrollTop =
        session.scrollTop - (moveEvent.clientY - session.startY);
    }

    function handleUp() {
      panSessionRef.current = null;
      setIsCanvasPanning(false);
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    }

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  }

  useEffect(() => {
    const scroller = canvasScrollRef.current;
    if (!scroller) return undefined;

    function handleCanvasWheel(event) {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();

        const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;

        setSheetZoom(zoom * factor, {
          clientX: event.clientX,
          clientY: event.clientY,
        });

        return;
      }

      event.preventDefault();

      if (event.shiftKey || event.altKey) {
        const horizontalDelta =
          Math.abs(event.deltaX) > Math.abs(event.deltaY)
            ? event.deltaX
            : event.deltaY;

        scroller.scrollLeft += horizontalDelta;
        return;
      }

      scroller.scrollTop += event.deltaY;

      if (Math.abs(event.deltaX) > 0.5) {
        scroller.scrollLeft += event.deltaX;
      }
    }

    scroller.addEventListener("wheel", handleCanvasWheel, {
      passive: false,
    });

    return () => {
      scroller.removeEventListener("wheel", handleCanvasWheel);
    };
  }, [setSheetZoom, zoom]);

  useEffect(() => {
    function handlePasteImport(event) {
      if (isTypingTarget(event.target)) return;

      const clipboardFiles = Array.from(event.clipboardData?.items || [])
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter(isImageFile);

      if (!clipboardFiles.length) return;

      event.preventDefault();
      uploadIncomingFiles(clipboardFiles, "pasted artwork");
    }

    window.addEventListener("paste", handlePasteImport);
    return () => window.removeEventListener("paste", handlePasteImport);
  }, [uploadIncomingFiles]);

  useEffect(() => {
    function isImageDragEvent(event) {
      const types = Array.from(event.dataTransfer?.types || []);
      return types.includes("Files");
    }

    function handleDragEnter(event) {
      if (!isImageDragEvent(event)) return;
      event.preventDefault();
      fileDragCounterRef.current += 1;
      setIsDragImportActive(true);
    }

    function handleDragOver(event) {
      if (!isImageDragEvent(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setIsDragImportActive(true);
    }

    function handleDragLeave(event) {
      if (!isImageDragEvent(event)) return;
      event.preventDefault();
      fileDragCounterRef.current = Math.max(0, fileDragCounterRef.current - 1);
      if (fileDragCounterRef.current === 0) {
        setIsDragImportActive(false);
      }
    }

    function handleDropImport(event) {
      if (!isImageDragEvent(event)) return;
      event.preventDefault();
      fileDragCounterRef.current = 0;
      setIsDragImportActive(false);
      const droppedFiles = Array.from(event.dataTransfer?.files || []).filter(isImageFile);
      if (droppedFiles.length) {
        uploadIncomingFiles(droppedFiles, "dropped artwork");
      }
    }

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDropImport);

    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDropImport);
    };
  }, [uploadIncomingFiles]);

  useEffect(() => {
    function handleSpaceDown(event) {
      if (
        event.code !== "Space" ||
        isTypingTarget(event.target)
      ) {
        return;
      }

      event.preventDefault();
      spacePanRef.current = true;
      setSpacePanActive(true);
    }

    function handleSpaceUp(event) {
      if (event.code !== "Space") return;
      spacePanRef.current = false;
      setSpacePanActive(false);
    }

    window.addEventListener("keydown", handleSpaceDown);
    window.addEventListener("keyup", handleSpaceUp);

    return () => {
      window.removeEventListener("keydown", handleSpaceDown);
      window.removeEventListener("keyup", handleSpaceUp);
    };
  }, []);


  function updateNewSheetDraft(field, value) {
    setNewSheetDraft((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function openNewSheetDialog() {
    setNewSheetDraft({
      name: "New Print Sheet",
      width_cm: String(sheet?.width_cm || 58),
      height_cm: "100",
      spacing_cm: String(sheet?.spacing_cm || 0.2),
      margin_cm: String(sheet?.margin_cm || 0.2),
    });
    setNewSheetOpen(true);
  }

  function closeNewSheetDialog() {
    if (busy) return;
    setNewSheetOpen(false);
  }

  function createAndOpenNewSheet() {
    const name = String(newSheetDraft.name || "").trim();
    const width = numberValue(newSheetDraft.width_cm, 0);
    const height = numberValue(newSheetDraft.height_cm, 0);
    const spacing = Math.max(0, numberValue(newSheetDraft.spacing_cm, 0.2));
    const margin = Math.max(0, numberValue(newSheetDraft.margin_cm, 0.2));

    if (!name) {
      setMessage("Enter a name for the new sheet.");
      return;
    }

    if (width <= 0 || height <= 0) {
      setMessage("Sheet width and height must be greater than zero.");
      return;
    }

    if (margin * 2 >= width) {
      setMessage("The left and right margins are too large for this width.");
      return;
    }

    if (!api.createSheet) {
      setMessage("New Sheet URL is missing from builder_react.html.");
      return;
    }

    const form = document.createElement("form");
    form.method = "POST";
    form.action = api.createSheet;
    form.style.display = "none";

    const values = {
      csrfmiddlewaretoken: api.csrfToken || "",
      name,
      width_cm: String(width),
      height_cm: String(height),
      spacing_cm: String(spacing),
      margin_cm: String(margin),
    };

    for (const [key, value] of Object.entries(values)) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = key;
      input.value = value;
      form.appendChild(input);
    }

    document.body.appendChild(form);
    form.submit();
  }

  function toggleLayerGroup(groupKey) {
    setExpandedLayerGroups((current) => ({
      ...current,
      [groupKey]: !current[groupKey],
    }));
  }

  async function saveCurrentSheet() {
    await saveManualSheetSize();
    setMessage("Current sheet saved.");
  }

  async function saveSheetDimensions(
    widthCm,
    heightCm,
    successMessage = "Sheet size saved.",
  ) {
    const width = Math.max(1, round2(numberValue(widthCm, sheetWidthCm)));
    const height = Math.max(1, round2(numberValue(heightCm, sheetHeightCm)));

    setBusy(true);

    try {
      const data = await readJson(
        await fetch(api.detail, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            width_cm: width,
            height_cm: height,
          }),
        }),
      );

      const updatedSheet = {
        ...sheet,
        ...data.sheet,
        width_cm: numberValue(data.sheet?.width_cm, width),
        height_cm: numberValue(data.sheet?.height_cm, height),
        spacing_cm: numberValue(
          data.sheet?.spacing_cm,
          sheet?.spacing_cm || 0.2,
        ),
        margin_cm: numberValue(
          data.sheet?.margin_cm,
          sheet?.margin_cm || 0.2,
        ),
      };

      setSheet(updatedSheet);
      setSheetWidthDraft(String(updatedSheet.width_cm));
      setSheetHeightDraft(String(updatedSheet.height_cm));
      setMessage(successMessage);
      return updatedSheet;
    } catch (error) {
      setMessage(error.message || "Could not save sheet size.");
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function saveManualSheetSize() {
    await saveSheetDimensions(
      sheetWidthDraft,
      sheetHeightDraft,
      "Manual sheet size saved. Artwork may remain outside the sheet.",
    );
  }

  async function updateManyItemPositions(patches) {
    for (const [itemId, patch] of Object.entries(patches)) {
      await readJson(
        await fetch(api.updateItem(itemId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        }),
      );
    }
  }

  async function expandSheetToArtwork() {
    if (!items.length) {
      setMessage("There is no artwork to include.");
      return;
    }

    const margin = Math.max(sheet?.margin_cm || 0.2, 0);
    const minX = Math.min(...items.map((item) => item.x_cm));
    const minY = Math.min(...items.map((item) => item.y_cm));
    const maxX = Math.max(
      ...items.map((item) => item.x_cm + item.width_cm),
    );
    const maxY = Math.max(
      ...items.map((item) => item.y_cm + item.height_cm),
    );

    const shiftX = minX < margin ? margin - minX : 0;
    const shiftY = minY < margin ? margin - minY : 0;
    const patches = {};

    for (const item of items) {
      patches[item.id] = {
        x_cm: round2(item.x_cm + shiftX),
        y_cm: round2(item.y_cm + shiftY),
      };
    }

    const nextWidth = Math.max(
      sheetWidthCm,
      maxX + shiftX + margin,
    );
    const nextHeight = Math.max(
      sheetHeightCm,
      maxY + shiftY + margin,
    );

    setBusy(true);

    try {
      if (shiftX || shiftY) {
        await updateManyItemPositions(patches);
      }

      await saveSheetDimensions(
        nextWidth,
        nextHeight,
        "Sheet expanded to include every artwork layer.",
      );
      await loadSheet();
    } catch (error) {
      setMessage(error.message || "Could not expand the sheet.");
    } finally {
      setBusy(false);
    }
  }

  async function cropSheetToArtwork() {
    if (!items.length) {
      setMessage("There is no artwork to crop the sheet around.");
      return;
    }

    const margin = Math.max(sheet?.margin_cm || 0.2, 0);
    const minX = Math.min(...items.map((item) => item.x_cm));
    const minY = Math.min(...items.map((item) => item.y_cm));
    const maxX = Math.max(
      ...items.map((item) => item.x_cm + item.width_cm),
    );
    const maxY = Math.max(
      ...items.map((item) => item.y_cm + item.height_cm),
    );

    const shiftX = margin - minX;
    const shiftY = margin - minY;
    const patches = {};

    for (const item of items) {
      patches[item.id] = {
        x_cm: round2(item.x_cm + shiftX),
        y_cm: round2(item.y_cm + shiftY),
      };
    }

    const nextWidth = Math.max(
      1,
      round2(maxX - minX + margin * 2),
    );
    const nextHeight = Math.max(
      1,
      round2(maxY - minY + margin * 2),
    );

    setBusy(true);

    try {
      await updateManyItemPositions(patches);
      await saveSheetDimensions(
        nextWidth,
        nextHeight,
        "Sheet cropped tightly around all artwork.",
      );
      await loadSheet();
    } catch (error) {
      setMessage(error.message || "Could not crop the sheet.");
    } finally {
      setBusy(false);
    }
  }

  function beginSheetResize(mode, event) {
    event.preventDefault();
    event.stopPropagation();

    const startSession = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      widthCm: sheetWidthCm,
      heightCm: sheetHeightCm,
    };

    sheetResizeRef.current = startSession;
    setSheetResizePreview({ widthCm: sheetWidthCm, heightCm: sheetHeightCm });

    function handleMove(moveEvent) {
      const current = sheetResizeRef.current;
      if (!current) return;

      const deltaXcm = (moveEvent.clientX - current.startX) / Math.max(cmToPx, 0.001);
      const deltaYcm = (moveEvent.clientY - current.startY) / Math.max(cmToPx, 0.001);

      const nextWidth = current.mode.includes("right")
        ? Math.max(1, round2(current.widthCm + deltaXcm))
        : current.widthCm;
      const nextHeight = current.mode.includes("bottom")
        ? Math.max(1, round2(current.heightCm + deltaYcm))
        : current.heightCm;

      current.previewWidthCm = nextWidth;
      current.previewHeightCm = nextHeight;
      setSheetResizePreview({ widthCm: nextWidth, heightCm: nextHeight });
      setSheetWidthDraft(String(nextWidth));
      setSheetHeightDraft(String(nextHeight));
    }

    async function handleUp() {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      const current = sheetResizeRef.current;
      sheetResizeRef.current = null;
      if (!current) return;

      const finalWidth = current.previewWidthCm ?? current.widthCm;
      const finalHeight = current.previewHeightCm ?? current.heightCm;
      setSheetResizePreview(null);
      await saveSheetDimensions(finalWidth, finalHeight, "Sheet border resized.");
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  }

  function applySelection(ids, primaryId = null) {
    const available = new Set(items.map((item) => String(item.id)));
    const unique = [];

    for (const id of ids || []) {
      if (!available.has(String(id))) continue;
      if (unique.some((current) => String(current) === String(id))) continue;
      unique.push(id);
    }

    const nextPrimary =
      primaryId != null &&
      unique.some((id) => String(id) === String(primaryId))
        ? primaryId
        : unique[unique.length - 1] ?? null;

    setSelectedIds(unique);
    setSelectedId(nextPrimary);
  }

  function handleLayerSelection(event, itemId) {
    event.stopPropagation();

    if (activeMainTool !== "move") return;

    const alreadySelected = selectedIdSet.has(String(itemId));

    if (event.altKey) {
      const next = selectedIds.filter(
        (id) => String(id) !== String(itemId),
      );
      applySelection(next);
      return;
    }

    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      if (alreadySelected) {
        const next = selectedIds.filter(
          (id) => String(id) !== String(itemId),
        );
        applySelection(next);
      } else {
        applySelection([...selectedIds, itemId], itemId);
      }
      return;
    }

    if (alreadySelected) {
      setSelectedId(itemId);
      return;
    }

    applySelection([itemId], itemId);
  }

  async function updateItem(itemId, patch, reload = false) {
    setItems((current) =>
      current.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
    );

    try {
      await readJson(
        await fetch(api.updateItem(itemId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        }),
      );
      if (reload) await loadSheet();
    } catch (error) {
      setMessage(error.message || "Save failed.");
      await loadSheet();
    }
  }

  function pushHistory(entry) {
    setHistoryStack((current) => [...current.slice(-49), entry]);
  }

  async function undoLastAction() {
    const last = historyStack[historyStack.length - 1];
    if (!last) return;

    try {
      if (last.type === "delete" && api.createItem) {
        await readJson(
          await fetch(api.createItem, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(last.snapshot),
          }),
        );
      } else if (last.type === "delete-many" && api.createItem) {
        for (const snapshot of last.snapshots || []) {
          await readJson(
            await fetch(api.createItem, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(snapshot),
            }),
          );
        }
      } else if (last.type === "paste") {
        await readJson(await fetch(api.deleteItem(last.itemId), { method: "POST" }));
      } else if (last.type === "paste-many") {
        for (const itemId of last.itemIds || []) {
          await readJson(
            await fetch(api.deleteItem(itemId), { method: "POST" }),
          );
        }
      } else if (last.type === "transform") {
        await readJson(
          await fetch(api.updateItem(last.itemId), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(last.before),
          }),
        );
      } else if (last.type === "group-transform") {
        for (const [itemId, before] of Object.entries(last.before || {})) {
          await readJson(
            await fetch(api.updateItem(itemId), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(before),
            }),
          );
        }
      } else {
        return;
      }

      setHistoryStack((current) => current.slice(0, -1));
      await loadSheet();
      setMessage("Undo complete.");
    } catch (error) {
      setMessage(error.message || "Undo failed.");
    }
  }

  async function uploadFiles() {
    const files = Array.from(fileInputRef.current?.files || []);
    if (!files.length) {
      fileInputRef.current?.click();
      return;
    }

    await uploadIncomingFiles(files, "artwork");
  }

  async function runAutoPack() {
    if (!items.length) return;
    setBusy(true);
    setMessage("Packing every real layer to reduce film waste...");

    try {
      const data = await readJson(
        await fetch(api.autoPack, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ allow_rotate: allowRotate }),
        }),
      );
      setMetrics(data);
      await loadSheet();
      setMessage(
        `Packed. Used length ${data.used_height_cm}cm · estimated waste ${data.waste_percent}%`,
      );
    } catch (error) {
      setMessage(error.message || "Auto pack failed.");
    } finally {
      setBusy(false);
    }
  }

  async function setSmartQuantity() {
    if (!selected) {
      setMessage("Select an artwork first.");
      return;
    }

    const target = Math.max(1, Math.min(500, Number.parseInt(quantity || 1, 10)));
    setBusy(true);
    setMessage(`Creating ${target} real printable layer(s) and packing them...`);

    try {
      const data = await readJson(
        await fetch(api.smartDuplicate(selected.id), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            total_quantity: target,
            allow_rotate: allowRotate,
          }),
        }),
      );
      setMetrics(data);
      await loadSheet();
      setMessage(
        `${target} real layer(s) ready. Used length ${data.used_height_cm}cm.`,
      );
    } catch (error) {
      setMessage(error.message || "Smart quantity failed.");
    } finally {
      setBusy(false);
    }
  }

  async function selectedAction(endpoint, progressMessage, doneMessage) {
    if (!selected) {
      setMessage("Select an artwork first.");
      return;
    }
    setBusy(true);
    setMessage(progressMessage);
    startTaskProgress(progressMessage);
    try {
      await readJson(await fetch(endpoint(selected.id), { method: "POST" }));
      await loadSheet();
      finishTaskProgress(doneMessage);
      setMessage(doneMessage);
    } catch (error) {
      if (taskProgressTimerRef.current) {
        window.clearInterval(taskProgressTimerRef.current);
        taskProgressTimerRef.current = null;
      }
      setTaskProgress(null);
      setMessage(error.message || "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function switchSource(source) {
    if (!selected) return;
    const patch = {
      use_processed: source === "processed",
      use_upscaled: source === "upscaled",
    };
    await updateItem(selected.id, patch, true);
  }

  async function deleteSelected(withConfirm = true) {
    const targets = selectedItems.length
      ? selectedItems
      : selected
        ? [selected]
        : [];

    if (!targets.length) return;

    const label =
      targets.length === 1
        ? "this real layer"
        : `${targets.length} selected layers`;

    if (withConfirm && !window.confirm(`Delete ${label}?`)) return;

    setBusy(true);

    try {
      const snapshots = targets.map((item) => ({
        asset_id: item.asset_id,
        x_cm: item.x_cm,
        y_cm: item.y_cm,
        width_cm: item.width_cm,
        height_cm: item.height_cm,
        use_processed: item.use_processed,
        use_upscaled: item.use_upscaled,
        rotation: item.rotation || 0,
        lock_ratio: item.lock_ratio,
      }));

      pushHistory({
        type: targets.length === 1 ? "delete" : "delete-many",
        snapshot: snapshots[0],
        snapshots,
      });

      for (const item of targets) {
        await readJson(
          await fetch(api.deleteItem(item.id), { method: "POST" }),
        );
      }

      applySelection([]);
      await loadSheet(false);
      setMessage(
        targets.length === 1
          ? "Layer deleted."
          : `${targets.length} layers deleted.`,
      );
    } catch (error) {
      setMessage(error.message || "Delete failed.");
    } finally {
      setBusy(false);
    }
  }

  async function exportPng() {
    if (!sheet) return;
    setBusy(true);
    setMessage(`Preparing transparent ${exportDpi} DPI PNG...`);
    try {
      const response = await fetch(`${api.exportPng}?dpi=${exportDpi}`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Export failed.");
      }
      const blob = await response.blob();
      downloadBlob(blob, `${sheet.name || "niron-sheet"}_${exportDpi}dpi.png`);
      setMessage("Print-ready transparent PNG exported.");
    } catch (error) {
      setMessage(error.message || "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  async function exportPsd() {
    if (!sheet || !items.length) return;

    setBusy(true);
    setMessage(`Preparing layered PSD at ${exportDpi} DPI...`);

    try {
      const { writePsdBuffer } = await import("ag-psd");
      const pxPerCm = exportDpi / 2.54;
      const psdWidth = Math.max(1, Math.round(sheetWidthCm * pxPerCm));
      const psdHeight = Math.max(1, Math.round(sheetHeightCm * pxPerCm));
      const children = [];

      for (const item of items) {
        const image = await loadImageElement(item.image_url);
        const layerWidth = Math.max(1, Math.round(item.width_cm * pxPerCm));
        const layerHeight = Math.max(1, Math.round(item.height_cm * pxPerCm));
        const layerCanvas = ensureOffscreenCanvas(layerWidth, layerHeight);
        const ctx = layerCanvas.getContext("2d");

        ctx.clearRect(0, 0, layerWidth, layerHeight);
        ctx.save();
        ctx.translate(layerWidth / 2, layerHeight / 2);
        ctx.rotate((Number(item.rotation || 0) * Math.PI) / 180);

        const boxWidth = Number(item.rotation || 0) % 180 !== 0 ? layerHeight : layerWidth;
        const boxHeight = Number(item.rotation || 0) % 180 !== 0 ? layerWidth : layerHeight;
        const artworkCanvas = ensureOffscreenCanvas(boxWidth, boxHeight);
        const artworkContext = artworkCanvas.getContext("2d");
        drawContainImage(artworkContext, image, boxWidth, boxHeight);
        ctx.drawImage(artworkCanvas, -boxWidth / 2, -boxHeight / 2);
        ctx.restore();

        children.push({
          name: item.name || `Layer ${item.id}`,
          canvas: layerCanvas,
          left: Math.round(item.x_cm * pxPerCm),
          top: Math.round(item.y_cm * pxPerCm),
        });
      }

      const psdBuffer = writePsdBuffer({
        width: psdWidth,
        height: psdHeight,
        children,
      });

      const blob = new Blob([psdBuffer], {
        type: "application/octet-stream",
      });

      downloadBlob(
        blob,
        `${sheet.name || "niron-sheet"}_${exportDpi}dpi.psd`,
      );
      setMessage("Layered PSD exported.");
    } catch (error) {
      setMessage(
        error.message ||
          "PSD export failed. Install ag-psd in frontend and rebuild.",
      );
    } finally {
      setBusy(false);
    }
  }

  function setSelectedRatioLock(locked) {
    if (!selected || selectionCount !== 1) return;

    setItems((current) =>
      current.map((item) =>
        item.id === selected.id
          ? { ...item, lock_ratio: locked }
          : item,
      ),
    );

    updateItem(selected.id, { lock_ratio: locked });

    setMessage(
      locked
        ? 'Ratio locked: changing Width or Height changes the other value.'
        : 'Free size: Width and Height now change independently.',
    );
  }

  function changeSelectedSize(field, rawValue) {
    if (!selected) return;
    const value = Math.max(MIN_ITEM_CM, numberValue(rawValue, MIN_ITEM_CM));
    const patch = { [field]: round2(value) };

    if (selected.lock_ratio) {
      if (field === "width_cm" && selected.width_cm > 0) {
        patch.height_cm = round2(value * (selected.height_cm / selected.width_cm));
      }
      if (field === "height_cm" && selected.height_cm > 0) {
        patch.width_cm = round2(value * (selected.width_cm / selected.height_cm));
      }
    }

    setItems((current) =>
      current.map((item) => (item.id === selected.id ? { ...item, ...patch } : item)),
    );
  }

  function saveSelectedSize() {
    if (!selected) return;
    updateItem(selected.id, {
      width_cm: selected.width_cm,
      height_cm: selected.height_cm,
      lock_ratio: selected.lock_ratio,
    });
    setMessage("Size saved.");
  }

  useEffect(() => {
    async function handleShortcuts(event) {
      const key = event.key.toLowerCase();
      const commandKey = event.ctrlKey || event.metaKey;
      const typing = isTypingTarget(event.target);

      if (commandKey && !event.altKey) {
        const zoomInKey =
          event.key === '+' ||
          event.key === '=' ||
          event.code === 'NumpadAdd';

        const zoomOutKey =
          event.key === '-' ||
          event.code === 'NumpadSubtract';

        if (zoomInKey) {
          event.preventDefault();
          event.stopPropagation();
          zoomSheetIn();
          setMessage(`Sheet zoom: ${Math.round(
            clamp(
              zoom * SHEET_ZOOM_FACTOR,
              MIN_SHEET_ZOOM,
              MAX_SHEET_ZOOM,
            ) * 100,
          )}%`);
          return;
        }

        if (zoomOutKey) {
          event.preventDefault();
          event.stopPropagation();
          zoomSheetOut();
          setMessage(`Sheet zoom: ${Math.round(
            clamp(
              zoom / SHEET_ZOOM_FACTOR,
              MIN_SHEET_ZOOM,
              MAX_SHEET_ZOOM,
            ) * 100,
          )}%`);
          return;
        }

        if (key === '0' || event.code === 'Numpad0') {
          event.preventDefault();
          event.stopPropagation();
          resetSheetZoom();
          setMessage('Sheet zoom reset to 100%.');
          return;
        }
      }

      if (!typing && key === "h" && !commandKey) {
        event.preventDefault();
        chooseMainTool("hand");
        return;
      }

      if (!typing && key === "f" && !commandKey) {
        event.preventDefault();

        if (event.shiftKey) {
          fitSelectionToViewport();
        } else {
          fitSheetToViewport();
        }

        return;
      }

      if (!typing && key.startsWith("arrow")) {
        event.preventDefault();
        const distance = event.shiftKey ? 500 : 120;

        if (key === "arrowleft") panCanvasBy(-distance, 0);
        if (key === "arrowright") panCanvasBy(distance, 0);
        if (key === "arrowup") panCanvasBy(0, -distance);
        if (key === "arrowdown") panCanvasBy(0, distance);
        return;
      }

      if (typing) {
        return;
      }

      if (
        activeMainTool !== "move" &&
        activeMainTool !== "hand"
      ) {
        return;
      }

      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selectionCount
      ) {
        event.preventDefault();
        await deleteSelected(false);
        return;
      }

      if (event.ctrlKey && key === "a") {
        event.preventDefault();
        const allIds = items.map((item) => item.id);
        applySelection(allIds, allIds[allIds.length - 1] ?? null);
        setMessage(`${allIds.length} layers selected.`);
        return;
      }

      if (event.ctrlKey && key === "d") {
        event.preventDefault();
        applySelection([]);
        setMessage("Selection cleared.");
        return;
      }

      if (event.ctrlKey && key === "z") {
        event.preventDefault();
        await undoLastAction();
        return;
      }

      if (event.ctrlKey && key === "c" && selectionCount) {
        event.preventDefault();

        const copies = selectedItems.map((item) => ({
          id: item.id,
          asset_id: item.asset_id,
          width_cm: item.width_cm,
          height_cm: item.height_cm,
          use_processed: item.use_processed,
          use_upscaled: item.use_upscaled,
          rotation: item.rotation || 0,
          lock_ratio: item.lock_ratio,
        }));

        setClipboardItem(copies);
        setMessage(
          copies.length === 1
            ? "Layer copied."
            : `${copies.length} layers copied.`,
        );
        return;
      }

      if (
        event.ctrlKey &&
        key === "v" &&
        Array.isArray(clipboardItem) &&
        clipboardItem.length &&
        api.cloneItem
      ) {
        event.preventDefault();

        try {
          const pastedIds = [];

          for (const source of clipboardItem) {
            const data = await readJson(
              await fetch(api.cloneItem(source.id), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  offset_x_cm: 0.8,
                  offset_y_cm: 0.8,
                }),
              }),
            );

            pastedIds.push(data.item.id);
          }

          pushHistory({
            type: pastedIds.length === 1 ? "paste" : "paste-many",
            itemId: pastedIds[0],
            itemIds: pastedIds,
          });

          await loadSheet(false);

          setTimeout(() => {
            setSelectedIds(pastedIds);
            setSelectedId(pastedIds[pastedIds.length - 1] ?? null);
          }, 0);

          setMessage(
            pastedIds.length === 1
              ? "Layer pasted."
              : `${pastedIds.length} layers pasted.`,
          );
        } catch (error) {
          setMessage(error.message || "Paste failed.");
        }

        return;
      }

      if (key === "v") chooseMainTool("move");
      if (key === "c" && !event.ctrlKey) chooseMainTool("crop");
      if (key === "w") chooseMainTool("wand");
      if (key === "l") chooseMainTool("lasso");
      if (key === "p") chooseMainTool("polygon");
      if (event.key === "+" || event.key === "=") chooseMainTool("restore");
      if (event.key === "-") chooseMainTool("erase");
    }

    window.addEventListener("keydown", handleShortcuts, true);
    return () => window.removeEventListener("keydown", handleShortcuts, true);
  }, [
    activeMainTool,
    selected,
    selectedItems,
    selectionCount,
    clipboardItem,
    historyStack,
    api,
    items,
    loadSheet,
    zoom,
    zoomSheetIn,
    zoomSheetOut,
    resetSheetZoom,
  ]);

  function chooseMainTool(toolName) {
    if (toolName === "move") {
      setActiveMainTool("move");
      setMessage("Move and resize mode.");
      return;
    }

    if (toolName === "hand") {
      setActiveMainTool("hand");
      setMessage(
        "Hand tool: drag the pasteboard to pan. Space + drag and middle mouse also work.",
      );
      return;
    }

    if (!selected || selectionCount !== 1) {
      setMessage("Select exactly one artwork before using a pixel-editing tool.");
      return;
    }

    if (Number(selected.rotation || 0) % 360 !== 0) {
      setMessage("Rotate this artwork back to 0° before direct pixel editing.");
      return;
    }

    if (toolName === "crop" && !api.cropItem) {
      setMessage("Crop API is missing from builder_react.html.");
      return;
    }

    setActiveMainTool(toolName);
    setMessage(`${toolName} tool is active directly on the selected artwork.`);
  }

  function beginMarqueeSelection(event) {
    if (
      activeMainTool !== "move" ||
      spacePanRef.current ||
      event.button !== 0 ||
      busy
    ) {
      return;
    }

    const sheetElement = printSheetRef.current;
    if (!sheetElement) return;

    const bounds = sheetElement.getBoundingClientRect();
    const startX = clamp(event.clientX - bounds.left, 0, bounds.width);
    const startY = clamp(event.clientY - bounds.top, 0, bounds.height);
    const baseIds = [...selectedIds];

    const mode = event.altKey
      ? "subtract"
      : event.shiftKey || event.ctrlKey || event.metaKey
        ? "add"
        : "replace";

    marqueeStartRef.current = {
      startX,
      startY,
      baseIds,
      mode,
    };

    setMarqueeRect({
      left: startX,
      top: startY,
      width: 0,
      height: 0,
    });

    event.preventDefault();

    function handleMove(moveEvent) {
      const currentX = clamp(
        moveEvent.clientX - bounds.left,
        0,
        bounds.width,
      );
      const currentY = clamp(
        moveEvent.clientY - bounds.top,
        0,
        bounds.height,
      );

      setMarqueeRect({
        left: Math.min(startX, currentX),
        top: Math.min(startY, currentY),
        width: Math.abs(currentX - startX),
        height: Math.abs(currentY - startY),
      });
    }

    function handleUp(upEvent) {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);

      const currentX = clamp(
        upEvent.clientX - bounds.left,
        0,
        bounds.width,
      );
      const currentY = clamp(
        upEvent.clientY - bounds.top,
        0,
        bounds.height,
      );

      const selectionBox = {
        left: Math.min(startX, currentX),
        top: Math.min(startY, currentY),
        right: Math.max(startX, currentX),
        bottom: Math.max(startY, currentY),
        width: Math.abs(currentX - startX),
        height: Math.abs(currentY - startY),
      };

      const startInfo = marqueeStartRef.current;
      marqueeStartRef.current = null;
      setMarqueeRect(null);

      if (!startInfo) return;

      if (selectionBox.width < 4 && selectionBox.height < 4) {
        if (startInfo.mode === "replace") {
          applySelection([]);
          setMessage("Selection cleared.");
        }
        return;
      }

      const hitIds = items
        .filter((item) => {
          const left = sheetOriginX + item.x_cm * cmToPx;
          const top = sheetOriginY + item.y_cm * cmToPx;
          const right = left + item.width_cm * cmToPx;
          const bottom = top + item.height_cm * cmToPx;

          return !(
            right < selectionBox.left ||
            left > selectionBox.right ||
            bottom < selectionBox.top ||
            top > selectionBox.bottom
          );
        })
        .map((item) => item.id);

      let nextIds;

      if (startInfo.mode === "add") {
        nextIds = [...startInfo.baseIds];

        for (const id of hitIds) {
          if (!nextIds.some((current) => String(current) === String(id))) {
            nextIds.push(id);
          }
        }
      } else if (startInfo.mode === "subtract") {
        const hitSet = new Set(hitIds.map((id) => String(id)));
        nextIds = startInfo.baseIds.filter(
          (id) => !hitSet.has(String(id)),
        );
      } else {
        nextIds = hitIds;
      }

      applySelection(
        nextIds,
        hitIds[hitIds.length - 1] ??
          nextIds[nextIds.length - 1] ??
          null,
      );

      setMessage(
        nextIds.length
          ? `${nextIds.length} layer${nextIds.length === 1 ? "" : "s"} selected.`
          : "No layers selected.",
      );
    }

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  }

  function beginSelectedGroupDrag(item, data) {
    const alreadySelected = selectedIdSet.has(String(item.id));
    const dragIds =
      alreadySelected && selectedIds.length
        ? [...selectedIds]
        : [item.id];

    if (!alreadySelected) {
      applySelection([item.id], item.id);
    } else {
      setSelectedId(item.id);
    }

    const startPositions = {};

    for (const row of items) {
      if (!dragIds.some((id) => String(id) === String(row.id))) {
        continue;
      }

      startPositions[row.id] = {
        x_cm: row.x_cm,
        y_cm: row.y_cm,
      };
    }

    groupDragRef.current = {
      primaryId: item.id,
      ids: dragIds,
      startPointerX: (data.x - sheetOriginX) / cmToPx,
      startPointerY: (data.y - sheetOriginY) / cmToPx,
      startPositions,
    };
  }

  function moveSelectedGroup(item, data) {
    const group = groupDragRef.current;

    if (!group || String(group.primaryId) !== String(item.id)) {
      return;
    }

    const deltaX =
      (data.x - sheetOriginX) / cmToPx - group.startPointerX;
    const deltaY =
      (data.y - sheetOriginY) / cmToPx - group.startPointerY;
    const idSet = new Set(group.ids.map((id) => String(id)));

    setItems((current) =>
      current.map((row) => {
        if (!idSet.has(String(row.id))) return row;

        const start = group.startPositions[row.id];
        if (!start) return row;

        return {
          ...row,
          x_cm: round2(start.x_cm + deltaX),
          y_cm: round2(start.y_cm + deltaY),
        };
      }),
    );
  }

  async function finishSelectedGroupDrag(item, data) {
    const group = groupDragRef.current;

    if (!group || String(group.primaryId) !== String(item.id)) {
      return;
    }

    const deltaX =
      (data.x - sheetOriginX) / cmToPx - group.startPointerX;
    const deltaY =
      (data.y - sheetOriginY) / cmToPx - group.startPointerY;
    const patches = {};

    for (const id of group.ids) {
      const start = group.startPositions[id];
      if (!start) continue;

      patches[id] = {
        x_cm: round2(start.x_cm + deltaX),
        y_cm: round2(start.y_cm + deltaY),
      };
    }

    groupDragRef.current = null;

    pushHistory({
      type: group.ids.length === 1 ? "transform" : "group-transform",
      itemId: group.ids[0],
      before:
        group.ids.length === 1
          ? group.startPositions[group.ids[0]]
          : group.startPositions,
    });

    try {
      for (const [itemId, patch] of Object.entries(patches)) {
        await readJson(
          await fetch(api.updateItem(itemId), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          }),
        );
      }

      setMessage(
        group.ids.length === 1
          ? "Layer moved."
          : `${group.ids.length} selected layers moved together.`,
      );
    } catch (error) {
      setMessage(error.message || "Group move failed.");
      await loadSheet();
    }
  }

  const resizeHandleStyles = {
    top: handleStyle("ns-resize", "50%", "-6px"),
    bottom: handleStyle("ns-resize", "50%", "auto", "-6px"),
    left: handleStyle("ew-resize", "-6px", "50%"),
    right: handleStyle("ew-resize", "auto", "50%", undefined, "-6px"),
    topLeft: cornerHandle("nwse-resize", "-7px", "-7px"),
    topRight: cornerHandle("nesw-resize", "-7px", undefined, undefined, "-7px"),
    bottomLeft: cornerHandle("nesw-resize", undefined, "-7px", "-7px"),
    bottomRight: cornerHandle("nwse-resize", undefined, undefined, "-7px", "-7px"),
  };

  return (
    <div className="builder-app">
      <style>{DIRECT_EDIT_CSS}</style>
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-logo">NR</div>
          <div>
            <strong>Niron Smart Print Builder</strong>
            <span>Clean background · Lasso · Magic Wand · Set quantity · Auto pack · Export</span>
          </div>
        </div>
        <div className="topbar-file-actions">
          <button type="button" onClick={openNewSheetDialog}>
            New Sheet
          </button>
          <button type="button" onClick={saveCurrentSheet} disabled={busy}>
            Save Sheet
          </button>
        </div>
        <div className="topbar-summary">
          <b>{sheet?.name || "Loading..."}</b>
          <span>
            {sheetWidthCm.toFixed(2)}cm width · {items.length} real layers · {selectionCount} selected · {sheetHeightCm.toFixed(2)}cm used
          </span>
        </div>
      </header>

      <main className="workspace">
        <aside className="sidebar left-sidebar">
          <section className="panel-section">
            <h3>1. Upload artwork</h3>
            <input
              ref={fileInputRef}
              className="file-input"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              onChange={uploadFiles}
            />
            <button className="primary-button" onClick={() => fileInputRef.current?.click()} disabled={busy}>
              Add Artwork
            </button>
            <p className="muted-text">
              Drag image files into the sheet, or press Ctrl + V to paste screenshots/images.
            </p>
          </section>

          <section className="panel-section">
            <h3>2. Clean background</h3>
            <button
              onClick={() => selectedAction(api.removeBackground, "AI is removing the background...", "AI background clear finished.")}
              disabled={busy || selectionCount !== 1}
            >
              AI Remove Background
            </button>
            <button className="secondary-button" onClick={() => chooseMainTool("wand")} disabled={selectionCount !== 1 || busy}>
              Edit Selected Artwork
            </button>
            <button
              className="secondary-button"
              onClick={() => selectedAction(api.upscaleItem, "Upscaling artwork...", "Artwork upscaled.")}
              disabled={busy || selectionCount !== 1}
            >
              Upscale ×2
            </button>
          </section>

          <section className="panel-section">
            <h3>3. Quantity & packing</h3>
            <label>Total quantity for this design</label>
            <input
              type="number"
              min="1"
              max="500"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              disabled={selectionCount !== 1}
            />
            <label className="check-row">
              <input
                type="checkbox"
                checked={allowRotate}
                onChange={(event) => setAllowRotate(event.target.checked)}
              />
              Allow 90° rotation to save space
            </label>
            <button className="dark-button" onClick={setSmartQuantity} disabled={busy || selectionCount !== 1}>
              Smart Quantity + Pack
            </button>
            <button className="secondary-button" onClick={runAutoPack} disabled={busy || !items.length}>
              Repack All Layers
            </button>
          </section>

          <section className="panel-section compact-section">
            <h3>Film efficiency</h3>
            <div className="metric-grid">
              <Metric label="Used length" value={`${(metrics?.used_height_cm ?? sheetHeightCm).toFixed?.(2) || sheetHeightCm.toFixed(2)}cm`} />
              <Metric label="Waste estimate" value={metrics ? `${metrics.waste_percent}%` : "—"} />
            </div>
          </section>
        </aside>

        <section className="canvas-column main-screen-editor">
          <div className="canvas-toolbar">
            <div className="tool-group">
              <button
                type="button"
                onClick={() => zoomSheetOut()}
                title="Zoom out sheet (Ctrl + -)"
              >
                −
              </button>
              <label className="sheet-zoom-input-wrap">
                <input
                  className="sheet-zoom-input"
                  type="number"
                  min="5"
                  max="50000"
                  step="1"
                  value={Math.round(zoom * 100)}
                  onChange={(event) =>
                    setSheetZoom(
                      numberValue(event.target.value, 100) / 100,
                    )
                  }
                  title="Type zoom from 5% to 50000%"
                />
                <span>%</span>
              </label>
              <button
                type="button"
                onClick={() => zoomSheetIn()}
                title="Zoom in sheet (Ctrl + +)"
              >
                +
              </button>
              <button
                type="button"
                onClick={resetSheetZoom}
                title="Reset sheet zoom (Ctrl + 0)"
              >
                100%
              </button>
              <button
                type="button"
                onClick={fitSheetToViewport}
                title="Fit sheet to window (F)"
              >
                Fit Sheet
              </button>
              <button
                type="button"
                onClick={fitSelectionToViewport}
                disabled={!selectionCount}
                title="Fit selected artwork to window (Shift + F)"
              >
                Fit Selection
              </button>
              <div className="pan-pad" title="Quick canvas navigation">
                <button type="button" onClick={() => panCanvasBy(0, -320)}>↑</button>
                <div>
                  <button type="button" onClick={() => panCanvasBy(-320, 0)}>←</button>
                  <button type="button" onClick={() => panCanvasBy(320, 0)}>→</button>
                </div>
                <button type="button" onClick={() => panCanvasBy(0, 320)}>↓</button>
              </div>
              <button
                type="button"
                onClick={expandSheetToArtwork}
                disabled={busy || !items.length}
                title="Expand sheet to include all artwork"
              >
                Expand Sheet
              </button>
              <button
                type="button"
                onClick={cropSheetToArtwork}
                disabled={busy || !items.length}
                title="Crop sheet tightly around all artwork"
              >
                Crop Sheet
              </button>
              <span className="zoom-shortcut-hint">
                Ctrl+wheel zoom · Space/middle drag pan · Shift+wheel horizontal
              </span>
              {activeMainTool !== "move" && (
                <span className="editing-mode-label">
                  Direct editing: {activeMainTool.toUpperCase()}
                </span>
              )}
            </div>
            <div className="canvas-help">
              {activeMainTool === "move"
                ? "Marquee-select on empty area. Space + drag or middle mouse pans. Arrow keys move the view."
                : activeMainTool === "hand"
                  ? "Drag anywhere to pan. Press V to return to Move."
                  : "Edit directly on the selected artwork. Other layers remain visible."}
            </div>
          </div>

          <div className="main-screen-workspace">
            <nav className="photoshop-main-toolbar" aria-label="Artwork tools">
              <button
                type="button"
                className={activeMainTool === "move" ? "screen-tool active" : "screen-tool"}
                onClick={() => chooseMainTool("move")}
                title="Move and transform layer (V)"
              >
                <span className="screen-tool-icon">V</span>
                <small>Move</small>
              </button>

              <button
                type="button"
                className={activeMainTool === "hand" ? "screen-tool active" : "screen-tool"}
                onClick={() => chooseMainTool("hand")}
                title="Hand/Pan canvas (H or Space + drag)"
              >
                <span className="screen-tool-icon">H</span>
                <small>Hand</small>
              </button>

              <button
                type="button"
                className={activeMainTool === "crop" ? "screen-tool active" : "screen-tool"}
                onClick={() => chooseMainTool("crop")}
                disabled={selectionCount !== 1}
                title="Crop directly on the selected artwork (C)"
              >
                <span className="screen-tool-icon">C</span>
                <small>Crop</small>
              </button>

              <button
                type="button"
                className={activeMainTool === "wand" ? "screen-tool active" : "screen-tool"}
                onClick={() => chooseMainTool("wand")}
                disabled={selectionCount !== 1}
                title="Magic Wand selection directly on artwork (W)"
              >
                <span className="screen-tool-icon">W</span>
                <small>Wand</small>
              </button>

              <button
                type="button"
                className={activeMainTool === "lasso" ? "screen-tool active" : "screen-tool"}
                onClick={() => chooseMainTool("lasso")}
                disabled={selectionCount !== 1}
                title="Freehand Lasso directly on artwork (L)"
              >
                <span className="screen-tool-icon">L</span>
                <small>Lasso</small>
              </button>

              <button
                type="button"
                className={activeMainTool === "polygon" ? "screen-tool active" : "screen-tool"}
                onClick={() => chooseMainTool("polygon")}
                disabled={selectionCount !== 1}
                title="Polygonal Lasso directly on artwork (P)"
              >
                <span className="screen-tool-icon">P</span>
                <small>Polygon</small>
              </button>

              <button
                type="button"
                className={activeMainTool === "restore" ? "screen-tool active" : "screen-tool"}
                onClick={() => chooseMainTool("restore")}
                disabled={selectionCount !== 1}
                title="Restore deleted pixels directly (+)"
              >
                <span className="screen-tool-icon">+</span>
                <small>Restore</small>
              </button>

              <button
                type="button"
                className={activeMainTool === "erase" ? "screen-tool active" : "screen-tool"}
                onClick={() => chooseMainTool("erase")}
                disabled={selectionCount !== 1}
                title="Remove more pixels directly (-)"
              >
                <span className="screen-tool-icon">−</span>
                <small>Remove</small>
              </button>

              <div className="screen-tool-separator" />

              <button
                type="button"
                className="screen-tool ai-tool"
                onClick={() =>
                  selectedAction(
                    api.removeBackground,
                    "AI is removing the background...",
                    "AI background clear finished.",
                  )
                }
                disabled={!selected || busy || activeMainTool !== "move"}
                title="AI remove background"
              >
                <span className="screen-tool-icon">AI</span>
                <small>AI Clear</small>
              </button>
            </nav>

            <div className="main-screen-canvas-area">
              {isDragImportActive && (
                <div className="drop-import-overlay">
                  <div className="drop-import-card">
                    <strong>Drop image files to import</strong>
                    <span>PNG, JPG, WEBP · You can also paste screenshots with Ctrl + V</span>
                  </div>
                </div>
              )}
              <div
                ref={canvasScrollRef}
                className={`canvas-scroll ${
                  activeMainTool === "hand" || spacePanActive
                    ? "hand-pan-ready"
                    : ""
                } ${isCanvasPanning ? "is-panning" : ""}`}
                onMouseDownCapture={beginCanvasPan}
              >
                <div
                  ref={printSheetRef}
                  className={`sheet-pasteboard ${
                    activeMainTool === "move" ? "marquee-ready" : ""
                  }`}
                  style={{
                    width: pasteboardWidthPx,
                    height: pasteboardHeightPx,
                    "--sheet-origin-x": `${sheetOriginX}px`,
                    "--sheet-origin-y": `${sheetOriginY}px`,
                  }}
                  onMouseDown={beginMarqueeSelection}
                >
                  <SheetRuler
                    orientation="horizontal"
                    lengthCm={sheetWidthCm}
                    cmToPx={cmToPx}
                    left={sheetOriginX}
                    top={sheetOriginY - 28}
                  />

                  <SheetRuler
                    orientation="vertical"
                    lengthCm={sheetHeightCm}
                    cmToPx={cmToPx}
                    left={sheetOriginX - 28}
                    top={sheetOriginY}
                  />

                  <div
                    className="ruler-corner"
                    style={{
                      left: sheetOriginX - 28,
                      top: sheetOriginY - 28,
                    }}
                  >
                    cm
                  </div>

                  <div
                    className="print-sheet"
                    style={{
                      left: sheetOriginX,
                      top: sheetOriginY,
                      width: sheetWidthPx,
                      height: sheetHeightPx,
                      backgroundSize: `${cmToPx}px ${cmToPx}px`,
                      backgroundColor: sheetColor,
                    }}
                  >
                    <button
                      type="button"
                      className="sheet-resize-handle right"
                      onPointerDown={(event) => beginSheetResize("right", event)}
                      title="Drag to resize sheet width"
                    />
                    <button
                      type="button"
                      className="sheet-resize-handle bottom"
                      onPointerDown={(event) => beginSheetResize("bottom", event)}
                      title="Drag to resize sheet height"
                    />
                    <button
                      type="button"
                      className="sheet-resize-handle corner"
                      onPointerDown={(event) => beginSheetResize("right-bottom", event)}
                      title="Drag to resize sheet width and height"
                    />
                    <div
                      className="safe-margin"
                      style={{
                        inset: (sheet?.margin_cm || 0.2) * cmToPx,
                      }}
                    />

                    {!items.length && (
                      <div className="empty-sheet">
                        Upload artwork, select it, then use the Photoshop toolbar.
                      </div>
                    )}
                  </div>

                  {items.map((item) => {
                    const isSelected = selectedIdSet.has(String(item.id));
                    const isPrimary =
                      String(item.id) === String(selectedId);
                    const editingThis =
                      isPrimary &&
                      selectionCount === 1 &&
                      activeMainTool !== "move";
                    const widthPx = Math.max(item.width_cm * cmToPx, 10);
                    const heightPx = Math.max(item.height_cm * cmToPx, 10);
                    const quarterTurn = item.rotation % 180 !== 0;
                    const beforeSnapshot = {
                      x_cm: item.x_cm,
                      y_cm: item.y_cm,
                      width_cm: item.width_cm,
                      height_cm: item.height_cm,
                    };

                    return (
                      <Rnd
                        key={item.id}
                        size={{ width: widthPx, height: heightPx }}
                        position={{
                          x: sheetOriginX + item.x_cm * cmToPx,
                          y: sheetOriginY + item.y_cm * cmToPx,
                        }}
                        minWidth={MIN_ITEM_CM * cmToPx}
                        minHeight={MIN_ITEM_CM * cmToPx}
                        lockAspectRatio={item.lock_ratio}
                        disableDragging={activeMainTool !== "move"}
                        enableResizing={
                          activeMainTool === "move" &&
                          isPrimary &&
                          selectionCount === 1
                        }
                        resizeHandleStyles={
                          activeMainTool === "move" &&
                          isPrimary &&
                          selectionCount === 1
                            ? resizeHandleStyles
                            : hiddenHandles
                        }
                        onMouseDown={(event) =>
                          handleLayerSelection(event, item.id)
                        }
                        onDragStart={(_, data) => {
                          if (activeMainTool !== "move") return;
                          beginSelectedGroupDrag(item, data);
                        }}
                        onDrag={(_, data) => {
                          if (activeMainTool !== "move") return;
                          moveSelectedGroup(item, data);
                        }}
                        onDragStop={async (_, data) => {
                          if (activeMainTool !== "move") return;
                          await finishSelectedGroupDrag(item, data);
                        }}
                        onResizeStart={() => {
                          if (activeMainTool === "move") {
                            setSelectedId(item.id);
                          }
                        }}
                        onResizeStop={(_, __, ref, ___, position) => {
                          if (activeMainTool !== "move") return;

                          pushHistory({
                            type: "transform",
                            itemId: item.id,
                            before: beforeSnapshot,
                          });

                          updateItem(item.id, {
                            x_cm: round2(
                              (position.x - sheetOriginX) / cmToPx,
                            ),
                            y_cm: round2(
                              (position.y - sheetOriginY) / cmToPx,
                            ),
                            width_cm: round2(ref.offsetWidth / cmToPx),
                            height_cm: round2(ref.offsetHeight / cmToPx),
                          });
                        }}
                        className={`sheet-item ${
                          isSelected ? "selected multi-selected" : ""
                        } ${
                          isPrimary ? "primary-selected" : ""
                        } ${
                          editingThis ? "pixel-editing" : ""
                        }`}
                        style={{
                          zIndex: editingThis
                            ? 80
                            : isPrimary
                              ? 30
                              : isSelected
                                ? 20
                                : 5,
                          pointerEvents:
                            activeMainTool !== "move" && !editingThis
                              ? "none"
                              : "auto",
                        }}
                      >
                        <div className="image-frame">
                          {editingThis ? (
                            <DirectItemEditor
                              item={item}
                              endpoint={api.magicWand(item.id)}
                              cropEndpoint={api.cropItem(item.id)}
                              activeTool={activeMainTool}
                              onToolChange={setActiveMainTool}
                              displayWidthPx={widthPx}
                              displayHeightPx={heightPx}
                              onCancel={() => {
                                setActiveMainTool("move");
                                setMessage("Pixel edit cancelled.");
                              }}
                              onApplied={async (messageText) => {
                                setActiveMainTool("move");
                                await loadSheet();
                                setMessage(
                                  messageText ||
                                    "Artwork saved and layer bounds updated.",
                                );
                              }}
                            />
                          ) : (
                            <img
                              src={item.image_url}
                              alt={item.name || "Artwork"}
                              draggable="false"
                              style={
                                quarterTurn
                                  ? {
                                      width: heightPx,
                                      height: widthPx,
                                      transform: `translate(-50%, -50%) rotate(${item.rotation}deg)`,
                                    }
                                  : {
                                      width: "100%",
                                      height: "100%",
                                      transform: `translate(-50%, -50%) rotate(${item.rotation}deg)`,
                                    }
                              }
                            />
                          )}

                          {isPrimary && isSelected && (
                            <div className="selected-label">
                              {editingThis
                                ? activeMainTool.toUpperCase()
                                : selectionCount > 1
                                  ? `${selectionCount} SELECTED`
                                  : "SELECTED"}
                            </div>
                          )}
                        </div>
                      </Rnd>
                    );
                  })}

                  {marqueeRect && (
                    <div
                      className="marquee-selection-box"
                      style={{
                        left: marqueeRect.left,
                        top: marqueeRect.top,
                        width: marqueeRect.width,
                        height: marqueeRect.height,
                      }}
                    >
                      <span>SELECT</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="canvas-pan-pad" aria-label="Canvas navigation">
                <button
                  type="button"
                  className="pan-up"
                  onClick={() => panCanvasBy(0, -180)}
                  title="Pan up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="pan-left"
                  onClick={() => panCanvasBy(-180, 0)}
                  title="Pan left"
                >
                  ←
                </button>
                <button
                  type="button"
                  className="pan-center"
                  onClick={fitSheetToViewport}
                  title="Fit sheet"
                >
                  ◎
                </button>
                <button
                  type="button"
                  className="pan-right"
                  onClick={() => panCanvasBy(180, 0)}
                  title="Pan right"
                >
                  →
                </button>
                <button
                  type="button"
                  className="pan-down"
                  onClick={() => panCanvasBy(0, 180)}
                  title="Pan down"
                >
                  ↓
                </button>
              </div>
            </div>
          </div>
        </section>

        <aside className="sidebar right-sidebar">
          <section className="panel-section">
            <h3>
              {selectionCount > 1
                ? `${selectionCount} selected layers`
                : "Selected layer"}
            </h3>
            {!selected ? (
              <p className="muted-text">
                Click a layer, or hold the left mouse button on empty sheet
                and drag a selection rectangle.
              </p>
            ) : selectionCount > 1 ? (
              <div className="group-selection-summary">
                <strong>{selectionCount} layers selected</strong>
                <span>
                  Drag any selected layer to move the entire group.
                </span>
                <span>
                  Shift + drag adds layers. Alt + drag removes layers.
                </span>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => applySelection([])}
                >
                  Deselect All
                </button>
              </div>
            ) : (
              <>
                <div className="selected-name">{selected.name}</div>
                <label>Width (cm)</label>
                <input
                  type="number"
                  min={MIN_ITEM_CM}
                  step="0.01"
                  value={selected.width_cm}
                  onChange={(event) =>
                    changeSelectedSize("width_cm", event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") saveSelectedSize();
                  }}
                />
                <label>Height (cm)</label>
                <input
                  type="number"
                  min={MIN_ITEM_CM}
                  step="0.01"
                  value={selected.height_cm}
                  onChange={(event) =>
                    changeSelectedSize("height_cm", event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") saveSelectedSize();
                  }}
                />
                <div className="ratio-mode-control">
                  <button
                    type="button"
                    className={`ratio-mode-button ${
                      selected.lock_ratio ? "active" : ""
                    }`}
                    aria-pressed={selected.lock_ratio}
                    onClick={() => setSelectedRatioLock(true)}
                  >
                    <span>🔒</span>
                    <b>Auto W/H</b>
                  </button>

                  <button
                    type="button"
                    className={`ratio-mode-button ${
                      !selected.lock_ratio ? "active" : ""
                    }`}
                    aria-pressed={!selected.lock_ratio}
                    onClick={() => setSelectedRatioLock(false)}
                  >
                    <span>🔓</span>
                    <b>Independent</b>
                  </button>
                </div>

                <p className="ratio-mode-help">
                  {selected.lock_ratio
                    ? "Locked: changing Height automatically changes Width, and changing Width changes Height."
                    : "Independent: changing Height keeps Width unchanged, and changing Width keeps Height unchanged."}
                </p>
                <button onClick={saveSelectedSize}>Save Size</button>
                <button
                  className="secondary-button"
                  onClick={() => selectedAction(api.rotateItem, "Rotating...", "Layer rotated 90°.")}
                >
                  Rotate 90°
                </button>
              </>
            )}
          </section>

          <section className="panel-section">
            <h3>Image version</h3>
            <button className="secondary-button" disabled={selectionCount !== 1} onClick={() => switchSource("original")}>
              Use Original
            </button>
            <button
              className="secondary-button"
              disabled={selectionCount !== 1 || !selected?.processed_url}
              onClick={() => switchSource("processed")}
            >
              Use Cleaned Image
            </button>
            <button
              className="secondary-button"
              disabled={selectionCount !== 1 || !selected?.upscaled_url}
              onClick={() => switchSource("upscaled")}
            >
              Use Upscaled Image
            </button>
          </section>

          <section className="panel-section">
            <h3>Sheet size & ruler</h3>

            <label>Sheet width (cm)</label>
            <input
              type="number"
              min="1"
              step="0.10"
              value={sheetWidthDraft}
              onChange={(event) =>
                setSheetWidthDraft(event.target.value)
              }
            />

            <label>Sheet height (cm)</label>
            <input
              type="number"
              min="1"
              step="0.10"
              value={sheetHeightDraft}
              onChange={(event) =>
                setSheetHeightDraft(event.target.value)
              }
            />

            <button
              type="button"
              onClick={saveManualSheetSize}
              disabled={busy}
            >
              Save Sheet Size
            </button>

            <button
              type="button"
              className="secondary-button"
              onClick={expandSheetToArtwork}
              disabled={busy || !items.length}
            >
              Expand Sheet to Artwork
            </button>

            <button
              type="button"
              className="secondary-button"
              onClick={cropSheetToArtwork}
              disabled={busy || !items.length}
            >
              Crop Sheet to Artwork
            </button>

            <label>Sheet color</label>
            <div className="sheet-color-tools">
              <input
                type="color"
                value={sheetColor}
                onChange={(event) => setSheetColor(event.target.value)}
                title="Choose sheet color"
              />
              <div className="sheet-color-swatches">
                {['#fffdf8', '#f6f0e4', '#f0f4ff', '#f5f5f5', '#151515'].map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`sheet-swatch ${sheetColor === color ? 'active' : ''}`}
                    style={{ background: color }}
                    onClick={() => setSheetColor(color)}
                    title={color}
                  />
                ))}
              </div>
            </div>

            <p className="sheet-size-help">
              Artwork can stay outside the white sheet. Expand includes it;
              Crop tightens the sheet around all layers.
            </p>
          </section>

          <section className="panel-section">
            <h3>Export for printing</h3>
            <label>Resolution</label>
            <select value={exportDpi} onChange={(event) => setExportDpi(Number(event.target.value))}>
              <option value={150}>150 DPI — faster</option>
              <option value={300}>300 DPI — print quality</option>
            </select>
            <button className="green-button" onClick={exportPng} disabled={busy || !items.length}>
              Export Transparent PNG
            </button>
            <button
              className="secondary-button"
              onClick={exportPsd}
              disabled={busy || !items.length}
            >
              Export Layered PSD
            </button>
          </section>

          <section className="panel-section">
            <h3>Layers</h3>
            <div className="layers-panel">
              {layerGroups.map((group) => {
                const everySelected = group.ids.every((id) =>
                  selectedIdSet.has(String(id)),
                );
                const expanded =
                  expandedLayerGroups[group.key] ?? group.items.length === 1;

                return (
                  <div key={group.key} className="layer-group-card">
                    <div className="layer-group-topline">
                      <button
                        type="button"
                        className="layer-group-toggle"
                        onClick={() => toggleLayerGroup(group.key)}
                        title={expanded ? "Collapse group" : "Expand group"}
                      >
                        {expanded ? "▾" : "▸"}
                      </button>

                      <button
                        type="button"
                        className={`layer-group-header ${everySelected ? "active" : ""}`}
                        onClick={() => applySelection(group.ids, group.ids[0])}
                      >
                        <span>
                          {group.items.length > 1 ? "📁" : "🖼️"} {group.name}
                        </span>
                        <b>{group.items.length}</b>
                      </button>
                    </div>

                    {expanded && (
                      <div className="layer-group-children">
                        {group.items.map((layer, layerIndex) => (
                          <button
                            key={layer.id}
                            type="button"
                            className={`layer-row ${
                              selectedIdSet.has(String(layer.id)) ? "active" : ""
                            }`}
                            onClick={() => applySelection([layer.id], layer.id)}
                          >
                            <span>Layer {layerIndex + 1}</span>
                            <small>
                              {round2(layer.width_cm)} × {round2(layer.height_cm)} cm
                            </small>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="panel-section danger-section">
            <button
              className="danger-button"
              onClick={() => deleteSelected(true)}
              disabled={!selectionCount || busy}
            >
              {selectionCount > 1
                ? `Delete ${selectionCount} Selected Layers`
                : "Delete This Layer"}
            </button>
          </section>
        </aside>
      </main>

      {newSheetOpen && (
        <div
          className="new-sheet-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeNewSheetDialog();
          }}
        >
          <div className="new-sheet-dialog" role="dialog" aria-modal="true">
            <div className="new-sheet-dialog-header">
              <div>
                <span>NEW DOCUMENT</span>
                <h2>Create New Print Sheet</h2>
              </div>
              <button type="button" onClick={closeNewSheetDialog} aria-label="Close">
                ×
              </button>
            </div>

            <div className="new-sheet-preview">
              <div
                className="new-sheet-preview-paper"
                style={{
                  aspectRatio: `${Math.max(numberValue(newSheetDraft.width_cm, 58), 1)} / ${Math.max(numberValue(newSheetDraft.height_cm, 100), 1)}`,
                }}
              />
              <span>New blank sheet</span>
            </div>

            <div className="new-sheet-fields">
              <label className="new-sheet-field full">
                <span>Sheet name</span>
                <input
                  autoFocus
                  value={newSheetDraft.name}
                  onChange={(event) =>
                    updateNewSheetDraft("name", event.target.value)
                  }
                />
              </label>

              <label className="new-sheet-field">
                <span>Width (cm)</span>
                <input
                  type="number"
                  min="1"
                  step="0.01"
                  value={newSheetDraft.width_cm}
                  onChange={(event) =>
                    updateNewSheetDraft("width_cm", event.target.value)
                  }
                />
              </label>

              <label className="new-sheet-field">
                <span>Height (cm)</span>
                <input
                  type="number"
                  min="1"
                  step="0.01"
                  value={newSheetDraft.height_cm}
                  onChange={(event) =>
                    updateNewSheetDraft("height_cm", event.target.value)
                  }
                />
              </label>

              <label className="new-sheet-field">
                <span>Spacing (cm)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={newSheetDraft.spacing_cm}
                  onChange={(event) =>
                    updateNewSheetDraft("spacing_cm", event.target.value)
                  }
                />
              </label>

              <label className="new-sheet-field">
                <span>Margin (cm)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={newSheetDraft.margin_cm}
                  onChange={(event) =>
                    updateNewSheetDraft("margin_cm", event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") createAndOpenNewSheet();
                  }}
                />
              </label>
            </div>

            <div className="new-sheet-dialog-actions">
              <button
                type="button"
                className="new-sheet-cancel"
                onClick={closeNewSheetDialog}
              >
                Cancel
              </button>
              <button
                type="button"
                className="new-sheet-create"
                onClick={createAndOpenNewSheet}
              >
                Save & Open Sheet
              </button>
            </div>
          </div>
        </div>
      )}

      {taskProgress && (
        <div className="task-progress-overlay">
          <div className="task-progress-card">
            <div
              className="task-progress-ring"
              style={{ "--progress": `${taskProgress.value}%` }}
            >
              <strong>{Math.round(taskProgress.value)}%</strong>
            </div>
            <div className="task-progress-copy">
              <h3>{taskProgress.label}</h3>
              <p>Please wait while Niron processes your artwork.</p>
              <div className="task-progress-bar">
                <span style={{ width: `${taskProgress.value}%` }} />
              </div>
            </div>
          </div>
        </div>
      )}

      <footer className="statusbar">
        <span className={busy ? "busy-dot" : "ready-dot"} />
        <span>{busy ? "Working..." : message || "Ready"}</span>
      </footer>

    </div>
  );
}

function SheetRuler({
  orientation,
  lengthCm,
  cmToPx,
  left,
  top,
}) {
  const ticks = [];
  const total = Math.max(0, Math.ceil(lengthCm));

  for (let value = 0; value <= total; value += 1) {
    const major = value % 5 === 0;
    ticks.push(
      <div
        key={`${orientation}-${value}`}
        className={`ruler-tick ${major ? "major" : "minor"}`}
        style={
          orientation === "horizontal"
            ? { left: value * cmToPx }
            : { top: value * cmToPx }
        }
      >
        {major && <span>{value}</span>}
      </div>,
    );
  }

  return (
    <div
      className={`sheet-ruler ${orientation}`}
      style={{
        left,
        top,
        width:
          orientation === "horizontal"
            ? lengthCm * cmToPx
            : 28,
        height:
          orientation === "vertical"
            ? lengthCm * cmToPx
            : 28,
      }}
    >
      {ticks}
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DirectItemEditor({
  item,
  endpoint,
  cropEndpoint,
  activeTool,
  onToolChange,
  onCancel,
  onApplied,
  displayWidthPx,
  displayHeightPx,
}) {
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const hitLayerRef = useRef(null);
  const originalDataRef = useRef(null);
  const selectionMaskRef = useRef(null);
  const historyRef = useRef([]);
  const historyIndexRef = useRef(-1);
  const drawingRef = useRef(false);
  const pointerStartRef = useRef(null);
  const cropRectRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("Loading artwork...");
  const [tolerance, setTolerance] = useState(35);
  const [feather, setFeather] = useState(2);
  const [contiguous, setContiguous] = useState(true);
  const [brushSize, setBrushSize] = useState(18);
  const [selectionPath, setSelectionPath] = useState([]);
  const [selectionCount, setSelectionCount] = useState(0);
  const [cropRect, setCropRect] = useState(null);
  const [cursor, setCursor] = useState({
    visible: false,
    x: 0,
    y: 0,
  });

  const currentUrl =
    item.image_url ||
    item.processed_url ||
    item.original_url;

  function currentImageData() {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    return canvas
      .getContext("2d", { willReadFrequently: true })
      .getImageData(0, 0, canvas.width, canvas.height);
  }

  function pushSnapshot(label = "") {
    const imageData = currentImageData();
    if (!imageData) return;

    const base = historyRef.current.slice(
      0,
      historyIndexRef.current + 1,
    );

    base.push(imageData);
    historyRef.current = base.slice(-30);
    historyIndexRef.current = historyRef.current.length - 1;

    if (label) setHint(label);
  }

  function restoreSnapshot(index) {
    const canvas = canvasRef.current;
    const imageData = historyRef.current[index];

    if (!canvas || !imageData) return;

    const context = canvas.getContext(
      "2d",
      { willReadFrequently: true },
    );

    context.putImageData(imageData, 0, 0);
    clearSelection();
    setCropRect(null);
    cropRectRef.current = null;
  }

  function undoEditor() {
    if (historyIndexRef.current <= 0) return;

    historyIndexRef.current -= 1;
    restoreSnapshot(historyIndexRef.current);
    setHint("Undo.");
  }

  function getPoint(event) {
    const layer = hitLayerRef.current;
    const canvas = canvasRef.current;

    if (!layer || !canvas) {
      return {
        x: 0,
        y: 0,
        viewX: 0,
        viewY: 0,
      };
    }

    const rect = layer.getBoundingClientRect();
    const localX = clamp(
      event.clientX - rect.left,
      0,
      rect.width,
    );
    const localY = clamp(
      event.clientY - rect.top,
      0,
      rect.height,
    );

    return {
      x: clamp(
        (localX / Math.max(rect.width, 1)) * canvas.width,
        0,
        canvas.width,
      ),
      y: clamp(
        (localY / Math.max(rect.height, 1)) * canvas.height,
        0,
        canvas.height,
      ),
      viewX: localX,
      viewY: localY,
    };
  }

  function updateCursor(event) {
    const point = getPoint(event);
    setCursor({
      visible: true,
      x: point.viewX,
      y: point.viewY,
    });
  }

  function clearSelection() {
    selectionMaskRef.current = null;
    setSelectionCount(0);
    setSelectionPath([]);

    const overlay = overlayRef.current;
    if (overlay) {
      overlay
        .getContext("2d")
        .clearRect(0, 0, overlay.width, overlay.height);
    }
  }

  function drawOverlay({
    mask = selectionMaskRef.current,
    path = selectionPath,
    crop = cropRectRef.current,
  } = {}) {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;

    if (!canvas || !overlay) return;

    overlay.width = canvas.width;
    overlay.height = canvas.height;

    const context = overlay.getContext("2d");
    context.clearRect(0, 0, overlay.width, overlay.height);

    if (mask && mask.length === canvas.width * canvas.height) {
      const preview = context.createImageData(
        canvas.width,
        canvas.height,
      );

      for (let pixel = 0; pixel < mask.length; pixel += 1) {
        if (!mask[pixel]) continue;

        const index = pixel * 4;
        preview.data[index] = 40;
        preview.data[index + 1] = 120;
        preview.data[index + 2] = 255;
        preview.data[index + 3] = 80;
      }

      context.putImageData(preview, 0, 0);

      context.save();
      context.fillStyle = "#ffffff";

      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          const pixel = y * canvas.width + x;
          if (!mask[pixel]) continue;

          const edge =
            x === 0 ||
            y === 0 ||
            x === canvas.width - 1 ||
            y === canvas.height - 1 ||
            !mask[pixel - 1] ||
            !mask[pixel + 1] ||
            !mask[pixel - canvas.width] ||
            !mask[pixel + canvas.width];

          if (edge && (x + y) % 5 < 3) {
            context.fillRect(x, y, 1, 1);
          }
        }
      }

      context.restore();
    }

    if (path && path.length >= 2) {
      context.save();
      context.setLineDash([7, 5]);
      context.lineWidth = Math.max(
        1,
        canvas.width / Math.max(displayWidthPx, 1),
      );
      context.strokeStyle = "#ffffff";
      context.beginPath();
      context.moveTo(path[0].x, path[0].y);

      for (let index = 1; index < path.length; index += 1) {
        context.lineTo(path[index].x, path[index].y);
      }

      context.closePath();
      context.stroke();
      context.lineDashOffset = -5;
      context.strokeStyle = "#111827";
      context.stroke();
      context.restore();
    }

    const normalized = normalizeCropRect(
      crop,
      canvas.width,
      canvas.height,
    );

    if (normalized && activeTool === "crop") {
      context.save();
      context.fillStyle = "rgba(0,0,0,.55)";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.clearRect(
        normalized.left,
        normalized.top,
        normalized.width,
        normalized.height,
      );

      context.strokeStyle = "#ffffff";
      context.lineWidth = Math.max(
        1,
        canvas.width / Math.max(displayWidthPx, 1),
      );
      context.setLineDash([7, 5]);
      context.strokeRect(
        normalized.left,
        normalized.top,
        normalized.width,
        normalized.height,
      );

      context.setLineDash([]);
      context.strokeStyle = "rgba(255,255,255,.72)";

      const thirdX = normalized.width / 3;
      const thirdY = normalized.height / 3;

      context.beginPath();
      context.moveTo(
        normalized.left + thirdX,
        normalized.top,
      );
      context.lineTo(
        normalized.left + thirdX,
        normalized.top + normalized.height,
      );
      context.moveTo(
        normalized.left + thirdX * 2,
        normalized.top,
      );
      context.lineTo(
        normalized.left + thirdX * 2,
        normalized.top + normalized.height,
      );
      context.moveTo(
        normalized.left,
        normalized.top + thirdY,
      );
      context.lineTo(
        normalized.left + normalized.width,
        normalized.top + thirdY,
      );
      context.moveTo(
        normalized.left,
        normalized.top + thirdY * 2,
      );
      context.lineTo(
        normalized.left + normalized.width,
        normalized.top + thirdY * 2,
      );
      context.stroke();
      context.restore();
    }
  }

  useEffect(() => {
    const image = new Image();
    image.crossOrigin = "anonymous";

    image.onload = () => {
      const canvas = canvasRef.current;
      const overlay = overlayRef.current;

      if (!canvas || !overlay) return;

      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      overlay.width = image.naturalWidth;
      overlay.height = image.naturalHeight;

      const context = canvas.getContext(
        "2d",
        { willReadFrequently: true },
      );

      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);

      originalDataRef.current = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      );

      historyRef.current = [];
      historyIndexRef.current = -1;
      pushSnapshot("Edit directly on this artwork.");
      clearSelection();
      setCropRect(null);
      cropRectRef.current = null;
      setReady(true);
    };

    image.onerror = () => {
      setHint("Could not load the selected artwork.");
    };

    image.src = currentUrl;
  }, [currentUrl]);

  useEffect(() => {
    clearSelection();
    setCropRect(null);
    cropRectRef.current = null;
    setHint(`${activeTool.toUpperCase()} tool is ready.`);
  }, [activeTool]);

  useEffect(() => {
    function handleKeys(event) {
      const key = event.key.toLowerCase();

      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }

      if (event.ctrlKey && key === "z") {
        event.preventDefault();
        undoEditor();
        return;
      }

      if (event.ctrlKey && key === "d") {
        event.preventDefault();
        clearSelection();
        setHint("Selection released.");
        return;
      }

      if (
        event.key === "Delete" ||
        event.key === "Backspace"
      ) {
        if (selectionMaskRef.current) {
          event.preventDefault();
          deleteSelectedArea();
        }
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        if (activeTool === "crop") {
          applyCrop();
        } else {
          applyImage();
        }
        return;
      }

      if (key === "v") onToolChange("move");
      if (key === "c") onToolChange("crop");
      if (key === "w") onToolChange("wand");
      if (key === "l") onToolChange("lasso");
      if (key === "p") onToolChange("polygon");

      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        onToolChange("restore");
      }

      if (event.key === "-") {
        event.preventDefault();
        onToolChange("erase");
      }

      if (event.key === "[") {
        event.preventDefault();
        setBrushSize((value) =>
          clamp(value - 1, 1, 400),
        );
      }

      if (event.key === "]") {
        event.preventDefault();
        setBrushSize((value) =>
          clamp(value + 1, 1, 400),
        );
      }
    }

    window.addEventListener("keydown", handleKeys);
    return () =>
      window.removeEventListener("keydown", handleKeys);
  }, [activeTool, selectionCount]);

  function smartSelectWhiteBackground() {
    const imageData = currentImageData();
    if (!imageData) return;

    const mask = buildBorderBackgroundMask(
      imageData,
      Number(tolerance),
    );

    selectionMaskRef.current = mask;
    const total = countMask(mask);
    setSelectionCount(total);
    setSelectionPath([]);
    drawOverlay({
      mask,
      path: [],
      crop: null,
    });

    setHint(
      total
        ? `${total.toLocaleString()} white-background pixels selected. Press Delete.`
        : "No connected white background was found.",
    );
  }

  function selectMagicWand(event) {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const point = getPoint(event);
    const imageData = currentImageData();
    if (!imageData) return;

    const mask = buildMagicWandMask(
      imageData,
      Math.floor(point.x),
      Math.floor(point.y),
      Number(tolerance),
      contiguous,
    );

    selectionMaskRef.current = mask;
    const total = countMask(mask);
    setSelectionCount(total);
    setSelectionPath([]);
    drawOverlay({
      mask,
      path: [],
      crop: null,
    });

    setHint(
      total
        ? `${total.toLocaleString()} pixels selected. Press Delete.`
        : "Nothing was selected.",
    );
  }

  function buildPathMask(points) {
    const canvas = canvasRef.current;
    if (!canvas || points.length < 3) return null;

    const maskCanvas = ensureOffscreenCanvas(
      canvas.width,
      canvas.height,
    );

    const context = maskCanvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);

    for (let index = 1; index < points.length; index += 1) {
      context.lineTo(points[index].x, points[index].y);
    }

    context.closePath();
    context.fill();

    const alpha = context
      .getImageData(0, 0, canvas.width, canvas.height)
      .data;

    const mask = new Uint8Array(
      canvas.width * canvas.height,
    );

    for (let pixel = 0; pixel < mask.length; pixel += 1) {
      if (alpha[pixel * 4 + 3] > 0) {
        mask[pixel] = 1;
      }
    }

    return mask;
  }

  function finishPathSelection(points) {
    const mask = buildPathMask(points);
    if (!mask) return;

    selectionMaskRef.current = mask;
    const total = countMask(mask);
    setSelectionCount(total);
    setSelectionPath(points);
    drawOverlay({
      mask,
      path: points,
      crop: null,
    });

    setHint(
      `${total.toLocaleString()} pixels selected. Press Delete.`,
    );
  }

  function deleteSelectedArea() {
    const canvas = canvasRef.current;
    const mask = selectionMaskRef.current;

    if (!canvas || !mask) {
      setHint("Create a selection first.");
      return;
    }

    const context = canvas.getContext(
      "2d",
      { willReadFrequently: true },
    );

    const imageData = context.getImageData(
      0,
      0,
      canvas.width,
      canvas.height,
    );

    applyMaskTransparency(
      imageData,
      mask,
      Number(feather),
    );

    context.putImageData(imageData, 0, 0);
    pushSnapshot("Selected pixels removed.");
    clearSelection();
  }

  function restoreSelectedArea() {
    const canvas = canvasRef.current;
    const mask = selectionMaskRef.current;
    const original = originalDataRef.current;

    if (!canvas || !mask || !original) {
      setHint("Create a selection first.");
      return;
    }

    const context = canvas.getContext(
      "2d",
      { willReadFrequently: true },
    );

    const current = context.getImageData(
      0,
      0,
      canvas.width,
      canvas.height,
    );

    for (let pixel = 0; pixel < mask.length; pixel += 1) {
      if (!mask[pixel]) continue;

      const index = pixel * 4;
      current.data[index] = original.data[index];
      current.data[index + 1] = original.data[index + 1];
      current.data[index + 2] = original.data[index + 2];
      current.data[index + 3] = original.data[index + 3];
    }

    context.putImageData(current, 0, 0);
    pushSnapshot("Selected pixels restored.");
    clearSelection();
  }

  function applyBrush(point) {
    const canvas = canvasRef.current;
    const original = originalDataRef.current;

    if (!canvas || !original) return;

    const context = canvas.getContext(
      "2d",
      { willReadFrequently: true },
    );

    if (activeTool === "erase") {
      context.save();
      context.globalCompositeOperation = "destination-out";
      context.beginPath();
      context.arc(
        point.x,
        point.y,
        brushSize,
        0,
        Math.PI * 2,
      );
      context.fill();
      context.restore();
      return;
    }

    if (activeTool === "restore") {
      const originalCanvas = ensureOffscreenCanvas(
        canvas.width,
        canvas.height,
      );

      originalCanvas
        .getContext("2d")
        .putImageData(original, 0, 0);

      context.save();
      context.beginPath();
      context.arc(
        point.x,
        point.y,
        brushSize,
        0,
        Math.PI * 2,
      );
      context.clip();
      context.drawImage(originalCanvas, 0, 0);
      context.restore();
    }
  }

  function onPointerDown(event) {
    event.stopPropagation();

    if (!ready || busy) return;

    event.currentTarget.setPointerCapture?.(
      event.pointerId,
    );

    updateCursor(event);
    const point = getPoint(event);

    if (activeTool === "wand") {
      selectMagicWand(event);
      return;
    }

    if (activeTool === "crop") {
      clearSelection();
      pointerStartRef.current = {
        x: point.x,
        y: point.y,
      };
      drawingRef.current = true;

      const next = {
        x1: point.x,
        y1: point.y,
        x2: point.x,
        y2: point.y,
      };

      cropRectRef.current = next;
      setCropRect(next);
      drawOverlay({
        mask: null,
        path: [],
        crop: next,
      });
      return;
    }

    if (activeTool === "lasso") {
      clearSelection();
      drawingRef.current = true;
      const next = [{ x: point.x, y: point.y }];
      setSelectionPath(next);
      drawOverlay({
        mask: null,
        path: next,
        crop: null,
      });
      return;
    }

    if (activeTool === "polygon") {
      const next = [
        ...selectionPath,
        { x: point.x, y: point.y },
      ];

      setSelectionPath(next);
      drawOverlay({
        mask: null,
        path: next,
        crop: null,
      });

      setHint(
        next.length < 3
          ? "Add at least three polygon points."
          : "Double-click to close the polygon.",
      );
      return;
    }

    if (
      activeTool === "erase" ||
      activeTool === "restore"
    ) {
      drawingRef.current = true;
      applyBrush(point);
    }
  }

  function onPointerMove(event) {
    updateCursor(event);

    if (!drawingRef.current || !ready || busy) return;

    const point = getPoint(event);

    if (activeTool === "crop") {
      const start = pointerStartRef.current;
      if (!start) return;

      const next = {
        x1: start.x,
        y1: start.y,
        x2: point.x,
        y2: point.y,
      };

      cropRectRef.current = next;
      setCropRect(next);
      drawOverlay({
        mask: null,
        path: [],
        crop: next,
      });
      return;
    }

    if (activeTool === "lasso") {
      setSelectionPath((current) => {
        const next = [
          ...current,
          { x: point.x, y: point.y },
        ];

        drawOverlay({
          mask: null,
          path: next,
          crop: null,
        });

        return next;
      });
      return;
    }

    if (
      activeTool === "erase" ||
      activeTool === "restore"
    ) {
      applyBrush(point);
    }
  }

  function onPointerUp(event) {
    event.stopPropagation();

    if (!drawingRef.current) return;
    drawingRef.current = false;

    if (activeTool === "crop") {
      pointerStartRef.current = null;
      const normalized = normalizeCropRect(
        cropRectRef.current,
        canvasRef.current?.width || 0,
        canvasRef.current?.height || 0,
      );

      setHint(
        normalized
          ? `Crop ready: ${normalized.width} × ${normalized.height}px. Press Enter or Apply.`
          : "Drag a crop rectangle.",
      );
      return;
    }

    if (activeTool === "lasso") {
      finishPathSelection(selectionPath);
      return;
    }

    if (
      activeTool === "erase" ||
      activeTool === "restore"
    ) {
      pushSnapshot(
        activeTool === "erase"
          ? "Remove brush applied."
          : "Restore brush applied.",
      );
    }
  }

  function onDoubleClick(event) {
    if (activeTool !== "polygon") return;

    event.preventDefault();
    event.stopPropagation();

    const point = getPoint(event);
    const points = [
      ...selectionPath,
      { x: point.x, y: point.y },
    ];

    setSelectionPath(points);
    finishPathSelection(points);
  }

  function resetImage() {
    const canvas = canvasRef.current;
    const original = originalDataRef.current;

    if (!canvas || !original) return;

    canvas
      .getContext("2d", { willReadFrequently: true })
      .putImageData(original, 0, 0);

    historyRef.current = [];
    historyIndexRef.current = -1;
    pushSnapshot("Image reset.");
    clearSelection();
    setCropRect(null);
    cropRectRef.current = null;
  }

  async function applyImage() {
    const canvas = canvasRef.current;
    if (!canvas) return;

    setBusy(true);
    setHint("Saving transparent PNG...");

    try {
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );

      if (!blob) {
        throw new Error("Could not create PNG.");
      }

      const form = new FormData();
      form.append("file", blob, "direct-edit.png");

      await readJson(
        await fetch(endpoint, {
          method: "POST",
          body: form,
        }),
      );

      await onApplied(
        "Direct pixel editing saved and transparent bounds tightened.",
      );
    } catch (error) {
      setHint(error.message || "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  async function applyCrop() {
    const canvas = canvasRef.current;
    const normalized = normalizeCropRect(
      cropRectRef.current || cropRect,
      canvas?.width || 0,
      canvas?.height || 0,
    );

    if (!canvas || !normalized) {
      setHint("Drag a crop rectangle first.");
      return;
    }

    if (!cropEndpoint) {
      setHint("Crop API is unavailable.");
      return;
    }

    setBusy(true);
    setHint("Cropping and tightening the layer...");

    try {
      const cropCanvas = ensureOffscreenCanvas(
        normalized.width,
        normalized.height,
      );

      cropCanvas
        .getContext("2d", { willReadFrequently: true })
        .drawImage(
          canvas,
          normalized.left,
          normalized.top,
          normalized.width,
          normalized.height,
          0,
          0,
          normalized.width,
          normalized.height,
        );

      const blob = await new Promise((resolve) =>
        cropCanvas.toBlob(resolve, "image/png"),
      );

      if (!blob) {
        throw new Error("Could not create cropped PNG.");
      }

      const form = new FormData();
      form.append("file", blob, "direct-crop.png");
      form.append("source_width", String(canvas.width));
      form.append("source_height", String(canvas.height));
      form.append("left", String(normalized.left));
      form.append("top", String(normalized.top));
      form.append("crop_width", String(normalized.width));
      form.append("crop_height", String(normalized.height));

      const response = await fetch(cropEndpoint, {
        method: "POST",
        body: form,
      });
      const result = await readJson(response);

      if (!result?.ok || !result?.item) {
        throw new Error("The crop endpoint did not return the updated layer.");
      }

      setHint("Crop saved. Reloading the tightened layer...");
      await onApplied("Crop saved and layer box tightened.");
    } catch (error) {
      const message = error.message || "Crop failed.";
      setHint(message);
      window.alert(`Crop failed: ${message}`);
    } finally {
      setBusy(false);
    }
  }

  const brushScreenDiameter = Math.max(
    14,
    (brushSize * 2 * displayWidthPx) /
      Math.max(canvasRef.current?.width || 1, 1),
  );

  const cursorSymbol =
    activeTool === "erase"
      ? "−"
      : activeTool === "restore"
        ? "+"
        : activeTool === "lasso"
          ? "L"
          : activeTool === "polygon"
            ? "P"
            : activeTool === "crop"
              ? "C"
              : "W";

  const normalizedCrop = normalizeCropRect(
    cropRect,
    canvasRef.current?.width || 0,
    canvasRef.current?.height || 0,
  );

  const optionsPanel = createPortal(
    <div
      className="direct-editor-options"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <strong>{activeTool.toUpperCase()}</strong>
      <span className="direct-editor-hint">{hint}</span>

      {activeTool === "wand" && (
        <>
          <label>
            Tolerance
            <input
              type="range"
              min="0"
              max="150"
              value={tolerance}
              onChange={(event) =>
                setTolerance(event.target.value)
              }
            />
            <b>{tolerance}</b>
          </label>

          <label className="direct-check">
            <input
              type="checkbox"
              checked={contiguous}
              onChange={(event) =>
                setContiguous(event.target.checked)
              }
            />
            Connected only
          </label>

          <button onClick={smartSelectWhiteBackground}>
            Smart White
          </button>
        </>
      )}

      {(activeTool === "wand" ||
        activeTool === "lasso" ||
        activeTool === "polygon") && (
        <>
          <label>
            Feather
            <input
              type="range"
              min="0"
              max="12"
              value={feather}
              onChange={(event) =>
                setFeather(event.target.value)
              }
            />
            <b>{feather}px</b>
          </label>

          <button
            onClick={deleteSelectedArea}
            disabled={!selectionCount}
          >
            Delete Selection
          </button>

          <button
            onClick={restoreSelectedArea}
            disabled={!selectionCount}
          >
            Restore Selection
          </button>
        </>
      )}

      {(activeTool === "erase" ||
        activeTool === "restore") && (
        <label>
          Brush
          <button
            className="pixel-step"
            onClick={() =>
              setBrushSize((value) =>
                clamp(value - 1, 1, 400),
              )
            }
          >
            −1
          </button>
          <input
            type="range"
            min="1"
            max="400"
            value={brushSize}
            onChange={(event) =>
              setBrushSize(Number(event.target.value))
            }
          />
          <b>{brushSize}px</b>
          <button
            className="pixel-step"
            onClick={() =>
              setBrushSize((value) =>
                clamp(value + 1, 1, 400),
              )
            }
          >
            +1
          </button>
        </label>
      )}

      <button onClick={undoEditor}>Undo</button>
      <button onClick={clearSelection}>Deselect</button>
      <button onClick={resetImage}>Reset</button>

      <button
        className="direct-apply"
        onClick={
          activeTool === "crop"
            ? applyCrop
            : applyImage
        }
        disabled={
          busy ||
          (activeTool === "crop" && !normalizedCrop)
        }
      >
        {busy
          ? "Saving..."
          : activeTool === "crop"
            ? "Apply Crop"
            : "Apply"}
      </button>

      <button
        className="direct-cancel"
        onClick={onCancel}
        disabled={busy}
      >
        Cancel
      </button>
    </div>,
    document.body,
  );

  const permanentToolDock = createPortal(
    <div
      className="direct-editor-tool-dock"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={activeTool === "restore" ? "active restore-tool" : "restore-tool"}
        onClick={() => onToolChange("restore")}
        title="Restore pixels (+)"
      >
        <b>+</b>
        <span>Restore</span>
      </button>

      <button
        type="button"
        className={activeTool === "erase" ? "active remove-tool" : "remove-tool"}
        onClick={() => onToolChange("erase")}
        title="Remove pixels (-)"
      >
        <b>−</b>
        <span>Remove</span>
      </button>

      <button
        type="button"
        className={activeTool === "wand" ? "active" : ""}
        onClick={() => onToolChange("wand")}
        title="Magic Wand (W)"
      >
        <b>W</b>
        <span>Wand</span>
      </button>

      <button
        type="button"
        className={activeTool === "lasso" ? "active" : ""}
        onClick={() => onToolChange("lasso")}
        title="Lasso (L)"
      >
        <b>L</b>
        <span>Lasso</span>
      </button>

      <button
        type="button"
        className={activeTool === "polygon" ? "active" : ""}
        onClick={() => onToolChange("polygon")}
        title="Polygonal Lasso (P)"
      >
        <b>P</b>
        <span>Polygon</span>
      </button>

      <button
        type="button"
        onClick={undoEditor}
        title="Undo (Ctrl+Z)"
      >
        <b>↶</b>
        <span>Undo</span>
      </button>

      <button
        type="button"
        className="dock-apply"
        onClick={
          activeTool === "crop"
            ? applyCrop
            : applyImage
        }
        disabled={
          busy ||
          (activeTool === "crop" && !normalizedCrop)
        }
        title="Apply changes (Enter)"
      >
        <b>✓</b>
        <span>Apply</span>
      </button>

      <button
        type="button"
        className="dock-cancel"
        onClick={onCancel}
        disabled={busy}
        title="Cancel (Esc)"
      >
        <b>×</b>
        <span>Cancel</span>
      </button>
    </div>,
    document.body,
  );

  return (
    <>
      <canvas
        ref={canvasRef}
        className="direct-edit-canvas"
      />

      <canvas
        ref={overlayRef}
        className="direct-edit-overlay"
      />

      <div
        ref={hitLayerRef}
        className="direct-edit-hit-layer"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() =>
          setCursor((current) => ({
            ...current,
            visible: false,
          }))
        }
        onDoubleClick={onDoubleClick}
      />

      {normalizedCrop && activeTool === "crop" && (
        <div
          className="direct-crop-box"
          style={{
            left: `${
              (normalizedCrop.left /
                Math.max(canvasRef.current?.width || 1, 1)) *
              100
            }%`,
            top: `${
              (normalizedCrop.top /
                Math.max(canvasRef.current?.height || 1, 1)) *
              100
            }%`,
            width: `${
              (normalizedCrop.width /
                Math.max(canvasRef.current?.width || 1, 1)) *
              100
            }%`,
            height: `${
              (normalizedCrop.height /
                Math.max(canvasRef.current?.height || 1, 1)) *
              100
            }%`,
          }}
        >
          <span>
            {normalizedCrop.width} × {normalizedCrop.height}px
          </span>
        </div>
      )}

      {cursor.visible && (
        <div
          className="direct-pixel-cursor"
          style={{
            left: cursor.x,
            top: cursor.y,
            width:
              activeTool === "erase" ||
              activeTool === "restore"
                ? brushScreenDiameter
                : 24,
            height:
              activeTool === "erase" ||
              activeTool === "restore"
                ? brushScreenDiameter
                : 24,
          }}
        >
          <span>{cursorSymbol}</span>
        </div>
      )}

      {!ready && (
        <div className="direct-edit-loading">
          Loading pixels…
        </div>
      )}

      {optionsPanel}
      {permanentToolDock}
    </>
  );
}

function normalizeCropRect(rect, width, height) {
  if (!rect || width <= 0 || height <= 0) return null;

  const left = clamp(
    Math.round(Math.min(rect.x1, rect.x2)),
    0,
    Math.max(width - 1, 0),
  );

  const top = clamp(
    Math.round(Math.min(rect.y1, rect.y2)),
    0,
    Math.max(height - 1, 0),
  );

  const right = clamp(
    Math.round(Math.max(rect.x1, rect.x2)),
    left + 1,
    width,
  );

  const bottom = clamp(
    Math.round(Math.max(rect.y1, rect.y2)),
    top + 1,
    height,
  );

  const cropWidth = right - left;
  const cropHeight = bottom - top;

  if (cropWidth < 2 || cropHeight < 2) return null;

  return {
    left,
    top,
    width: cropWidth,
    height: cropHeight,
  };
}

function countMask(mask) {
  let total = 0;
  for (let index = 0; index < mask.length; index += 1) {
    total += mask[index] ? 1 : 0;
  }
  return total;
}

function isNearWhitePixel(data, pixel, tolerance) {
  const index = pixel * 4;
  const red = data[index];
  const green = data[index + 1];
  const blue = data[index + 2];
  const alpha = data[index + 3];
  if (alpha <= 4) return false;

  const minimum = Math.min(red, green, blue);
  const maximum = Math.max(red, green, blue);
  const floor = clamp(252 - tolerance * 1.5, 170, 250);
  const allowedChroma = clamp(12 + tolerance * 0.7, 12, 90);
  return minimum >= floor && maximum - minimum <= allowedChroma;
}

function buildBorderBackgroundMask(imageData, tolerance) {
  const { data, width, height } = imageData;
  const total = width * height;
  const selected = new Uint8Array(total);
  const seen = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  function enqueue(pixel) {
    if (pixel < 0 || pixel >= total || seen[pixel]) return;
    seen[pixel] = 1;
    if (!isNearWhitePixel(data, pixel, tolerance)) return;
    queue[tail++] = pixel;
  }

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (head < tail) {
    const pixel = queue[head++];
    selected[pixel] = 1;
    const x = pixel % width;
    const y = Math.floor(pixel / width);

    if (x > 0) enqueue(pixel - 1);
    if (x + 1 < width) enqueue(pixel + 1);
    if (y > 0) enqueue(pixel - width);
    if (y + 1 < height) enqueue(pixel + width);
  }

  return selected;
}

function buildMagicWandMask(imageData, seedX, seedY, tolerance, contiguous) {
  const { data, width, height } = imageData;
  const totalPixels = width * height;
  const selected = new Uint8Array(totalPixels);

  if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) {
    return selected;
  }

  const seedPixel = seedY * width + seedX;
  const seedIndex = seedPixel * 4;
  const targetRed = data[seedIndex];
  const targetGreen = data[seedIndex + 1];
  const targetBlue = data[seedIndex + 2];
  const targetAlpha = data[seedIndex + 3];
  const threshold = Math.max(0, tolerance) * 2.2;

  function matches(pixel) {
    const index = pixel * 4;
    const red = data[index] - targetRed;
    const green = data[index + 1] - targetGreen;
    const blue = data[index + 2] - targetBlue;
    const alpha = data[index + 3] - targetAlpha;
    return Math.sqrt(red * red + green * green + blue * blue + alpha * alpha * 0.15) <= threshold;
  }

  if (!contiguous) {
    for (let pixel = 0; pixel < totalPixels; pixel += 1) {
      if (matches(pixel)) selected[pixel] = 1;
    }
    return selected;
  }

  const seen = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);
  let head = 0;
  let tail = 0;
  queue[tail++] = seedPixel;
  seen[seedPixel] = 1;

  while (head < tail) {
    const pixel = queue[head++];
    if (!matches(pixel)) continue;
    selected[pixel] = 1;

    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const neighbors = [
      x > 0 ? pixel - 1 : -1,
      x + 1 < width ? pixel + 1 : -1,
      y > 0 ? pixel - width : -1,
      y + 1 < height ? pixel + width : -1,
    ];

    for (const neighbor of neighbors) {
      if (neighbor >= 0 && !seen[neighbor]) {
        seen[neighbor] = 1;
        queue[tail++] = neighbor;
      }
    }
  }

  return selected;
}

function applyMaskTransparency(imageData, mask, feather) {
  const { data, width, height } = imageData;
  const radius = clamp(Number(feather) || 0, 0, 12);

  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (mask[pixel]) data[pixel * 4 + 3] = 0;
  }

  if (radius <= 0) return;

  const softened = new Uint8ClampedArray(mask.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (mask[pixel]) continue;

      let nearest = radius + 1;
      for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
        const checkY = y + offsetY;
        if (checkY < 0 || checkY >= height) continue;
        for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
          const checkX = x + offsetX;
          if (checkX < 0 || checkX >= width) continue;
          const checkPixel = checkY * width + checkX;
          if (!mask[checkPixel]) continue;
          nearest = Math.min(nearest, Math.sqrt(offsetX * offsetX + offsetY * offsetY));
        }
      }

      if (nearest <= radius) {
        softened[pixel] = Math.round((nearest / (radius + 1)) * 255);
      }
    }
  }

  for (let pixel = 0; pixel < softened.length; pixel += 1) {
    if (!softened[pixel]) continue;
    const alphaIndex = pixel * 4 + 3;
    data[alphaIndex] = Math.min(data[alphaIndex], softened[pixel]);
  }
}


const DIRECT_EDIT_CSS = `
  .sheet-item.pixel-editing {
    border: 2px solid #1d4ed8 !important;
    box-shadow:
      0 0 0 2px rgba(29, 78, 216, .22),
      0 0 24px rgba(29, 78, 216, .24);
    cursor: none !important;
  }

  .sheet-item.pixel-editing .image-frame {
    overflow: visible;
    background-image:
      linear-gradient(45deg, #dedede 25%, transparent 25%),
      linear-gradient(-45deg, #dedede 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #dedede 75%),
      linear-gradient(-45deg, transparent 75%, #dedede 75%);
    background-position:
      0 0,
      0 8px,
      8px -8px,
      -8px 0;
    background-size: 16px 16px;
  }

  .direct-edit-canvas,
  .direct-edit-overlay,
  .direct-edit-hit-layer {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }

  .direct-edit-canvas {
    z-index: 2;
    display: block;
  }

  .direct-edit-overlay {
    z-index: 3;
    pointer-events: none;
  }

  .direct-edit-hit-layer {
    z-index: 4;
    cursor: none;
    touch-action: none;
  }

  .direct-edit-loading {
    position: absolute;
    inset: 0;
    z-index: 8;
    display: grid;
    place-items: center;
    color: white;
    background: rgba(17, 24, 39, .64);
    font-size: 12px;
    font-weight: 900;
  }

  .direct-pixel-cursor {
    position: absolute;
    z-index: 10;
    display: grid;
    place-items: center;
    min-width: 18px;
    min-height: 18px;
    border: 1px solid #111827;
    border-radius: 999px;
    background: rgba(255, 255, 255, .08);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, .94),
      0 0 5px rgba(0, 0, 0, .4);
    pointer-events: none;
    transform: translate(-50%, -50%);
  }

  .direct-pixel-cursor span {
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: white;
    background: rgba(17, 24, 39, .92);
    font-size: 11px;
    font-weight: 950;
  }

  .direct-crop-box {
    position: absolute;
    z-index: 7;
    border: 1px dashed white;
    box-shadow:
      0 0 0 9999px rgba(0, 0, 0, .48),
      inset 0 0 0 1px rgba(17, 24, 39, .8);
    pointer-events: none;
  }

  .direct-crop-box::before,
  .direct-crop-box::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .direct-crop-box::before {
    background:
      linear-gradient(
        to right,
        transparent 33.2%,
        rgba(255,255,255,.7) 33.2%,
        rgba(255,255,255,.7) 33.7%,
        transparent 33.7%,
        transparent 66.2%,
        rgba(255,255,255,.7) 66.2%,
        rgba(255,255,255,.7) 66.7%,
        transparent 66.7%
      );
  }

  .direct-crop-box::after {
    background:
      linear-gradient(
        to bottom,
        transparent 33.2%,
        rgba(255,255,255,.7) 33.2%,
        rgba(255,255,255,.7) 33.7%,
        transparent 33.7%,
        transparent 66.2%,
        rgba(255,255,255,.7) 66.2%,
        rgba(255,255,255,.7) 66.7%,
        transparent 66.7%
      );
  }

  .direct-crop-box span {
    position: absolute;
    left: 4px;
    top: 4px;
    padding: 3px 5px;
    border-radius: 5px;
    color: white;
    background: rgba(17, 24, 39, .86);
    font-size: 9px;
    font-weight: 900;
    white-space: nowrap;
  }

  .direct-editor-options {
    position: fixed;
    left: 50%;
    top: 12px;
    z-index: 2147483001;
    min-height: 44px;
    max-width: calc(100vw - 28px);
    max-height: 78px;
    overflow-x: auto;
    overflow-y: hidden;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 8px 10px;
    border: 1px solid #151515;
    border-radius: 11px;
    color: white;
    background:
      linear-gradient(180deg, #454545, #2f2f2f);
    box-shadow: 0 10px 32px rgba(0, 0, 0, .35);
    transform: translateX(-50%);
    white-space: nowrap;
    scrollbar-width: thin;
  }

  .direct-editor-options > strong {
    flex: 0 0 auto;
    min-width: 64px;
    color: #f4edc5;
    font-size: 11px;
  }

  .direct-editor-hint {
    max-width: 250px;
    overflow: hidden;
    color: #e6e6e6;
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .direct-editor-options label {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 5px;
    color: #f0f0f0;
    font-size: 10px;
    font-weight: 800;
  }

  .direct-editor-options input[type="range"] {
    width: 86px;
    accent-color: #d7b47a;
  }

  .direct-editor-options button {
    flex: 0 0 auto;
    width: auto;
    min-height: 30px;
    margin: 0;
    padding: 5px 8px;
    border: 1px solid #676767;
    border-radius: 7px;
    color: white;
    background: #555;
    font-size: 10px;
    font-weight: 850;
  }

  .direct-editor-options button:hover:not(:disabled) {
    background: #666;
  }

  .direct-editor-options button:disabled {
    opacity: .4;
  }

  .direct-editor-options .direct-apply {
    border-color: #357a4e;
    background: #285c3b;
  }

  .direct-editor-options .direct-cancel {
    border-color: #8e4b46;
    background: #7b332d;
  }

  .direct-editor-options .pixel-step {
    min-width: 30px;
    padding-inline: 5px;
  }

  .direct-check input {
    accent-color: #d7b47a;
  }

  .direct-editor-tool-dock {
    position: fixed;
    right: 14px;
    top: 50%;
    z-index: 2147483000;
    display: grid;
    grid-template-columns: 68px 68px;
    gap: 7px;
    padding: 9px;
    border: 1px solid rgba(0, 0, 0, .62);
    border-radius: 15px;
    color: white;
    background: rgba(42, 42, 42, .94);
    box-shadow: 0 14px 38px rgba(0, 0, 0, .38);
    backdrop-filter: blur(8px);
    transform: translateY(-50%);
  }

  .direct-editor-tool-dock button {
    width: 68px;
    min-height: 54px;
    display: grid;
    place-items: center;
    gap: 2px;
    margin: 0;
    padding: 5px;
    border: 1px solid #666;
    border-radius: 9px;
    color: white;
    background: #505050;
    font-size: 10px;
    font-weight: 850;
  }

  .direct-editor-tool-dock button:hover:not(:disabled) {
    background: #666;
  }

  .direct-editor-tool-dock button.active {
    border-color: #f4edc5;
    background: #272727;
    box-shadow: 0 0 0 2px rgba(244, 237, 197, .25);
  }

  .direct-editor-tool-dock button b {
    font-size: 20px;
    line-height: 1;
  }

  .direct-editor-tool-dock button span {
    font-size: 9px;
    line-height: 1;
  }

  .direct-editor-tool-dock .restore-tool {
    border-color: #4f8d68;
    background: #37674a;
  }

  .direct-editor-tool-dock .remove-tool {
    border-color: #a46b66;
    background: #74423e;
  }

  .direct-editor-tool-dock .dock-apply {
    border-color: #4c9d69;
    background: #28633d;
  }

  .direct-editor-tool-dock .dock-cancel {
    border-color: #a7534b;
    background: #7b332d;
  }

  @media (max-width: 1050px) {
    .direct-editor-options {
      top: 64px;
      width: calc(100vw - 20px);
      overflow-x: auto;
      justify-content: flex-start;
    }

    .direct-editor-hint {
      display: none;
    }
  }
`;

function handleStyle(cursor, left, top, bottom, right) {
  return {
    width: 16,
    height: 16,
    borderRadius: 99,
    background: "#111827",
    border: "2px solid white",
    cursor,
    left,
    top,
    bottom,
    right,
    transform: left === "50%" ? "translateX(-50%)" : top === "50%" ? "translateY(-50%)" : undefined,
  };
}

function cornerHandle(cursor, top, left, bottom, right) {
  return {
    width: 18,
    height: 18,
    borderRadius: 3,
    background: "#111827",
    border: "2px solid white",
    cursor,
    top,
    left,
    bottom,
    right,
  };
}

const hiddenHandles = {
  top: { display: "none" },
  right: { display: "none" },
  bottom: { display: "none" },
  left: { display: "none" },
  topRight: { display: "none" },
  bottomRight: { display: "none" },
  bottomLeft: { display: "none" },
  topLeft: { display: "none" },
};
