
const output = document.getElementById("output");
const startXRBtn = document.getElementById("startXR");
const surfaceStatus = document.getElementById("surface-status");
const bottomBar = document.getElementById("bottom-bar");
const captureBtn = document.getElementById("capture");
const aiBtn = document.getElementById("ai-button");
const confirmBtn = document.getElementById("confirm-save");
const discardBtn = document.getElementById("discard");
const photoCountLabel = document.getElementById("photo-count-label");

const captureCanvas = document.getElementById("captureCanvas");
const liveLayer = document.getElementById("live-layer");
const liveCanvas = document.getElementById("liveCanvas");
const freezeLayer = document.getElementById("freeze-layer");
const viewCanvas = document.getElementById("viewCanvas");

const liveGuide = document.getElementById("live-guide");
const frozenGuide = document.getElementById("frozen-guide");

let pendingOutputMetricsFrame = null;

function updateOutputMetrics() {
  if (pendingOutputMetricsFrame !== null) return;

  pendingOutputMetricsFrame = requestAnimationFrame(() => {
    pendingOutputMetricsFrame = null;
    output.style.setProperty("--output-half-height", `${output.offsetHeight / 2}px`);
  });
}

new MutationObserver(updateOutputMetrics).observe(output, {
  childList: true,
  characterData: true,
  subtree: true
});

if ("ResizeObserver" in window) {
  new ResizeObserver(updateOutputMetrics).observe(output);
}

updateOutputMetrics();

let isFrozen = false;
let xrSession = null;
let xrCanvas = null;
let gl = null;
let glBinding = null;
let refSpace = null;
let viewerSpace = null;
let hitTestSource = null;

let currentPose = null;
let currentIntrinsics = null;

let initialized = false;
let initializing = false;
let cameraFeedReady = false;
let floorRecognized = false;
let pendingCapture = false;
let orientationLayoutEnabled = false;

let copyProgram = null;
let quadBuffer = null;
let copyTexture = null;
let copyFramebuffer = null;

let lastCapturedROI = null;
let currentROI = null;
let guideSelection = { x: 0.12, y: 0.12, w: 0.76, h: 0.76 };
let activeGuideDrag = null;
let savedPhotoCount = 0;
let continueMode = false;

const ORIENTATION_BODY_CLASSES = [
  "orientation-portrait-primary",
  "orientation-portrait-secondary",
  "orientation-landscape-primary",
  "orientation-landscape-secondary"
];

const OUTPUT_ROTATION_CLASSES = [
  "output-rotate-ccw",
  "output-rotate-cw"
];

const PHONE_BOTTOM_CLASSES = [
  "phone-bottom-left",
  "phone-bottom-right"
];

function isDeviceLandscape(info = currentScreenOrientation || getScreenOrientationInfo(), xrDeviceOrientation = currentXRDeviceOrientation) {
  return isXRDeviceLandscape(xrDeviceOrientation) || info.label === "横屏";
}

function updateOrientationLayout(info = getScreenOrientationInfo(), xrDeviceOrientation = currentXRDeviceOrientation) {
  const orientationClass = getOrientationClass(info);
  const outputRotationClass = getOutputRotationClassFromXR(xrDeviceOrientation) || getOutputRotationClass(info);
  const landscape = isDeviceLandscape(info, xrDeviceOrientation);
  const phoneBottomClass = orientationLayoutEnabled && landscape
  ? getPhoneBottomClass(info, xrDeviceOrientation)
  : "";

  currentScreenOrientation = info;
  document.body.classList.toggle("landscape-layout", landscape);
  document.body.classList.toggle("portrait-layout", !landscape);

  if (
    orientationClass !== currentOrientationClass ||
    outputRotationClass !== currentOutputRotationClass ||
    phoneBottomClass !== currentPhoneBottomClass
  ) {
    document.body.classList.remove(...ORIENTATION_BODY_CLASSES, ...OUTPUT_ROTATION_CLASSES, ...PHONE_BOTTOM_CLASSES);
    document.body.classList.add(orientationClass);

    if (outputRotationClass) {
      document.body.classList.add(outputRotationClass);
    }

    if (phoneBottomClass) {
      document.body.classList.add(phoneBottomClass);
    }

    currentOrientationClass = orientationClass;
    currentOutputRotationClass = outputRotationClass;
    currentPhoneBottomClass = phoneBottomClass;
  }
}

let currentScreenOrientation = null;
let currentXRDeviceOrientation = null;
let currentOrientationClass = "";
let currentOutputRotationClass = "";
let currentPhoneBottomClass = "";

function getScreenOrientationInfo() {
  const orientation = screen.orientation || screen.mozOrientation || screen.msOrientation;
  const type = orientation && orientation.type ? orientation.type : "";
  const hasOrientationAngle = orientation && typeof orientation.angle === "number";
  const hasWindowAngle = typeof window.orientation === "number";
  const angle = hasOrientationAngle
    ? orientation.angle
    : (hasWindowAngle ? window.orientation : null);
  const normalizedAngle = angle === null ? null : ((angle % 360) + 360) % 360;
  const isLandscape = type
    ? type.startsWith("landscape")
    : (normalizedAngle === null
      ? window.innerWidth >= window.innerHeight
      : normalizedAngle === 90 || normalizedAngle === 270);

  return {
    label: isLandscape ? "横屏" : "竖屏",
    type: type || (isLandscape ? "landscape-fallback" : "portrait-fallback"),
    angle
  };
}

function updatePhotoCountLabel() {
  photoCountLabel.textContent = `写真${savedPhotoCount}枚目`;
}

function getScreenOrientationLabel() {
  return (currentScreenOrientation || getScreenOrientationInfo()).label;
}

function getNormalizedOrientationAngle(info) {
  if (!info || typeof info.angle !== "number") {
    return null;
  }

  return ((info.angle % 360) + 360) % 360;
}

function getOrientationClass(info) {
  const type = info.type || "";
  if (type.startsWith("portrait-primary")) return "orientation-portrait-primary";
  if (type.startsWith("portrait-secondary")) return "orientation-portrait-secondary";
  if (type.startsWith("landscape-primary")) return "orientation-landscape-primary";
  if (type.startsWith("landscape-secondary")) return "orientation-landscape-secondary";

  const angle = getNormalizedOrientationAngle(info);
  if (info.label === "横屏") {
    return angle === 270 ? "orientation-landscape-secondary" : "orientation-landscape-primary";
  }

  return angle === 180 ? "orientation-portrait-secondary" : "orientation-portrait-primary";
}

function getOutputRotationClass(info) {
  const viewportIsLandscape = window.innerWidth >= window.innerHeight;
  if (info.label !== "横屏" || viewportIsLandscape) {
    return "";
  }

  const angle = getNormalizedOrientationAngle(info);
  const type = info.type || "";
  return angle === 270 || type.startsWith("landscape-secondary")
    ? "output-rotate-cw"
    : "output-rotate-ccw";
}

function isXRDeviceLandscape(xrDeviceOrientation) {
  if (!xrDeviceOrientation) {
    return false;
  }

  return Math.abs(xrDeviceOrientation.right.y) > Math.abs(xrDeviceOrientation.up.y);
}

function getPhoneBottomClass(info, xrDeviceOrientation) {
  if (isXRDeviceLandscape(xrDeviceOrientation)) {
    return xrDeviceOrientation.right.y >= 0
      ? "phone-bottom-right"
      : "phone-bottom-left";
  }

  if (info.label !== "横屏") {
    return "";
  }

  const angle = getNormalizedOrientationAngle(info);
  const type = info.type || "";
  if (angle === 270 || type.startsWith("landscape-secondary")) {
    return "phone-bottom-left";
  }

  return "phone-bottom-right";
}

function getOutputRotationClassFromXR(xrDeviceOrientation) {
  const viewportIsLandscape = window.innerWidth >= window.innerHeight;
  if (!xrDeviceOrientation || viewportIsLandscape) {
    return "";
  }

  if (!isXRDeviceLandscape(xrDeviceOrientation)) {
    return "";
  }

  return xrDeviceOrientation.right.y >= 0
    ? "output-rotate-ccw"
    : "output-rotate-cw";
}

function formatScreenOrientationInfo(info) {
  const angle = info.angle === null ? "unknown" : `${info.angle}deg`;
  return `${info.label} (${info.type}, angle=${angle})`;
}

function updateScreenOrientation() {
  updateOrientationLayout();
}

function setXRLoadingState(isLoading) {
  document.body.classList.toggle("xr-loading", isLoading);
}

function setCameraFeedReady(isReady) {
  cameraFeedReady = isReady;
  document.body.classList.toggle("xr-camera-ready", isReady);

  if (isReady) {
    setXRLoadingState(false);
  }
}

function updateSurfaceStatus() {
  surfaceStatus.textContent = floorRecognized
    ? "【地面を認識しました】"
    : "【地面を写してください】";
}

function resetXRStartupVisualState() {
  setCameraFeedReady(false);
  setXRLoadingState(true);
  floorRecognized = false;
  updateSurfaceStatus();
  liveGuide.style.display = "none";
  frozenGuide.style.display = "none";
}

const RAD_TO_DEG = 180 / Math.PI;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function radiansToDegrees(radians) {
  return radians * RAD_TO_DEG;
}

function rotateVectorByQuaternion(vector, quaternion) {
  const x = vector.x;
  const y = vector.y;
  const z = vector.z;
  const qx = quaternion.x;
  const qy = quaternion.y;
  const qz = quaternion.z;
  const qw = quaternion.w;

  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;

  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx
  };
}

function getXRDeviceOrientation(transform) {
  if (!transform || !transform.orientation) {
    return null;
  }

  const forward = rotateVectorByQuaternion({ x: 0, y: 0, z: -1 }, transform.orientation);
  const up = rotateVectorByQuaternion({ x: 0, y: 1, z: 0 }, transform.orientation);
  const right = rotateVectorByQuaternion({ x: 1, y: 0, z: 0 }, transform.orientation);
  const topVertical = Math.abs(up.y);
  const sideVertical = Math.abs(right.y);
  const label = topVertical >= sideVertical
    ? (up.y >= 0 ? "XR竖屏(顶部朝上)" : "XR竖屏(顶部朝下)")
    : (right.y >= 0 ? "XR横屏(右边朝上)" : "XR横屏(左边朝上)");

  return {
    label,
    yaw: radiansToDegrees(Math.atan2(-forward.x, -forward.z)),
    pitch: radiansToDegrees(Math.asin(clamp(forward.y, -1, 1))),
    roll: radiansToDegrees(Math.atan2(right.y, up.y)),
    forward,
    up,
    right
  };
}

function formatVector3(vector) {
  return `${vector.x.toFixed(2)},${vector.y.toFixed(2)},${vector.z.toFixed(2)}`;
}

function isFloorLikeHitPose(hitPose) {
  if (!hitPose || !hitPose.transform) {
    return false;
  }

  if (hitPose.transform.orientation) {
    const surfaceNormal = rotateVectorByQuaternion(
      { x: 0, y: 1, z: 0 },
      hitPose.transform.orientation
    );
    return surfaceNormal.y > 0.7;
  }

  if (hitPose.transform.matrix) {
    return hitPose.transform.matrix[5] > 0.7;
  }

  return true;
}

function updateFloorRecognitionFromFrame(frame) {
  if (floorRecognized || !hitTestSource || !refSpace) {
    return;
  }

  try {
    const hitTestResults = frame.getHitTestResults(hitTestSource);
    floorRecognized = hitTestResults.some((hitTestResult) => {
      const hitPose = hitTestResult.getPose(refSpace);
      return isFloorLikeHitPose(hitPose);
    });

    if (floorRecognized) {
      // 高浜追加
        document.body.classList.add("floor-recognized");
        document.body.classList.add("target-visible");
        document.body.classList.remove("target-hidden");

      updateSurfaceStatus();
    }
  } catch (e) {
    console.warn("hit-test failed", e);
  }
}

function getCameraIntrinsics(projectionMatrix, viewport) {
  const p = projectionMatrix;
  const cx = (1 - p[8]) * viewport.width / 2 + viewport.x;
  const cy = (1 - p[9]) * viewport.height / 2 + viewport.y;
  const fx = viewport.width / 2 * p[0];
  const fy = viewport.height / 2 * p[5];
  const skew = viewport.width / 2 * p[4];
  return { fx, fy, cx, cy, skew };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], {
    type: "application/json"
  });
  downloadBlob(blob, filename);
}

async function blobFromCanvas(canvas, type = "image/png", quality) {
  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("toBlob failed"));
        return;
      }
      resolve(blob);
    }, type, quality);
  });
}

function createProgram(gl, vsSource, fsSource) {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, vsSource);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    throw new Error("Vertex shader compile failed: " + gl.getShaderInfoLog(vs));
  }

  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, fsSource);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    throw new Error("Fragment shader compile failed: " + gl.getShaderInfoLog(fs));
  }

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error("Program link failed: " + gl.getProgramInfoLog(program));
  }

  return program;
}

function initCameraCopyPipeline() {
  const vsSource = `
    attribute vec2 aPosition;
    varying vec2 vUv;
    void main() {
      vUv = (aPosition + 1.0) * 0.5;
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `;

  const fsSource = `
    precision mediump float;
    varying vec2 vUv;
    uniform sampler2D uCameraTexture;
    void main() {
      vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
      gl_FragColor = texture2D(uCameraTexture, uv);
    }
  `;

  copyProgram = createProgram(gl, vsSource, fsSource);

  quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
       1,  1
    ]),
    gl.STATIC_DRAW
  );

  copyTexture = gl.createTexture();
  copyFramebuffer = gl.createFramebuffer();
}

async function startXR() {
  if (!navigator.xr) {
    throw new Error("WebXR not supported");
  }

  const supported = await navigator.xr.isSessionSupported("immersive-ar");
  if (!supported) {
    throw new Error("immersive-ar not supported");
  }

  xrCanvas = document.createElement("canvas");
  xrCanvas.style.display = "none";
  document.body.appendChild(xrCanvas);

  gl = xrCanvas.getContext("webgl", {
    xrCompatible: true,
    alpha: true,
    preserveDrawingBuffer: false
  });
  if (!gl) {
    throw new Error("WebGL init failed");
  }

  xrSession = await navigator.xr.requestSession("immersive-ar", {
    requiredFeatures: ["local", "hit-test", "camera-access"],
    optionalFeatures: ["dom-overlay"],
    domOverlay: { root: document.body }
  });

  xrSession.addEventListener("end", () => {
    if (hitTestSource) {
      hitTestSource.cancel();
      hitTestSource = null;
    }
    viewerSpace = null;
  });

  xrSession.updateRenderState({
    baseLayer: new XRWebGLLayer(xrSession, gl)
  });

  glBinding = new XRWebGLBinding(xrSession, gl);
  refSpace = await xrSession.requestReferenceSpace("local");
  viewerSpace = await xrSession.requestReferenceSpace("viewer");
  hitTestSource = await xrSession.requestHitTestSource({ space: viewerSpace });
  initCameraCopyPipeline();

  xrSession.requestAnimationFrame(onXRFrame);

  // 初始化屏幕方向
  updateScreenOrientation();
  // 监听屏幕方向变化
  if (screen.orientation && screen.orientation.addEventListener) {
    screen.orientation.addEventListener("change", updateScreenOrientation);
  }
}

function renderCameraTextureToCanvas(cameraTexture, width, height) {
  captureCanvas.width = width;
  captureCanvas.height = height;

  gl.bindTexture(gl.TEXTURE_2D, copyTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null
  );

  gl.bindFramebuffer(gl.FRAMEBUFFER, copyFramebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    copyTexture,
    0
  );

  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error("Offscreen framebuffer incomplete");
  }

  gl.viewport(0, 0, width, height);
  gl.useProgram(copyProgram);

  const posLoc = gl.getAttribLocation(copyProgram, "aPosition");
  const texLoc = gl.getUniformLocation(copyProgram, "uCameraTexture");

  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, cameraTexture);
  gl.uniform1i(texLoc, 0);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  const ctx = captureCanvas.getContext("2d");
  const imageData = ctx.createImageData(width, height);

  for (let y = 0; y < height; y++) {
    const srcRow = height - 1 - y;
    const srcStart = srcRow * width * 4;
    const dstStart = y * width * 4;
    imageData.data.set(
      pixels.subarray(srcStart, srcStart + width * 4),
      dstStart
    );
  }

  ctx.putImageData(imageData, 0, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function getDisplayFourThreeTargetRatio() {
  return window.innerWidth >= window.innerHeight ? 4 / 3 : 3 / 4;
}

function getDisplayFourThreeLabel() {
  return getDisplayFourThreeTargetRatio() > 1 ? "4:3横向" : "3:4竖向";
}

function computeCenteredFourThreeROI(width, height) {
  const targetRatio = getDisplayFourThreeTargetRatio();
  const sourceRatio = width / height;

  let sx, sy, sWidth, sHeight;

  if (sourceRatio > targetRatio) {
    sHeight = height;
    sWidth = Math.round(height * targetRatio);
    sx = Math.round((width - sWidth) / 2);
    sy = 0;
  } else {
    sWidth = width;
    sHeight = Math.round(width / targetRatio);
    sx = 0;
    sy = Math.round((height - sHeight) / 2);
  }

  return { sx, sy, sWidth, sHeight, targetRatio };
}

function drawROIToCanvas(sourceCanvas, targetCanvas, roi) {
  targetCanvas.width = roi.sWidth;
  targetCanvas.height = roi.sHeight;

  const ctx = targetCanvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
  ctx.save();
  ctx.translate(0, targetCanvas.height);
  ctx.scale(1, -1);
  ctx.drawImage(
    sourceCanvas,
    roi.sx, roi.sy, roi.sWidth, roi.sHeight,
    0, 0, roi.sWidth, roi.sHeight
  );
  ctx.restore();
}

function updatePreviewFromCamera(cameraTexture, camera, targetCanvas) {
  renderCameraTextureToCanvas(cameraTexture, camera.width, camera.height);

  const roi = computeCenteredFourThreeROI(camera.width, camera.height);
  drawROIToCanvas(captureCanvas, targetCanvas, roi);
  return roi;
}

function clampGuideSelection(selection) {
  const minWidth = 0.15;
  const minHeight = 0.15;
  const w = Math.min(1, Math.max(minWidth, selection.w));
  const h = Math.min(1, Math.max(minHeight, selection.h));
  return {
    x: Math.min(1 - w, Math.max(0, selection.x)),
    y: Math.min(1 - h, Math.max(0, selection.y)),
    w,
    h
  };
}

function getDisplayedCanvasRect(canvas) {
  if (!canvas.width || !canvas.height) {
    return null;
  }

  const containerWidth = window.innerWidth;
  const containerHeight = window.innerHeight;
  const scale = Math.min(containerWidth / canvas.width, containerHeight / canvas.height);
  const width = canvas.width * scale;
  const height = canvas.height * scale;

  return {
    left: (containerWidth - width) / 2,
    top: (containerHeight - height) / 2,
    width,
    height
};
}

function updateBottomSaveStripLayout(canvas = viewCanvas) {
  const displayRect = getDisplayedCanvasRect(canvas);
  if (!displayRect) {
    return;
  }

  const rootStyles = getComputedStyle(document.documentElement);
  const bottomBarHeight = bottomBar.getBoundingClientRect().height ||
    parseFloat(rootStyles.getPropertyValue("--bottom-bar-height"));
  const actionButtonGap = parseFloat(rootStyles.getPropertyValue("--action-button-gap"));
  const actionButtonSize = parseFloat(rootStyles.getPropertyValue("--action-button-size"));
  const canvasBottomGap = window.innerHeight - (displayRect.top + displayRect.height);
  const gapAboveBottomBar = Math.max(0, canvasBottomGap - bottomBarHeight);
  const stripHeight = gapAboveBottomBar;
  const topStripHeight = Math.max(0, displayRect.top - bottomBarHeight);
  const discardTop = Math.max(0, displayRect.top - actionButtonSize - actionButtonGap);

  document.documentElement.style.setProperty("--bottom-bar-height", `${bottomBarHeight}px`);
  document.documentElement.style.setProperty("--bottom-save-strip-height", `${stripHeight}px`);
  document.documentElement.style.setProperty("--bottom-save-strip-top", `${-gapAboveBottomBar}px`);
  document.documentElement.style.setProperty("--top-save-strip-height", `${topStripHeight}px`);
  document.documentElement.style.setProperty("--discard-top", `${discardTop}px`);
}

function getGuideRectInROI(roi = currentROI) {
  if (!roi) {
    return null;
  }

  const roiWidth = roi.sWidth;
  const roiHeight = roi.sHeight;

  return {
    x: Math.round(guideSelection.x * roiWidth),
    y: Math.round(guideSelection.y * roiHeight),
    w: Math.round(guideSelection.w * roiWidth),
    h: Math.round(guideSelection.h * roiHeight)
  };
}

function getNormalizedGuideRectInROI() {
  const normalized = clampGuideSelection(guideSelection);
  return {
    x: normalized.x,
    y: normalized.y,
    w: normalized.w,
    h: normalized.h
  };
}

function formatNormalizedRect(rect) {
  if (!rect) {
    return "x:0.0000, y:0.0000, w:0.0000, h:0.0000";
  }

  return (
    `x:${rect.x.toFixed(4)}, ` +
    `y:${rect.y.toFixed(4)}, ` +
    `w:${rect.w.toFixed(4)}, ` +
    `h:${rect.h.toFixed(4)}`
  );
}

function updateGuideFrame(element, canvas) {
  const displayRect = getDisplayedCanvasRect(canvas);
  if (!displayRect) {
    return;
  }

  guideSelection = clampGuideSelection(guideSelection);

  element.style.left = `${displayRect.left + displayRect.width * guideSelection.x}px`;
  element.style.top = `${displayRect.top + displayRect.height * guideSelection.y}px`;
  element.style.width = `${displayRect.width * guideSelection.w}px`;
  element.style.height = `${displayRect.height * guideSelection.h}px`;
}

function syncGuideFrames() {
  if (!isFrozen) {
    updateGuideFrame(liveGuide, liveCanvas);
  }

  if (freezeLayer.style.display === "block") {
    updateGuideFrame(frozenGuide, viewCanvas);
  }
}

function updateGuideSelectionFromPointer(clientX, clientY) {
  const displayRect = getDisplayedCanvasRect(liveCanvas);
  if (!displayRect || !activeGuideDrag) {
    return;
  }

  const px = (clientX - displayRect.left) / displayRect.width;
  const py = (clientY - displayRect.top) / displayRect.height;
  const start = activeGuideDrag.start;

  if (activeGuideDrag.mode === "move") {
    guideSelection = clampGuideSelection({
      x: px - activeGuideDrag.offsetX,
      y: py - activeGuideDrag.offsetY,
      w: start.w,
      h: start.h
    });
    return;
  }

  let next;
  if (activeGuideDrag.mode === "tl") {
    const right = start.x + start.w;
    const bottom = start.y + start.h;
    next = { x: px, y: py, w: right - px, h: bottom - py };
  } else if (activeGuideDrag.mode === "tr") {
    const left = start.x;
    const bottom = start.y + start.h;
    next = { x: left, y: py, w: px - left, h: bottom - py };
  } else if (activeGuideDrag.mode === "bl") {
    const right = start.x + start.w;
    const top = start.y;
    next = { x: px, y: top, w: right - px, h: py - top };
  } else if (activeGuideDrag.mode === "br") {
    const left = start.x;
    const top = start.y;
    next = { x: left, y: top, w: px - left, h: py - top };
  } else if (activeGuideDrag.mode === "left") {
    const right = start.x + start.w;
    next = { x: px, y: start.y, w: right - px, h: start.h };
  } else if (activeGuideDrag.mode === "right") {
    next = { x: start.x, y: start.y, w: px - start.x, h: start.h };
  } else if (activeGuideDrag.mode === "top") {
    const bottom = start.y + start.h;
    next = { x: start.x, y: py, w: start.w, h: bottom - py };
  } else {
    next = { x: start.x, y: start.y, w: start.w, h: py - start.y };
  }

  guideSelection = clampGuideSelection(next);
}

function beginGuideDrag(event) {
  const handle = event.target.dataset.handle;
  const displayRect = getDisplayedCanvasRect(liveCanvas);
  if (!displayRect) {
    return;
  }

  event.preventDefault();
  const px = (event.clientX - displayRect.left) / displayRect.width;
  const py = (event.clientY - displayRect.top) / displayRect.height;

  activeGuideDrag = {
    mode: handle || "move",
    start: { ...guideSelection },
    offsetX: px - guideSelection.x,
    offsetY: py - guideSelection.y,
    pointerId: event.pointerId
  };

  liveGuide.setPointerCapture(event.pointerId);
}

function updateGuideDebugText() {
  syncGuideFrames();
}

function showLiveFourThreeGuide() {
  liveLayer.style.display = "block";
  updateGuideFrame(liveGuide, liveCanvas);
  liveGuide.style.display = "block";

// 追加
  document.body.classList.add("guide-visible");
}

function showFrozenGuide() {
  updateBottomSaveStripLayout(viewCanvas);
  updateGuideFrame(frozenGuide, viewCanvas);
  frozenGuide.style.display = "block";
}

async function performCaptureFromXRFrame(time, frame, view) {
  const camera = view.camera;
  if (!camera) {
    throw new Error("XRView.camera unavailable");
  }

  const cameraTexture = glBinding.getCameraImage(camera);
  if (!cameraTexture) {
    throw new Error("getCameraImage failed");
  }

  const roi = updatePreviewFromCamera(cameraTexture, camera, viewCanvas);
  lastCapturedROI = roi;

  isFrozen = true;
  document.body.classList.add("capture-frozen");
  liveLayer.style.display = "none";
  freezeLayer.style.display = "block";
  confirmBtn.style.display = "block";
  discardBtn.style.display = "block";
  confirmBtn.textContent = continueMode ? "完了" : "保存 4:3 写真";
  confirmBtn.setAttribute("aria-label", continueMode ? "完了" : "保存 4:3 写真");
  discardBtn.setAttribute("aria-label", "取消冻结");
  captureBtn.setAttribute("aria-label", "Unfreeze");
  captureBtn.classList.add("unfreeze-mode");

  liveGuide.style.display = "none";
  showFrozenGuide();

  const guideNormalized = getNormalizedGuideRectInROI();

  output.textContent =
    "画面はフリーズしています。\n" +
    `ROI(4:3) = x:${roi.sx}, y:${roi.sy}, w:${roi.sWidth}, h:${roi.sHeight}\n` +
    `guide-in-roi-normalized = ${formatNormalizedRect(guideNormalized)}\n\n` +
    (continueMode ? "上のボタンで保存、下のボタンで続き撮影、さらに上のボタンで完了してください" : "上のボタンで保存、下のボタンで続き撮影してください");
}

function exitFreeze() {
  isFrozen = false;
  document.body.classList.remove("capture-frozen");
  liveLayer.style.display = "block";
  freezeLayer.style.display = "none";
  confirmBtn.style.display = "none";
  discardBtn.style.display = "none";
  confirmBtn.textContent = "保存 4:3 写真";
  confirmBtn.setAttribute("aria-label", "保存 4:3 写真");
  frozenGuide.style.display = "none";
  liveGuide.style.display = "none";
  captureBtn.setAttribute("aria-label", "撮影");
  captureBtn.classList.remove("unfreeze-mode");
  updatePhotoCountLabel();
  continueMode = false;
}

function rotatedCanvasForSave(srcCanvas) {
  const rotationClass = currentOutputRotationClass || getOutputRotationClass(currentScreenOrientation) || getOutputRotationClassFromXR(currentXRDeviceOrientation);
  let angle = 0;
  if (rotationClass === "output-rotate-ccw") {
    angle = -Math.PI / 2; // rotate counter-clockwise 90deg
  } else if (rotationClass === "output-rotate-cw") {
    angle = Math.PI / 2; // rotate clockwise 90deg
  }

  if (angle === 0) return srcCanvas;

  const dst = document.createElement("canvas");
  dst.width = srcCanvas.height;
  dst.height = srcCanvas.width;
  const ctx = dst.getContext("2d");
  ctx.save();
  if (angle === Math.PI / 2) {
    ctx.translate(dst.width, 0);
    ctx.rotate(angle);
  } else {
    // -PI/2
    ctx.translate(0, dst.height);
    ctx.rotate(angle);
  }
  ctx.drawImage(srcCanvas, 0, 0);
  ctx.restore();
  return dst;
}

async function saveFourThreePhotoAndJson() {
  const rotated = rotatedCanvasForSave(viewCanvas);
  const photoBlob = await blobFromCanvas(rotated, "image/png");
  const guideInROI = getGuideRectInROI(lastCapturedROI);
  const guideInROINormalized = getNormalizedGuideRectInROI();

  const rotationDegrees = (rotated === viewCanvas) ? 0 : (currentOutputRotationClass === "output-rotate-cw" ? 90 : -90);

  const payload = {
    metadata: {
      capturedAt: Date.now(),
      pose: currentPose,
      intrinsics: currentIntrinsics,
      imageSize: {
        width: rotated.width,
        height: rotated.height
      },
      roi: lastCapturedROI,
      guideInROI,
      guideInROINormalized,
      rotationAppliedDegrees: rotationDegrees
    }
  };

  const basename = `capture_4x3_${Date.now()}`;
  downloadBlob(photoBlob, `${basename}.png`);
  downloadJson(payload, `${basename}.json`);

  savedPhotoCount++;
  updatePhotoCountLabel();
  continueMode = true;

  confirmBtn.textContent = "完了";
  confirmBtn.setAttribute("aria-label", "完了");
  frozenGuide.style.display = "none";
  liveGuide.style.display = "none";
  output.textContent =
    `写真を保存しました (写真数量:${savedPhotoCount})\n` +
    `guide-in-roi-normalized=${formatNormalizedRect(guideInROINormalized)}\n\n` +
    "下のボタンで続き撮影するか、上のボタンで終了してください";
}

function onXRFrame(time, frame) {
  xrSession.requestAnimationFrame(onXRFrame);

  const baseLayer = xrSession.renderState.baseLayer;
  const pose = frame.getViewerPose(refSpace);
  if (!pose) return;

  gl.bindFramebuffer(gl.FRAMEBUFFER, baseLayer.framebuffer);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const view = pose.views[0];
  const t = view.transform;
  const viewport = baseLayer.getViewport(view);
  const camera = view.camera;
  const screenOrientation = getScreenOrientationInfo();
  const xrDeviceOrientation = getXRDeviceOrientation(t);

  currentXRDeviceOrientation = xrDeviceOrientation;
  updateOrientationLayout(screenOrientation, xrDeviceOrientation);

  currentPose = {
    timestamp: time,
    screenOrientation,
    xrDeviceOrientation,
    position: {
      x: t.position.x,
      y: t.position.y,
      z: t.position.z
    },
    orientation: {
      x: t.orientation.x,
      y: t.orientation.y,
      z: t.orientation.z,
      w: t.orientation.w
    },
    viewMatrix: Array.from(view.transform.inverse.matrix)
  };

  currentIntrinsics = getCameraIntrinsics(view.projectionMatrix, viewport);
  updateFloorRecognitionFromFrame(frame);

  if (!isFrozen) {
    let roi = null;

    if (camera) {
      const cameraTexture = glBinding.getCameraImage(camera);
      if (cameraTexture) {
        roi = updatePreviewFromCamera(cameraTexture, camera, liveCanvas);
        currentROI = roi;
        lastCapturedROI = roi;
        if (!cameraFeedReady) {
          setCameraFeedReady(true);
          liveGuide.style.display = "none";
          captureBtn.disabled = false;
        }
        syncGuideFrames();
      }
    }

    const guideInROI = getGuideRectInROI(roi);
    const guideInROINormalized = getNormalizedGuideRectInROI();
    const xrOrientationText = currentXRDeviceOrientation
      ? `XR手机方向=${currentXRDeviceOrientation.label}\n` +
        `yaw=${currentXRDeviceOrientation.yaw.toFixed(1)}, ` +
        `pitch=${currentXRDeviceOrientation.pitch.toFixed(1)}, ` +
        `roll=${currentXRDeviceOrientation.roll.toFixed(1)}\n` +
        `forward=${formatVector3(currentXRDeviceOrientation.forward)}\n\n`
      : "XR手机方向=未知\n\n";

    output.textContent =
      "WebXR中...\n" +
      `地面状态=${floorRecognized ? "地面を認識しました" : "地面を写してください"}\n` +
      `屏幕方向=${formatScreenOrientationInfo(screenOrientation)}\n` +
      `文字方向=${currentOutputRotationClass || "normal"}\n` +
      `画面比例=${getDisplayFourThreeLabel()}\n` +
      xrOrientationText +
      "=== Pose ===\n" +
      `xp=${currentPose.position.x.toFixed(3)}\n` +
      `yp=${currentPose.position.y.toFixed(3)}\n` +
      `zp=${currentPose.position.z.toFixed(3)}\n\n` +
      `xo=${currentPose.orientation.x.toFixed(3)}\n` +
      `yo=${currentPose.orientation.y.toFixed(3)}\n` +
      `zo=${currentPose.orientation.z.toFixed(3)}\n` +
      `wo=${currentPose.orientation.w.toFixed(3)}\n\n` +
      "=== Intrinsics ===\n" +
      `fx=${currentIntrinsics.fx.toFixed(2)}\n` +
      `fy=${currentIntrinsics.fy.toFixed(2)}\n` +
      `cx=${currentIntrinsics.cx.toFixed(2)}\n` +
      `cy=${currentIntrinsics.cy.toFixed(2)}\n` +
      `guide-in-roi-normalized=${formatNormalizedRect(guideInROINormalized)}` +
      (guideInROI
        ? `, guide-in-roi=x:${guideInROI.x}, y:${guideInROI.y}, w:${guideInROI.w}, h:${guideInROI.h}\n`
        : "\n") +
      (roi
        ? `4:3-roi=${roi.sx},${roi.sy},${roi.sWidth},${roi.sHeight}\npreview-size=${roi.sWidth}x${roi.sHeight}`
        : "");
  }

  if (pendingCapture) {
    pendingCapture = false;
    captureBtn.disabled = true;

    Promise.resolve()
      .then(() => performCaptureFromXRFrame(time, frame, view))
      .catch((e) => {
        console.error(e);
        output.textContent = "失败: " + e.message;
      })
      .finally(() => {
        captureBtn.disabled = !initialized || !cameraFeedReady;
      });
  }
}

async function initAll() {
  if (initialized || initializing) return;
  initializing = true;
  resetXRStartupVisualState();

  try {
    output.textContent = "initializing...\n启动 WebXR...";
    await startXR();

    initialized = true;
    orientationLayoutEnabled = true;
    updateOrientationLayout();
    document.body.classList.add("xr-started");
    savedPhotoCount = 0;
    updatePhotoCountLabel();   
    captureBtn.style.display = "flex";
    aiBtn.style.display = "flex";
    captureBtn.disabled = !cameraFeedReady;
    startXRBtn.disabled = true;
    startXRBtn.style.display = "none";
    output.textContent = cameraFeedReady
      ? "initialized\nclick 撮影 to capture 4:3 photo"
      : "initialized\n等待相机画面...";
  } finally {
    initializing = false;
  }
}

startXRBtn.addEventListener("click", async () => {
  try {
    if (initialized || initializing) return;
    startXRBtn.disabled = true;
    startXRBtn.style.display = "none";
    output.textContent = "Startup...";
    await initAll();
  } catch (e) {
    console.error(e);
    setXRLoadingState(false);
    setCameraFeedReady(false);
    document.body.classList.remove("xr-started");
    startXRBtn.disabled = false;
    startXRBtn.style.display = "";
    output.textContent = "Startup failed: " + e.message;
  }
});

captureBtn.addEventListener("click", () => {
  if (!initialized || !cameraFeedReady) return;

    document.body.classList.add("target-hidden");
    document.body.classList.remove("target-visible");

  if (!isFrozen) {
    pendingCapture = true;
    output.textContent = "capturing 4:3...";
  } else {
    pendingCapture = true;
    output.textContent = "capturing next 4:3...";
  }
});

discardBtn.addEventListener("click", () => {
  if (!initialized || !isFrozen) return;
  exitFreeze();
  output.textContent = "取消冻结，返回实时预览";
});

confirmBtn.addEventListener("click", async () => {
  if (isFrozen) {
    if (continueMode) {
      exitFreeze();
      output.textContent = "撮影終了。次回の撮影を開始してください";
    } else {
      try {
        await saveFourThreePhotoAndJson();
        exitFreeze();
        output.textContent = "保存しました。撮影画面に戻りました";
      } catch (e) {
        console.error(e);
        output.textContent = "保存できませんでした: " + e.message;
      }
    }
  }
});



function handleOrientationChange() {
  updateOrientationLayout();
  syncGuideFrames();
}

updateOrientationLayout();

window.addEventListener("resize", handleOrientationChange);
window.addEventListener("orientationchange", handleOrientationChange);

if (screen.orientation && screen.orientation.addEventListener) {
  screen.orientation.addEventListener("change", handleOrientationChange);
}

window.addEventListener("beforeunload", () => {
  if (xrSession) {
    xrSession.end().catch(() => {});
  }
});

liveGuide.addEventListener("pointerdown", beginGuideDrag);

liveGuide.addEventListener("pointermove", (event) => {
  if (!activeGuideDrag || activeGuideDrag.pointerId !== event.pointerId) {
    return;
  }

  event.preventDefault();
  updateGuideSelectionFromPointer(event.clientX, event.clientY);
  syncGuideFrames();
});

liveGuide.addEventListener("pointerup", (event) => {
  if (!activeGuideDrag || activeGuideDrag.pointerId !== event.pointerId) {
    return;
  }

  liveGuide.releasePointerCapture(event.pointerId);
  activeGuideDrag = null;
});

liveGuide.addEventListener("pointercancel", (event) => {
  if (!activeGuideDrag || activeGuideDrag.pointerId !== event.pointerId) {
    return;
  }

  liveGuide.releasePointerCapture(event.pointerId);
  activeGuideDrag = null;
});