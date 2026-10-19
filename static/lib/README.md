# static/lib — 자체 호스팅 라이브러리

웹 버전은 대부분의 라이브러리(tfjs 4.22.0, teachablemachine image/pose, speech-commands, face-api, knn-classifier)를
`src/playground/index.ejs` 에서 CDN 으로 불러온다. 여기에는 **CDN 에 두지 않고 자체 서버에서 내려주는 것만** 둔다.
`CopyWebpackPlugin` 이 `static/` 을 그대로 `dist/static/` 으로 복사하므로 파일을 추가할 때 webpack 설정은 건드리지 않는다.

| 파일 | 버전 | 출처 | 쓰는 곳 |
|---|---|---|---|
| `mediapipe-tasks-vision-0.10.35/` | 0.10.35 | `@mediapipe/tasks-vision@0.10.35` (`vision_bundle.cjs` → `vision_bundle.js`, `wasm/vision_wasm_internal.*`, `wasm/vision_wasm_nosimd_internal.*`) | handsdetect, facemp, posemp, facemesh |
| `jspdf-2.5.1/` | 2.5.1 | `jspdf@2.5.1` (`dist/jspdf.umd.min.js`, `LICENSE`) | 파일 메뉴 "PDF출력" (`src/lib/block-pdf/`) |

jspdf 는 npm 의존성으로 번들하지 않는다. UMD 빌드 안의 선택 의존성 `require("canvg"/"html2canvas"/"dompurify")` 를
webpack 4 가 해석하지 못하기 때문이다. `src/lib/block-pdf/index.js` 가 처음 쓸 때 `<script>` 로 불러와 `window.jspdf` 를 쓴다.

앱 버전(`@bitblock_cordova_20_app`)과 같은 파일·같은 구조다. 공통 코드는 두 저장소가 같은 내용을 유지한다:
`scratch-vm/src/util/{ai-delegate-setting,vision-task-client,tfjs-backend}.js`, `static/workers/vision-task-worker.js`.

## mediapipe-tasks-vision (handsdetect, facemp, posemp, facemesh)

- 페이지에 `<script>` 로 넣지 않고 `static/workers/vision-task-worker.js` 안에서만 `importScripts()` 로 로드한다
  (확장마다 Worker 하나, `scratch-vm/src/util/vision-task-client.js`). 구버전 `@mediapipe/*` 솔루션이 페이지 전역에
  `Module` 을 남기면 같은 페이지의 tasks-vision 이 `Module.noExitRuntime has been replaced` 로 abort 되는데,
  Worker 는 전역이 분리되어 충돌하지 않는다. CPU 추론이 화면을 멈추지 않는 장점도 있다.
- `index.ejs` 가 CDN 에서 불러오는 tasks-vision 0.10.34(`window.mpTasks`)는 숨김 확장 classifyme 전용이며 이것과 별개다.
- `vision_bundle.cjs` 를 **`.js` 로 이름을 바꿔** 둔다(`.cjs` 는 JS MIME 으로 인식되지 않아 `importScripts` 가 거부된다).
  module worker 는 `importScripts` 가 금지되어 classic worker + cjs 번들을 쓴다.
- 모델은 `static/models/vision_tasks/`(모두 `https://storage.googleapis.com/mediapipe-models/` 의 float16/1):
  `hand_landmarker.task`, `blaze_face_short_range.tflite`, `pose_landmarker_full.task`, `face_landmarker.task`,
  GPU 자동 점검용 `selftest_victory.jpg`(MediaPipe 테스트 이미지, Apache-2.0).
- 캐시: 이 폴더·모델·Worker 를 바꾸면 `vision-task-client.js` 의 `ASSET_VERSION` 을 올린다. Worker URL 의 `?v=` 쿼리가
  라이브러리·wasm·모델 URL 에도 붙어 배포 후 이전 파일 캐시를 쓰지 않는다.
- 호스팅: `.wasm` 은 `application/wasm` MIME 으로, 가능하면 gzip/br 압축으로 내려준다. CSP 를 쓰면 `worker-src 'self'`,
  `script-src` 에 `'wasm-unsafe-eval'` 이 필요하다.

## AI 처리 장치(자동/GPU/CPU)

메뉴바 버전 표시를 길게 누르면 열리는 고급 설정에서 고른다(`scratch-vm/src/util/ai-delegate-setting.js`).
- MediaPipe(검출 4종): Worker 의 delegate 를 GPU/CPU 로. 자동은 손 사진으로 GPU 를 점검(Adreno 830 등은 GPU 가 "검출 없음"만 반환).
- TensorFlow.js(TM·이미지 학습·감정 분류): `tfjs-backend.js` 가 `webgl`/`cpu` 로 맞춘다. 전역 tf 4.22 와 엔진을 공유하는
  TM·speech-commands·knn 은 한꺼번에 바뀌고, face-api 0.20 은 tfjs-core 1.0.3 을 내장한 별도 엔진이라 `faceapi.tf` 도 따로 바꾼다.
