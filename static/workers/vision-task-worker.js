/* eslint-disable */
/**
 * MediaPipe Tasks(vision) worker — handsdetect, facemp, posemp, facemesh 가 함께 쓴다.
 * 확장마다 이 Worker를 하나씩 띄운다(scratch-vm/src/util/vision-task-client.js).
 *
 * 왜 Worker인가:
 *  - 구버전 @mediapipe/* 솔루션이 페이지에 전역 `Module`을 남기면, 같은 페이지에서 tasks-vision을 로드할 때
 *    "Module.noExitRuntime has been replaced" 로 abort 된다. Worker는 전역이 분리되어 있어 충돌하지 않는다.
 *  - CPU 추론(프레임당 수십~100ms)이 메인 스레드(스크래치 런타임/렌더링)를 막지 않는다.
 *
 * 왜 classic worker + vision_bundle.js(cjs)인가:
 *  - tasks-vision은 wasm 로더를 importScripts()로 불러오는데, module worker에서는 importScripts가 금지된다.
 *  - `.cjs` 확장자는 Electron(file://)/WebView 모두 JS MIME으로 인식하지 않아 로드가 거부되므로 `.js`로 둔다.
 *
 * 메시지 프로토콜 (모든 요청에 id, 응답은 같은 id):
 *  - {type: 'init', task, delegate: 'GPU'|'CPU'} -> {}
 *  - {type: 'selftest'}                         -> {detected: bool}  (GPU 손 검출, 내장 테스트 이미지)
 *  - {type: 'detect', bitmap: ImageBitmap}      -> {result, width, height}
 *  - {type: 'close'}                            -> {}
 *  성공 시 ok: true, 실패 시 {ok: false, error: string}
 */
// PC 앱(Electron)은 nodeIntegrationInWorker: true 라 Worker에도 Node의 process가 있다(process.type === 'worker').
// tasks-vision의 wasm 로더는 `process.versions.node && process.type != "renderer"` 이면 Node.js로 판단해
// require("node:fs")로 wasm을 읽으려다 실패한다(Electron 14의 Node 14는 'node:' 접두어를 모른다).
// 이 Worker는 Node 기능이 필요 없으므로 라이브러리를 불러오기 전에 process를 가린다.
if (self.process && self.process.type === 'worker') {
    Object.defineProperty(self, 'process', {value: undefined, configurable: true, writable: true});
}

var TASKS_VERSION = '0.10.35';
// 캐시 무효화: Worker URL의 쿼리(예: ?v=...)를 라이브러리·wasm·모델 URL에도 붙인다(vision-task-client.js 의 ASSET_VERSION).
// 웹 배포 후 브라우저가 이전 파일을 계속 쓰지 않게 하려는 것으로, 쿼리가 없으면 아무것도 붙지 않는다.
var ASSET_QUERY = self.location.search;
var LIB_BASE = new URL('../lib/mediapipe-tasks-vision-' + TASKS_VERSION + '/', self.location.href).href;
var LIB_URL = LIB_BASE + 'vision_bundle.js' + ASSET_QUERY;
var MODEL_BASE = new URL('../models/vision_tasks/', self.location.href).href;
var SELFTEST_IMAGE_URL = MODEL_BASE + 'selftest_victory.jpg' + ASSET_QUERY;

// 구버전 @mediapipe/* 의 setOptions 값을 그대로 옮겼다.
var TASKS = {
    hand: {
        className: 'HandLandmarker',
        model: 'hand_landmarker.task',
        options: {numHands: 1, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5}
    },
    face_detector: {
        className: 'FaceDetector',
        model: 'blaze_face_short_range.tflite', // 구버전 model: "short"
        options: {minDetectionConfidence: 0.5}
    },
    pose: {
        className: 'PoseLandmarker',
        model: 'pose_landmarker_full.task', // 구버전 modelComplexity: 1
        options: {numPoses: 1, minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5, outputSegmentationMasks: false}
    },
    face_landmarker: {
        className: 'FaceLandmarker',
        model: 'face_landmarker.task', // 구버전 refineLandmarks: true 와 같은 478점(홍채 포함)
        options: {numFaces: 1, minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5}
    }
};

self.exports = {};
self.module = {exports: self.exports};

var vision = null;
var fileset = null;
var runner = null;
var lastTimestamp = 0;

function loadVision () {
    if (!vision) {
        importScripts(LIB_URL);
        vision = self.module.exports;
    }
    return vision;
}

// FilesetResolver.forVisionTasks(폴더) 와 같은 결과를 만들되, 파일 URL에 ASSET_QUERY 를 붙인다.
async function getFileset () {
    if (!fileset) {
        var simd = await loadVision().FilesetResolver.isSimdSupported();
        var name = LIB_BASE + 'wasm/vision_wasm_' + (simd ? '' : 'nosimd_') + 'internal';
        fileset = {wasmLoaderPath: name + '.js' + ASSET_QUERY, wasmBinaryPath: name + '.wasm' + ASSET_QUERY};
    }
    return fileset;
}

async function createRunner (task, delegate, runningMode) {
    var spec = TASKS[task];
    if (!spec) throw new Error('unknown task: ' + task);
    var options = Object.assign({
        baseOptions: {modelAssetPath: MODEL_BASE + spec.model + ASSET_QUERY, delegate: delegate},
        runningMode: runningMode
    }, spec.options);
    // Worker에는 DOM canvas가 없으므로 GPU 추론용 OffscreenCanvas를 직접 넘긴다.
    if (delegate === 'GPU') options.canvas = new OffscreenCanvas(1, 1);
    return loadVision()[spec.className].createFromOptions(await getFileset(), options);
}

function closeRunner () {
    if (runner) {
        runner.close();
        runner = null;
    }
}

// detectForVideo는 단조 증가하는 timestamp(ms)를 요구한다.
function nextTimestamp () {
    var now = performance.now();
    lastTimestamp = now > lastTimestamp ? now : lastTimestamp + 1;
    return lastTimestamp;
}

var handlers = {
    init: async function (msg) {
        closeRunner();
        runner = await createRunner(msg.task, msg.delegate, 'VIDEO');
        return {};
    },
    // 일부 GPU(예: Adreno 830)는 MediaPipe GPU 추론이 오류 없이 "검출 없음"만 반환한다.
    // 손이 확실히 있는 내장 이미지로 GPU 추론 결과를 확인한다(모든 MediaPipe 확장이 이 결과를 공유).
    selftest: async function () {
        var test = await createRunner('hand', 'GPU', 'IMAGE');
        try {
            var blob = await (await fetch(SELFTEST_IMAGE_URL)).blob();
            var bitmap = await createImageBitmap(blob);
            var result = test.detect(bitmap);
            bitmap.close();
            return {detected: result.landmarks.length > 0};
        } finally {
            test.close();
        }
    },
    detect: async function (msg) {
        try {
            if (!runner) throw new Error('task not initialized');
            var width = msg.bitmap.width;
            var height = msg.bitmap.height;
            var result = runner.detectForVideo(msg.bitmap, nextTimestamp());
            // 결과 객체에는 close() 같은 메서드가 있어 그대로 postMessage 할 수 없다 — 데이터만 복사한다.
            return {result: JSON.parse(JSON.stringify(result)), width: width, height: height};
        } finally {
            msg.bitmap.close();
        }
    },
    close: async function () {
        closeRunner();
        return {};
    }
};

self.onmessage = async function (ev) {
    var msg = ev.data;
    var reply;
    try {
        reply = await handlers[msg.type](msg);
        reply.ok = true;
    } catch (e) {
        reply = {ok: false, error: String(e && e.message ? e.message : e)};
    }
    reply.id = msg.id;
    self.postMessage(reply);
};
