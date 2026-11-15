# 애니송 맞추기 (프로토타입)

애니 노래의 짧은 구간을 듣고 곡 제목이나 작품명을 맞히는 싱글 플레이 웹 퀴즈입니다.
곡은 운영자가 등록한 YouTube 링크 목록에서만 나옵니다. 영상은 오버레이로 가리고 소리만 들려주며, 정답을 공개할 때만 영상을 보여 줍니다.

- 순수 HTML/CSS/JS(ES modules). 프레임워크·빌드 도구·npm 패키지가 없습니다.
- 외부 의존성은 브라우저가 불러오는 YouTube IFrame API(`https://www.youtube.com/iframe_api`) 하나입니다.
- `package.json`은 Node가 `.js`를 ES module로 읽게 하는 `"type": "module"` 설정과 `npm test` 스크립트만 담고 있습니다. 설치할 의존성은 없습니다.

## 실행 방법

**`index.html`을 더블클릭해서(file://) 열지 마세요.** YouTube 임베드가 오류 153 등으로 실패하고, `songs.json`도 불러오지 못합니다. 반드시 http로 서빙하세요.

### Python 내장 서버

```bash
cd anime-song-quiz
python -m http.server 8000      # 또는 python3 -m http.server 8000
```

브라우저에서 <http://localhost:8000> 을 엽니다.

### VS Code Live Server

1. VS Code 확장 "Live Server"(Ritwick Dey)를 설치합니다.
2. `anime-song-quiz` 폴더를 열고 `index.html`에서 우클릭 → **Open with Live Server**를 누릅니다.

## 배포

빌드 과정이 없으므로 폴더를 그대로 올리면 됩니다.

### GitHub Pages

1. 이 폴더 내용을 저장소 루트(또는 `docs/` 폴더)에 올립니다.
2. 저장소 **Settings → Pages**에서 Source를 "Deploy from a branch"로, 브랜치와 폴더(`/ (root)` 또는 `/docs`)를 고릅니다.
3. 잠시 뒤 `https://<사용자명>.github.io/<저장소명>/` 에서 열립니다. 경로는 모두 상대 경로라 하위 경로에서도 동작합니다.

### Netlify

- 가장 간단한 방법: <https://app.netlify.com/drop> 에 폴더를 끌어다 놓습니다.
- 저장소를 연결할 때는 Build command를 비우고 Publish directory를 이 폴더로 지정합니다.

## 친구와 대결 (멀티플레이)

방 코드로 모인 2~8명이 같은 곡을 같은 순간에 듣고 맞힌 사람은 모두 점수를 받습니다(빨리 맞힐수록 높음). 라운드는 전원이 맞히거나 포기·오답 소진하면, 아니면 제한시간이 끝나면 정답을 공개합니다. 방과 판정은 서버(Cloudflare Workers + Durable Objects)가 맡으므로 서버를 따로 켜야 합니다.

```bash
npm run server:dev        # 로컬 서버(http://localhost:8787). wrangler를 npx로 내려받아 실행
python -m http.server 8000   # 정적 페이지는 평소처럼
```

http://localhost:8000 에서 "친구와 대결"을 누르면 로컬 서버에 자동으로 연결됩니다. 같은 컴퓨터의 탭 두 개로 혼자 시험해 볼 수 있습니다. 랜덤듣기는 서버가 곡 길이를 알아야 하므로 `songs.json`의 곡에 `duration`(초)을 채워야 하고, 채우기 전에는 전체듣기만 됩니다.

배포하면 Worker 주소를 `js/online/config.js`의 `DEFAULT_SERVER_URL`에 넣고(또는 주소 끝에 `?server=https://…`), `wrangler.toml`의 `ALLOWED_ORIGINS`를 정적 페이지 주소로 좁히세요. 배포는 `npm run server:deploy`(Cloudflare 계정과 `npx wrangler login` 필요)입니다.

## 곡 등록

### 앱 안에서 (곡 관리 화면)

1. 시작 화면에서 **곡 관리**를 누릅니다.
2. YouTube 링크를 붙여넣으면 영상 ID가 자동으로 추출됩니다. 지원 형식은 `youtu.be/ID`, `watch?v=ID`, `/shorts/ID`, `/embed/ID`, `/live/ID`, `music.youtube.com`, 11자리 ID 단독 입력입니다.
3. 링크에 `t=45`나 `t=1m5s`가 있으면 hookStart 초기값으로 들어갑니다.
4. 제목, 제목 별칭(쉼표 구분), 가수(선택), 작품명, 작품 별칭, 종류, hookStart를 입력하고 **곡 추가**를 누릅니다.
5. 목록에서 사용 여부를 켜고 끄거나 곡을 삭제할 수 있습니다. **JSON 내보내기·가져오기**도 지원합니다.

직접 추가한 곡과 사용 여부 설정은 브라우저 localStorage에 저장되며 `songs.json`과 합쳐집니다. videoId가 같으면 직접 추가한 항목이 우선합니다. `songs.json`에 있는 곡을 삭제하면 이 브라우저에서만 숨겨집니다.

### songs.json (기본 목록)

처음에는 빈 배열(`[]`)입니다. 곡 관리에서 **JSON 내보내기**로 받은 파일을 `songs.json`으로 덮어쓰면 모든 방문자에게 같은 목록이 제공됩니다. 형식은 `songs.sample.json`을 참고하세요. 샘플의 `VIDEO_ID_1` 같은 값은 자리표시자라서 그대로 쓰면 형식 오류로 건너뜁니다.

```json
{
  "id": "고유 ID(생략 시 videoId)",
  "videoId": "11자리 YouTube ID",
  "title": "곡 제목",
  "titleAliases": ["제목 별칭"],
  "anime": { "name": "작품명", "aliases": ["작품 별칭"] },
  "artist": "가수",
  "type": "OP | ED | 삽입곡",
  "hookStart": 45,
  "skipStart": 5,
  "skipEnd": 10,
  "duration": 92,
  "enabled": true
}
```

`hookStart`, `skipStart`, `skipEnd`, `duration`은 선택 항목이며 단위는 초입니다.
`artist`(가수)도 선택 항목입니다. 정답 공개 화면에 "곡 제목 / 가수"로 표시되며, 가수 이름은 정답으로 인정하지 않습니다.
한글·일본어·영어 표기 차이는 자동으로 바꾸지 않으므로, 인정할 표기를 별칭에 넣어 주세요.
퍼가기(임베드)가 금지된 영상은 재생 오류(101/150)가 나서 게임 중에 자동으로 건너뜁니다.

## 게임 규칙 요약

| 항목 | 랜덤듣기 | 전체듣기 |
|---|---|---|
| 재생 | 무작위 구간 3/5/10초(기본 5초) | 처음부터, 제한시간 30초 |
| 구간 위치 | 앞뒤 10%(또는 skipStart/skipEnd)를 뺀 범위, hookStart가 있으면 ±5초 | - |
| 다시듣기 | 1회(-20점) | 없음 |
| 점수 | 100 × 구간 계수(3초 1.5 / 5초 1.0 / 10초 0.7) − 다시듣기 20, 최소 10 | 100 − 80 × t/30 (최저 20), t는 소리가 난 시간 |

- 난이도: 쉬움(4지선다, 곡 제목), 보통(곡 제목 또는 작품명, 별칭 포함), 어려움(곡 제목만).
- 정규화: NFKC 변환, 소문자화, 공백·특수문자 제거. 오타 허용 편집거리는 정규화한 정답 길이 4 이하 0, 5~8은 1, 9 이상은 2입니다.
- 오답은 라운드당 3번까지 가능하고, 다 쓰면 0점으로 공개합니다. 패스도 0점입니다.
- 점수 상수는 `js/scoring.js`의 `SCORING` 한곳에 모여 있습니다.
- 모드별 최고 점수는 localStorage에 저장됩니다.
- 노래 볼륨은 시작 화면·게임 화면·대기실의 슬라이더로 조절하고(기본 80%), 개인전과 친구와 대결이 같은 값을 쓰며 브라우저에 기억됩니다. iOS Safari는 웹페이지의 볼륨 조절을 무시하므로 기기 볼륨 버튼을 써야 합니다.

## 구조

```
index.html          화면 4개(시작·게임·결과·곡 관리)
css/style.css       모바일 우선 다크 테마
js/linkParser.js    YouTube 링크/ID/t 파라미터 파서
js/judge.js         정규화, 편집거리, 난이도별 판정, 객관식 보기
js/scoring.js       점수 상수와 계산
js/segment.js       랜덤 구간 시작 위치 선택
js/songs.js         곡 스키마 검증, 병합, localStorage 저장, 길이 캐시, 최고 점수
js/game.js          라운드 상태 머신(플레이어 인터페이스 주입)
js/player.js        YouTube IFrame API 어댑터(브라우저 전용)
js/ui.js            화면 렌더링·이벤트
js/main.js          진입점
songs.json          기본 곡 목록(빈 배열)
songs.sample.json   형식 예시(자리표시자)
tools/check-songs.mjs  songs.json 점검(영상 존재·임베드 가능, 길이, 중복)
tools/merge-songs.mjs  친구들이 보낸 곡 JSON을 songs.json에 합치기(없는 영상만 추가)
tests/              node --test 테스트와 가짜 플레이어(helpers.js)
```

### 플레이어 동작 메모

- IFrame API 스크립트는 한 번만 로드하고, ready가 된 뒤에 플레이어를 씁니다.
- 플레이어 iframe을 **2개** 만들어 라운드마다 번갈아 씁니다. 정답 공개 중에 다음 곡을 다른 플레이어에 `cueVideoById`로 미리 불러 두기 위해서입니다(플레이어가 1개면 공개 중인 영상이 지워집니다).
- 영상 길이를 모르면 음소거 상태로 0초부터 로드하고, PLAYING이 되면 `getDuration()`을 읽어 videoId별로 캐시합니다. 그 뒤 구간 위치로 `seekTo`하고, 위치가 구간 안에서 실제로 흐르는 것을 확인한 다음에 `unMute`합니다.
- 구간 종료는 `endSeconds`를 쓰지 않고 `getCurrentTime()`을 150ms마다 확인해서 `pauseVideo()`합니다.
- 재생 오류(2, 5, 100, 101, 150, 153)가 나면 그 곡을 이번 게임에서 빼고 다른 곡으로 바꾼 뒤, **재생** 버튼을 다시 누르게 합니다. 남은 곡이 없으면 라운드 수를 줄입니다.
- 모바일 자동재생 차단을 피하려고 재생은 항상 사용자의 클릭(게임 시작·재생·다음 곡) 안에서 시작합니다.
- 게임 화면은 iframe이 다시 로드되지 않도록 `display:none` 대신 화면 밖으로 옮겨 숨깁니다.

## 테스트

```bash
cd anime-song-quiz
node --test                                   # 단위·상태 머신 테스트
for f in js/*.js tests/*.js tools/*.mjs; do node --check "$f"; done   # 문법 검사(package.json의 "type": "module" 덕분에 ESM으로 검사)
```

### 곡 목록 점검

```bash
node tools/check-songs.mjs           # 또는 npm run check-songs. 다른 파일: node tools/check-songs.mjs 경로.json
node tools/check-songs.mjs --write   # duration이 없거나 2초 넘게 틀린 곡을 실제 길이로 고쳐 저장
```

인터넷이 필요합니다. YouTube oEmbed 응답 코드로 영상 존재·임베드 가능 여부를(401·403 임베드 금지, 400·404 없음), watch 페이지의 `lengthSeconds`로 길이를 확인하고, `duration` 차이와 `id`·`videoId` 중복을 검사합니다. 곡마다 한 줄씩 정상/경고/문제를 출력하고 마지막에 요약합니다. 문제가 있으면 종료 코드 1입니다.

### 친구들이 보낸 곡 합치기

1. 친구가 곡 관리에서 곡을 등록하고 **내 곡만 내보내기**를 눌러 `my-songs.json`을 보내 줍니다(그 브라우저에서 직접 추가한 곡만 들어 있음).
2. 받은 파일을 합칩니다.

```bash
node tools/merge-songs.mjs 친구1.json 친구2.json           # 무엇이 추가될지 보기만 함
node tools/merge-songs.mjs 친구1.json 친구2.json --write   # songs.json 끝에 새 곡 추가
node tools/check-songs.mjs --write                          # 영상 점검, 길이 채우기
```

songs.json에 없는 영상만 추가하고 이미 있는 곡은 바꾸지 않습니다(내용이 다르면 다른 항목만 알려 줌). 여러 파일에 같은 영상이 있으면 먼저 쓴 파일의 곡을 쓰고, 형식이 틀린 항목은 건너뜁니다. 다른 파일에 합치려면 `--into 경로.json`.

`game.js`는 플레이어를 인터페이스로 주입받으므로, 테스트에서는 `tests/helpers.js`의 `FakePlayer`로 재생 상태, 오류, 시간 흐름을 흉내 냅니다.

## 아직 확인하지 못한 것

이 프로토타입은 네트워크가 막힌 환경에서 만들었기 때문에 **실제 YouTube 재생은 한 번도 확인하지 못했습니다.** 실제 브라우저에서 다음 사항을 먼저 확인해 주세요.

- 음소거 로드 → seek → unMute 흐름에서 0초 소리가 새어 나오지 않는지, 모바일(특히 iOS Safari)에서 unMute 뒤에 실제로 소리가 나는지
- 2개의 iframe을 번갈아 쓰는 방식이 모바일에서 문제없이 동작하는지
- 오버레이가 YouTube 제목 표시줄과 종료 후 추천 영상을 모두 가리는지
