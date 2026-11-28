# 애니송 맞추기 (프로토타입)

애니 노래의 짧은 구간을 듣고 곡 제목이나 작품명을 맞히는 웹 퀴즈. 개인전과 친구와 대결(멀티플레이)이 있다. 곡은 운영자가 미리 등록한 YouTube 링크 목록에서만 나오고, 영상은 오버레이로 가리고 소리만 들려준다(정답 공개 때만 영상 표시).

- 기획서: https://claude.ai/artifact/2hVz1HKqmJSWJqmnHEvQkf
- 멀티플레이 기획서(Claude Docs): https://claude.ai/artifact/3BLyVFbGYGhL7hk2pjG7SM
- 공개 페이지: https://astraea2209.github.io/kyoquiz/ (저장소 astraea2209/kyoquiz, main 브랜치 root, GitHub Pages)
- 대결 서버: https://anime-song-quiz-rooms.anime-song-quiz.workers.dev (`js/online/config.js`의 `DEFAULT_SERVER_URL`)

## 명령어

- 실행: Windows는 `start.bat` 더블클릭(서버 + 브라우저, 배포 서버용 `?server=` 포함, `.gitattributes`로 CRLF 유지). 직접 하려면 이 폴더에서 `python -m http.server 8000` 후 http://localhost:8000 (Windows에서 python이 안 되면 `py -m http.server 8000` 또는 VS Code Live Server)
- `index.html`을 file://로 열면 안 된다. YouTube 임베드가 오류 153 등으로 실패하고 songs.json도 못 불러온다. 반드시 http로 서빙
- 테스트: `node --test` (또는 `npm test`). 의존성 설치 없음
- 대결 서버: 로컬 `npm run server:dev`(= `npx wrangler dev`, 포트 8787. localhost에서 열면 클라이언트가 자동으로 로컬 서버를 씀), 배포 `npm run server:deploy`. wrangler는 npx로 그때그때 받아 쓰며 package.json 의존성에 넣지 않는다
- 곡 점검: `node tools/check-songs.mjs` (또는 `npm run check-songs`). 곡마다 한 줄(정상/경고/문제)과 요약만 출력, 문제가 있으면 exit 1. `--write`는 `duration`이 없거나 2초 넘게 틀린 곡을 실제 길이로 고쳐 저장(필드 순서·형식 유지). 곡 확인은 YouTube 검색 HTML을 직접 받지 말고 이 스크립트로 한다(토큰 절약)
- 곡 합치기: `node tools/merge-songs.mjs 친구1.json [친구2.json ...] [--into songs.json] [--write]`. 친구가 곡 관리의 "내 곡만 내보내기"로 보낸 파일에서 songs.json에 없는 videoId만 끝에 추가(기존 곡은 안 바꾸고 다른 필드만 보고, 파일끼리 중복은 앞 파일 우선, id 충돌은 videoId로 바꿈). 기본은 보기만, `--write`로 저장. 합친 뒤 `check-songs --write`
- git: 기본 브랜치 `main`. 작성자 정보는 이 저장소 로컬 설정에만 있다(전역 설정 없음)

## 기술 스택과 원칙

- 순수 HTML/CSS/JS(ES modules). 프레임워크, 빌드 도구, npm 패키지를 추가하지 않는다. 외부 의존은 YouTube IFrame API 하나(서버는 Cloudflare Workers + Durable Objects, 사용자 결정)
- UI 문구와 README는 한국어, 코드 식별자는 영어
- 새 로직은 `tests/`에 Node 내장 테스트를 같이 추가한다
- `game.js`는 실제 YouTube 객체에 직접 의존하지 말고 플레이어 인터페이스를 주입받는 구조를 유지한다(테스트에서 가짜 플레이어 사용). 서버 `Room`도 시계·난수·타이머·전송을 주입받는다
- 화면은 데스크톱 기준으로 만든다(모바일은 신경 쓰지 않기로 함, 2026-11-26)

## 작업 세션 운영

- **진행 과정과 대답은 반드시 한국어로 한다.** 작업 중 진행 안내, 중간 설명, 질문, 최종 답변, 커밋 메시지까지 모두 한국어. 코드 식별자, 명령어, 파일 경로, 고유명사(곡·가수 원어 표기)만 원래 표기를 쓴다
- 세션 하나에 목표 하나. 기능 개발은 `js/game.js`, `js/ui.js`를 거의 항상 같이 건드리므로 동시에 하나씩만 하거나 worktree 브랜치로 나눈다
- `songs.json`만 고치는 곡 데이터 작업, 점검, 기획 작업은 코드 작업과 동시에 해도 된다
- 세션을 끝낼 때 이 파일의 검증 현황, 다음 작업 후보, 미결정 사항을 갱신하고 커밋한다
- **이 파일은 지금 상태만 짧게 적는다.** 작업 경과·날짜별 기록·배포 버전 이력은 커밋 메시지에 남기고, 여기에는 규칙, 현재 동작, 확인 못 한 것만 둔다. 사용자가 정한 것은 "(사용자 결정)"으로 표시한다

## 배포

- Pages: `main`을 push하면 1~2분 뒤 자동 갱신. push 전에 `git fetch`로 origin/main을 확인한다
- 서버: `npm run server:deploy`. `server/`, 서버가 import하는 `js/` 모듈(judge·scoring·segment·songStats·recentSongs·game(`MODE`)·online/stickers·online/reactions), `songs.json`을 바꾸면 다시 배포해야 한다(곡 목록은 배포 번들에 들어감). 재배포하면 진행 중인 방이 사라진다
- push와 배포는 사용자에게 먼저 묻는다(사용자가 이번 작업에서 하라고 했으면 그대로 진행)
- 확인: 서버 `/api/health` 200, 배포 서버에 Node WebSocket 2개로 방 만들기·입장·한 라운드, 공개 페이지에 바뀐 파일이 반영됐는지(`songs.json`은 곡 수)
- 배포 직후 몇 분은 브라우저 캐시에 예전 모듈이 남아 새 모듈과 섞이면 시작 화면이 멈출 수 있다(새로고침으로 해결)
- `wrangler.toml`: Durable Object 바인딩(`ROOMS`, `STATS`, 마이그레이션 v2)과 `ALLOWED_ORIGINS`(`https://astraea2209.github.io`와 로컬 8000만 허용)

## 곡 추가 절차

모든 방문자와 친구와 대결에 나오게 하려면 `songs.json`에 넣는다. 곡 관리 화면에서 등록한 곡은 그 브라우저 localStorage에만 있다. 친구가 "내 곡만 내보내기"로 보낸 파일은 3~4 대신 `node tools/merge-songs.mjs 친구.json --write`로 합치고 5부터 같다.

1. 링크 정리: videoId만 뽑고(`si=` 같은 추적 파라미터는 버림), 같은 링크가 여러 번 있으면 한 번만, songs.json(origin/main 기준)에 이미 있는 videoId는 건너뛴다
   - 플레이리스트·모음 영상은 넣지 않는다. 제목이 모음처럼 보이면 넣기 전에 사용자에게 확인하고, 건너뛴 채 말하지 않는다. 사용자가 단일 곡이라고 확인하면 넣는다
2. 곡 정보 확인: 영상 제목·채널은 oEmbed(`https://www.youtube.com/oembed?url=<watch URL>&format=json`), 타이업(애니 OP·ED, 게임 주제가 등)은 watch 페이지 `shortDescription`에서 主題歌·テーマ·アニメ·ゲーム 같은 줄만 골라 본다. 검색 결과 HTML은 받지 않는다(토큰 절약). 스크립트는 셸 따옴표가 꼬이기 쉬우니 scratchpad에 `.mjs` 파일로 써서 실행
3. 항목 작성. 필드 순서는 id, videoId, title, titleAliases, anime, artist, artistAliases, type, hookStart, skipStart, skipEnd, duration, enabled
   - `id`: 작품 곡은 `bleach-op2`처럼 `작품-op번호`, 일반 노래는 `9lana-only-way`처럼 `가수-곡`(영문 소문자, 하이픈)
   - **표기 원칙: 제목, 작품명, 가수와 모든 별칭에 일본어(히라가나·가타카나·한자)를 적지 않는다.** 한국에서 부르는 이름으로 적고, 모르면 추측하지 말고 사용자에게 묻는다
   - **로마자(일본어를 영문자로 적은 것, 예: Guren no Yumiya, Jujutsu Kaisen)도 적지 않고** 한국어 발음(구렌노 유미야, 주주츠 카이센)으로 별칭에 넣는다. 영어 번역 제목(A Cruel Angel's Thesis, Attack on Titan)은 별칭에 넣어도 된다
   - **영문 제목·영문 활동명은 그대로 적고, 한국에서 부르는 이름을 별칭에 넣는다**(예: KICK BACK → 킥백, LiSA → 리사, YOASOBI → 요아소비)
   - `title`: 한국에서 부르는 제목. 일본어 제목은 뜻을 옮기거나(ほうき星 → 혜성) 한국에서 굳어진 발음(사이하테)으로 쓰고, 한국어 발음·띄어쓰기 변형을 `titleAliases`에 넣는다(혜성 → 호우키보시)
   - `anime`: `{name: 한국어 작품명, aliases: [줄임말, 영어 제목, 시즌명, 한국어 발음 등]}`. 게임 곡은 `name`에 게임 이름. 작품이 없는 일반 노래는 필드 자체를 넣지 않는다. 같은 작품의 시즌은 `anime` 객체를 공유하고 `id`(예: `kanojo-op1`)로만 구분한다
   - `artist`: 한국어 표기가 있으면 한국어(예: 요네즈 켄시, 윤하), 영문 활동명은 그대로(예: YOASOBI). 일본어 글자가 섞인 활동명은 공식 영문 표기나 한국어로 바꾼다(Official髭男dism → Official HIGE DANdism, 凛として時雨 → 린토시테시구레). 한국에서 부르는 다른 이름은 `artistAliases`(예: 9Lana → 쿠라나, Official HIGE DANdism → 히게단)
   - **이미 있는 작품·가수는 먼저 찾아 `anime`·`artist`·`artistAliases`를 별칭까지 그대로 쓴다**(사용자 지시). 새 별칭이 생기거나 기존 표기가 갈려 있으면 기존 곡도 같은 값으로 고친다(4의 "기존 줄은 그대로"의 예외)
   - `type`: OP, ED, 삽입곡, OST(게임 주제가 포함), 캐릭터송, 일반곡, 기타
   - 노래만 있는 영상이 아니면(예: 14분짜리 영상) `enabled: false`
   - 공식 한국어 이름을 확인하지 못한 작품명·곡 제목·가수명은 넣기 전에 사용자에게 묻는다(일본어 원제를 별칭으로 남기지 않으므로 이름이 틀리면 정답 인정도 틀어진다)
4. 저장: 기존 줄은 그대로 두고 끝에 추가한다. 형식은 `formatSongsJson`(`tools/check-songs.mjs`)과 같게(곡마다 필드 한 줄, 배열과 `anime`는 한 줄). 스크립트로 넣을 때는 이 함수를 import해 쓴다. 다른 세션이 origin/main의 `songs.json` 끝에 곡을 추가했으면 upstream 파일을 받고 추가 스크립트를 다시 돌린다(끝 줄 충돌)
5. 점검: `node tools/check-songs.mjs --write`(존재·임베드 가능 확인, `duration` 채움)와 `node --test`
   - 길이를 못 읽으면(YouTube가 watch 페이지에 캡차를 줄 때) `duration`을 비운 채 저장하고 나중에 `--write`를 다시 돌린다. 캡차는 우회하지 않는다. "길이 확인 불가" 경고는 문제(exit 1)가 아니다. `duration`이 없는 곡은 대결 랜덤듣기에서 빠진다
6. 반영: 커밋 → `main` push → `npm run server:deploy`(위 "배포"). 확인은 `https://astraea2209.github.io/kyoquiz/songs.json`의 곡 수와 서버 `/api/health`
7. 아래 "songs.json 현황"을 갱신한다

## songs.json 현황

- 321곡, 모두 `duration` 있음, 점검 스크립트 정상 321·경고 0(2026-11-26). `hookStart`는 아직 없음. `songs.sample.json`은 형식 예시(자리표시자 값)
- 구성: 유명 애니 OP 12, 블리치 OP·ED 15, 9Lana(쿠라나) 13(오리지널 10은 `일반곡`·`anime` 없음, 애니 ED 2, 게임 주제가 1), 2026년 애니 OP·ED 12(작품명은 사용자가 준 한국어 제목), 최애의 아이 5·장송의 프리렌 5·식령제로 2, 여친, 빌리겠습니다 6(엔딩 크레딧은 3기 ED MV, 연애mm 필름 OP는 사용자가 단일 OP라고 확인), 나머지는 친구들이 보낸 목록(my-songs*.json, my_song2.json, mo.json, kong.json)을 정리한 것. 친구 곡의 `id`는 파일 값 그대로이거나 videoId 소문자
- 꺼 둔 곡: 블리치 혜성(14분짜리 영상) 1곡
- 플레이해 보고 이상하면 지울 곡(사용자 결정으로 켜 둠): `자유로운 천사들`(PV), `STRAIGHT JET`(DVD 예고편), `태양 가라사대 불타라 카오스`(커버 영상)
- 한글자막 팬 업로드 영상이 많아 삭제될 수 있다. 가수 없는 곡: Emiya, 운명의 밤, Big Sleep, To the Infinity Castle, 실 부 프레지던트. Aitouka는 제목이 로마자 그대로
- 확인 필요: 최애의 아이·프리렌·식령제로 곡의 가수 한국어 이름·별칭은 Claude가 정함
- 표기 통일: 작품·가수 표기는 모두 통일함(합작·그룹 명의처럼 다른 대상은 따로). 블리치·투 러브 트러블·러브라이브는 작품 객체 하나, 가수는 µ's·Eir Aoi·FLOW 표기, 결속밴드는 모든 곡에서 이지치 니지카·스즈시로 사유미도 인정

## 구조

- `index.html`, `css/style.css`: 화면(시작, 게임, 결과, 곡 관리 + 대결 입장·대기실·게임·순위)
- `js/main.js`: 진입점. 저장소, 곡 목록, 플레이어 준비 후 App 시작, "친구와 대결" 버튼 연결
- `js/ui.js`: `App`. 화면 전환과 DOM 처리(개인전·곡 관리)
- `js/game.js`: `GameSession` 개인전 상태 머신(라운드 진행, 재생 오류 시 곡 교체, 곡 부족 시 라운드 축소)
- `js/player.js`: YouTube IFrame API 로드와 플레이어 래퍼(`unMute` 때 볼륨 다시 적용)
- `js/judge.js`: 정답 정규화, 오타 허용, 난이도별 인정 범위, 객관식 보기
  - `initialHint`: 한글 음절은 초성, 영문 등은 단어 첫 글자만 남기고 `_`, 띄어쓰기·숫자·기호는 그대로. `hintParts`(힌트 항목 [{key, text}]), `formatHint`
  - `revealsAnswer`: 채팅 글에 정답이 들어 있는지(제목·가수·작품명과 별칭 전부와 오타 허용 비교, 또는 2글자 이상 후보가 글 안에 그대로 있음)
  - 매우 어려움: `itemCandidates`(곡에 있는 항목만: title·artist·anime), `judgeItems`(입력 하나를 남은 항목 전부와 비교)
  - `splitArtistNames`: 가수 표기를 ×·&·쉼표·、·/·` x `·feat.·ft.·featuring·with로 나누고 앞의 THE를 뺀 이름도 추가. and와 +는 이름의 일부라 나누지 않음
- `js/scoring.js`: 점수 상수와 계산. **밸런스 조정은 이 파일의 `SCORING`만 바꾼다.** `SCORING.hint`·`applyHint`, `SCORING.solo.answerTimes`, `SCORING.extreme`·`scoreExtremeItem`·`scoreExtremeBonus`, `SCORING.multi`·`scoreMulti`·`answerWindow`, `SCORING.roundLimits`·`parseRounds`
- `js/segment.js`: 랜덤듣기 구간 선택(앞뒤 10% 제외, hookStart ±5초 우선)
- `js/recentSongs.js`: 최근에 나온 곡을 출제 순서 뒤로(`orderByRecency`, `addRecent`, `sanitizeRecent`, 최근 100곡 `RECENT_SONGS_LIMIT`). 개인전은 `RecentSongs`(localStorage `asq.recentSongs`)를 `GameSession`의 `recentSongs` 옵션으로 주입, 대결은 `Room.recentVideoIds`
- `js/songStats.js`: 곡별 정답률 형식 `{players, complete, hint, items: {title, artist, anime}}`(맞힌 사람 수). `roundSongStats`, `addSongStats`, `sanitizeSongStats`, 화면용 `itemRate`·`formatStatsSummary`. 서버와 화면이 같이 쓴다
- `js/linkParser.js`: YouTube 링크에서 videoId와 `t=` 시작 시간 추출. `youtubeWatchUrl(videoId, 시작 초)`
- `js/hotkeys.js`: 게임 화면 단축키(개인전·대결 공용 순수 함수 `handleGameKey`, `volumeKeyDelta`, `choiceKeyIndex`). 키 목록은 아래 "단축키와 포커스"
- `js/volume.js`: 노래 볼륨(0~100, 기본 80, localStorage `asq.volume`). `VolumeControl`이 모든 플레이어에 적용, 슬라이더 4개(시작, 개인전 게임, 대기실, 대결 게임)는 `bindVolumeInput`으로 같은 값을 공유
- `js/songs.js`: 곡 스키마, songs.json과 localStorage 병합(`SongStore`), 영상 길이 캐시, 최고 점수, 설정 저장(`STORAGE_KEYS`)
  - 곡 필드: id, videoId, title(유일한 필수값), titleAliases, anime{name, aliases}(선택, 일반 노래는 필드 자체가 없음), artist·artistAliases(선택, 매우 어려움에서만 정답 항목), type(`SONG_TYPES`. 비우면 작품이 있으면 OP, 없으면 일반곡), hookStart·skipStart·skipEnd·duration(선택, 초), enabled
  - 화면에서 `song.anime`은 없을 수 있으니 `?.`로 읽는다. `duration`이 있으면 게임이 길이 측정용 음소거 로드를 건너뛴다
- `tools/check-songs.mjs`: songs.json 점검(oEmbed로 존재·임베드 가능 여부와 채널명, watch 페이지 `lengthSeconds`로 길이, id·videoId 중복). 순수 함수는 export해 `tests/checkSongs.test.js`에서 네트워크 없이 테스트. `formatSongsJson`은 merge-songs도 쓴다
- `tools/merge-songs.mjs`: 곡 JSON 합치기(`mergeSongLists`, `orderSongFields`, `diffFields`)
- `tests/`: 단위 테스트 파일 23개와 도우미(`helpers.js` 가짜 플레이어·시계, `fakeTimers.js` 시계와 연동된 타이머, `roomHelpers.js` 가짜 소켓 방 환경)

### 친구와 대결(멀티플레이)

- `server/room.js`: `Room` 방 상태 머신(대기실→준비→시작 대기→답변→공개→결과). 어댑터는 `handleMessage(connId, msg)`와 `handleDisconnect(connId)`만 부른다. 판정·구간·점수는 `js/`의 모듈을 그대로 import. 시간·한도 상수는 `ROOM_CONFIG`(생성 때 `config`로 덮어쓰기, 정답 공개 시간은 `room.revealMs`)
- `server/roomHost.js`: `RoomHost`. Room을 소켓({send, close})에 연결하는 런타임 무관 계층(JSON 파싱, 메시지 크기 2KB·빈도 40개/5초 제한, join 10초 제한, 빈 방 60초 뒤 닫기)
- `server/index.js`: Workers 진입점. `POST /api/rooms`(방 생성), `GET /ws?code=`(WebSocket), `GET /api/health`. 방 하나 = `RoomDO` 하나, 상태는 메모리에만(재배포·재시작하면 방이 사라짐). 곡별 정답률은 서버 전체에 하나뿐인 `StatsDO`(`idFromName('global')`, 키 `song:<videoId>`, 재배포해도 유지, 밖에서 직접 부를 수 없음)에 쌓고 `Room`에 `stats {get, add}`로 주입(저장소 오류는 삼키고 게임은 계속)
- `js/online/net.js`: 시계 차이 계산(`ClockSync`)
- `js/online/connection.js`: `RoomConnection` WebSocket 연결·토큰 재접속(0.5→4초 간격, 60초 안에 못 돌아오면 포기)·ping 시계 보정. 서버가 일부러 끊은 경우(1000/1008/1009)와 치명적 오류(방 가득 참, 닉네임 등)는 재접속하지 않는다
- `js/online/session.js`: `OnlineSession` 서버 메시지 → 화면용 상태, 사용자 동작 → 메시지(roundId 포함). `playerColor`(입장 순서 p1~p8에 8색)
- `js/online/config.js`: 서버 주소 결정(`?server=` → 저장값 → localhost면 로컬 서버 → `DEFAULT_SERVER_URL`), 초대 링크·WebSocket URL
- `js/online/ui.js`: `OnlineApp` 화면 4개(입장, 대기실, 게임, 순위). `App.showScreen`을 그대로 쓰고 `js/ui.js`·`js/game.js`는 건드리지 않는다. 채팅 패널(`#on-chat`) 하나를 화면마다 `.chat-slot`으로 옮겨 쓴다. 개인전과 별개로 iframe 2개(`online-player-0/1`)를 처음 입장할 때 만든다
- `js/online/playback.js`: `OnlinePlayback` 재생 제어(prepare→ready→go→reveal). 플레이어 2개 교대
- `js/online/reactions.js`: 공개 중 리액션 `REACTIONS`(👍😂😮😭🔥❤️👏🤔)
- `js/online/stickers.js`, `img/stickers/`: 채팅 이모지(그림) `STICKERS [{id, src, label}]`(지금 `question` gif, `angry` webp). 새 이모지는 그림을 넣고 목록 끝에 추가한 뒤 Pages push와 서버 배포(서버가 목록에 없는 id를 버림)

## 게임 규칙

### 공통(개인전·대결)

- 모드: 랜덤듣기(3/5/10/15초 구간, 다시듣기 1회), 전체듣기(처음부터, 제한 시간). 플레이 중 모드 변경 불가
- 라운드 수: 빠른 선택 5/10/20 또는 직접 입력 1~100(범위 밖은 끝값으로, 곡이 모자라면 곡 수만큼. 서버는 `isValidRounds`로 검증)
- 난이도: 쉬움(객관식 4지선다), 보통(주관식, 제목 또는 작품명), 어려움(주관식, 제목만), 매우 어려움(아래)
- 오답 기회: 라운드당 3번(매우 어려움 5번). 소진하면 정답 공개 후 0점. 패스도 0점
- 오타 허용: 정규화 길이 4 이하 완전 일치, 5~8은 편집거리 1 이하, 9 이상은 2 이하. 한글·일본어·영어 표기 차이는 자동 변환하지 않고 별칭으로 처리
- 점수: 랜덤듣기는 100 × 구간 계수(3초 1.5, 5초 1.0, 10초 0.7, 15초 0.5) − 다시듣기 20점(정답이면 최소 10점). 전체듣기는 100에서 시작해 제한 시간 동안 20점까지 선형 감소. 콤보 없음
- 매우 어려움: 곡에 있는 제목·가수·작품명(작품 없는 노래는 2개)을 모두 맞혀야 라운드가 끝난다. 입력칸 하나로 남은 항목 전부와 비교해 맞은 항목을 모두 인정. 가수가 여러 명이면 한 명만 맞혀도 정답(사용자 결정). 항목을 맞힌 즉시 그 시점 기본 점수를 가중치 제목 2 : 가수 1 : 작품명 1로 나눈 점수, 전부 맞히면 기본 점수의 50% 보너스. 이미 맞힌 항목을 다시 내면 기회가 줄지 않는다. 패스·소진·시간 초과여도 맞힌 항목 점수는 남는다. 결과 목록은 전부 ○, 일부 △, 없음 ×
- 초성 힌트(쉬움 제외): 소리가 난 뒤(대결은 시작 신호 뒤) 라운드당 1번. 제목 초성(매우 어려움은 가수·작품명도). 이후 얻는 점수 절반(매우 어려움은 힌트 전에 맞힌 항목은 그대로). 보통·어려움은 무대 가운데에 크게, 매우 어려움은 항목 칸의 `?` 자리에 주황색. 공개 문구·결과 기록에 힌트 사용 표시
- 출제 순서: 섞되 최근에 나온 곡은 뒤로(개인전은 이 브라우저의 최근 100곡, 대결은 그 방에서 나온 곡). 빼지는 않아 곡이 적어도 라운드가 줄지 않고 오래전에 나온 곡부터 다시 나온다
- 결과 화면 곡 제목은 다시 듣기 링크(새 탭, `t=` 들었던 구간 시작 초)

### 개인전

- 랜덤듣기 답변 시간: 구간이 끝난 뒤 제한 없음(기본)/10/15/20초. 지나면 시간 초과로 공개, 다시듣기 하면 다시 들은 구간이 끝난 뒤부터 새로 셈
- 최고 점수: 모드별로 끝까지 마친 게임만 기록(난이도 구분 없음이라 매우 어려움 점수가 섞임). 0점 게임은 기록하지 않음
- 결과 화면: 점수 카드와 `정답 n / m곡`, 열리면 `같은 설정으로 다시`에 포커스

### 친구와 대결

- 인원 2~8. 방장이 대기실에서 모드·난이도·라운드와 답변 시간(랜덤듣기 `answerTime` 5/10/15/20/30초, 전체듣기 `fullTime` 15/30/45/60초 기본 30. 모드에 맞는 칸만 보임), 정답 공개 시간(`revealTime` 5/10/15/20/30초, 기본 10)을 정한다
- 라운드는 첫 정답에 끝나지 않는다. 전원이 정답·패스·오답 소진(또는 제외)되거나 답변 시간이 끝날 때 공개. 정답자는 각자 도착 시간에 따른 속도 점수(`scoreMulti`, +50% 속도 보너스), 점수는 공개 때 반영
- 매우 어려움: 항목 점수의 기본 점수는 각자 맞힌 시점의 속도 점수. 전부 맞혀야 '정답'으로 잠기고 정답 수에 들어간다. 일부만 맞힌 사람도 공개 때 그 점수를 받는다. 다른 사람에게는 맞힌 개수만 보인다(순위판 칩 `1/3`)
- 힌트: 초성은 본인에게만, 다른 사람에게는 순위판 칩 `힌트`만
- 정답 공개: `N초 뒤 다음 라운드` 카운트다운, 넘기기 투표 `다음으로 (1/3)`(접속한 전원이 누르면 바로 다음, 마지막 라운드면 `결과 보기`), 리액션 8개(한 사람당 0.4초 간격, 영상 위로 이름과 함께 떠오름, 공개 중에만, 기록 안 함)
- 채팅: 대기실·게임·순위 화면에서 같은 패널. 준비·시작 대기·답변 중에는 정답이 든 글(`revealsAnswer`)을 막고 본인에게 안내(입력칸에 글 복원). 0.5초 간격 제한, 100자. 😀 버튼으로 그림 이모지(정답 검사 없음). 재접속하면 최근 50개를 받는다
- 플레이어 색: 채팅 이름·참가자 목록·순위판 이름. 순위판 칩: 정답 초록, 패스 회색, 기회 소진 빨강, 힌트 주황, 매우 어려움 진행 파랑, 재생 오류·준비 지연·쉬는 중·연결 끊김은 점선 테두리
- 게임 중 입장: 시작한 방에도 최대 인원까지 들어올 수 있다. 진행 중인 라운드는 `쉬는 중`(`다음 라운드부터 함께해요`), 다음 `prepare`부터 0점으로 합류, 최종 순위에 들어간다. 기존 참가자에게 알림. 방장이 끊긴 채면 접속한 사람으로 방장을 다시 정한다
- 곡별 정답률(매우 어려움만): 서버가 준비 때 그 곡 기록을 읽어 두고 공개 때 이번 라운드를 더한 누적값을 보낸다. 항목 칸마다 `정답률 40%`(마우스를 올리면 `지금까지 N명 중 M명`), 공개 카드에 `정답률 누적 N명 · 전부 맞힘 X%`. 답할 수 있었던 사람만 센다(재생 오류·준비 지연·쉬는 중 제외, 도중에 끊겨도 맞힌 항목이 있으면 셈). 같은 사람이 같은 곡을 여러 번 풀면 그때마다 센다. 개인전·다른 난이도는 기록하지 않음
- 결과: 1~3위 메달, 라운드별 기록(○△×), 같은 멤버로 한 판 더

### 단축키와 포커스

- ↑/↓: 볼륨 ±5(답·채팅 한 줄 입력칸에서도 됨. 볼륨 슬라이더·라디오·여러 줄 입력칸에서는 안 됨)
- K: 패스, 정답 공개 중에는 다음으로(개인전 `다음 곡 (K)`, 대결 넘기기 투표). `event.code === 'KeyK'`라 한글 자판도 됨. 글자 입력칸에 포커스가 있으면 동작 안 하므로 입력 중에는 Esc → K(사용자 결정). 누르고 있는 반복 입력은 무시
- Esc: 입력칸 빠져나오기. 1~4: 쉬움 보기 고르기(숫자키·키패드, 보기 앞에 번호)
- Tab/Shift+Tab(대결): 답 입력칸 ↔ 채팅 입력칸(답 입력칸이 잠겼거나 숨었으면 채팅에서는 기본 Tab)
- 자동 포커스: 소리가 실제로 나기 시작하는 순간(`canAnswer`가 false→true) 답 입력칸에. 볼륨 슬라이더 조작 중이거나 대결 채팅 입력칸에 글이 있으면 뺏지 않는다. 입력칸이 `disabled`인 동안은 포커스할 수 없어서 클릭 시점이 아니라 이 전환 시점에 한다
  - 개인전: 다시듣기 뒤 답 입력칸으로 돌아가고, 정답 공개 때 "다음 곡" 버튼(Enter로 넘어감)
  - 대결: 정답을 맞히는 순간(매우 어려움은 전부 맞혔을 때)과 정답 공개 때 채팅 입력칸(사용자 요청)

### 화면 배치(데스크톱)

- 넓은 화면에서 두 단. 시작 화면은 왼쪽 모드·게임 시작, 오른쪽 설정 카드. 게임 화면은 왼쪽 무대·답 입력·정답 공개, 오른쪽 패널(개인전 `이번 게임`: 공개된 곡 목록·정답 수·단축키 안내, 대결: 점수순 순위판과 채팅). 대기실·대결 결과·곡 관리도 왼쪽 주 내용, 오른쪽 보조
- 영상(사용자 결정 A안): 높이는 화면 높이의 60%(낮은 창에서는 아래 340px를 남긴 높이, CSS `--stage-w`), 게임 화면 최대 폭 1440px, 옆 패널 300px. 1400×900에서 960×540
- 영상 바로 아래 줄은 왼쪽 남은 시간·오른쪽 볼륨(`.stage-meta`), 그 아래 재생·다시듣기·힌트·패스 버튼과 답 입력칸 한 줄(`.answer-row`, 정답 공개 중에는 `answer-area`째 숨김), 남은 기회와 피드백 한 줄(`.answer-meta`). 쉬움 보기는 4칸 한 줄
- 채팅이 있는 옆 패널은 화면 아래 끝까지 늘어나고 채팅 목록이 남는 높이를 채운다(패널 위치는 화면별 `--side-top`, 제목·머리줄 높이를 바꾸면 같이 고칠 것)
- 남은 시간 5초 이하면 진행 바가 붉게(`.progress.low`). `[hidden] { display: none !important }`(`.btn`의 display가 hidden을 이기던 버그 방지)

## 구현상 주의점 (바꾸기 전에 읽을 것)

- 플레이어 iframe 2개를 라운드마다 번갈아 쓴다. 1개면 정답 공개 중 다음 곡을 `cueVideoById`로 미리 불러올 때 보여 주던 영상이 사라진다
- 랜덤 구간 계산에 영상 길이가 필요하다. 길이를 모르면 mute로 로드해 길이를 읽고 캐시에 저장한 뒤 seek하고, 시간이 실제로 흐르는 것을 확인한 다음에 unMute한다(0초 부분 소리 누출 방지. 소리 시작이 약 0.15초 늦어짐)
- 구간 종료는 `endSeconds`가 아니라 `getCurrentTime` 폴링으로 pause한다
- 모바일 자동재생 차단 때문에 라운드 시작은 항상 사용자가 누르는 버튼에서 시작한다. 재생 오류로 곡이 바뀐 뒤에도 자동 재생하지 않고 "재생" 버튼을 다시 누르게 한다
- 게임 화면은 `display:none` 대신 화면 밖으로 옮겨 숨긴다(다시 보일 때 iframe 재로드 방지)
- YouTube iframe은 200x200 이상으로 두고 오버레이로 가린다. 제목 표시줄과 종료 후 추천 영상이 정답을 노출하지 않아야 한다
- YouTube가 iframe `title` 속성에 영상 제목을 넣는다. 그래서 `GameSession.isPlayerVisible(i)`가 false인 플레이어 칸(공개 전, 다음 곡을 cue해 둔 칸)은 `inert`로 접근성 트리에서 뺀다
- 건너뛰는 오류 코드: 2, 5, 100, 101, 150, 153
- 숨긴 라디오 버튼(`.segmented input`, `.mode-card` 안)은 부모에 `position: relative`가 없으면 화면 폭만큼 늘어나 가로 스크롤이 생긴다

### 대결 서버 규칙(코드에서 정한 세부)

- 오류 과반(절반 초과) 판정은 준비 단계에서만 곡 교체, 시작 신호 뒤 오류는 그 사람만 제외. ready 시간 초과로 아무도 준비하지 못해도 곡 교체
- 곡 교체는 한 라운드에서 `maxSongReplacements`(3)번까지, 넘으면 알림과 `gameOver {reason: 'playback-failed'}`(재생이 안 되는 환경에서 곡을 다 써 버리지 않게). 라운드가 바뀌면 다시 센다
- 랜덤듣기는 `duration`이 없는 곡을 제외. 시작 신호는 `go` 전송 3초 뒤
- 대기실에서도 끊기면 60초 유예 뒤 퇴장(새로고침 대비). 전원 이탈 시 방은 유예가 끝나면 닫힘. 유예가 끝나 퇴장한 사람의 토큰으로 오면 새 참가자. 모두 끊겨 멈춘 게임에 새로 들어오면 결과 화면으로
- 최근 곡 기록(`recentVideoIds`)은 한 판 더 해도 유지되고 방이 닫히면 사라진다

### 곡 관리 화면

- 등록 폼, 곡 수(전체·사용 중), 곡 찾기, JSON 내보내기(내 곡만 = `exportJson({userOnly: true})`, 전체)·가져오기, 내 곡 전부 지우기
- 곡 길이는 `parseDurationText`(초, 분:초, 시:분:초)로 읽는다(틀린 형식이면 저장 안 함, 비우면 게임이 재서 캐시)
- 전체 목록은 보여 주지 않고, 곡 찾기(`searchSongs`: 제목·작품·가수·각 별칭·videoId 부분 일치, 정규화는 `normalizeAnswer`)에 검색어를 넣었을 때만 최대 20곡을 사용 토글·수정·삭제 버튼과 함께 보여 준다. songs.json 곡 삭제는 그 브라우저에서만 숨겨진다
- 수정: 폼이 수정 모드가 되어 값이 채워지고(`songToFormValues`, 길이는 `formatDurationText`) 링크 칸은 잠긴다. 저장은 `songFromForm(values, {videoId, duration}, original)`로 폼에 없는 `id`·`skipStart`·`skipEnd`와 사용 여부를 유지한 채 `store.add`(같은 videoId 교체). songs.json 곡을 고치면 그 브라우저의 사용자 곡이 되어 "내 곡만 내보내기"에 들어가고, `원래대로`(`store.revert`, 꺼 둔 상태는 유지)로 되돌린다. 모두에게 반영하려면 songs.json을 고쳐야 한다
- 내 곡 전부 지우기(`store.clearUserSongs`): 친구가 목록을 보낸 뒤 눌러 다음 내보내기에 이미 보낸 곡이 다시 들어가지 않게 한다. 직접 추가한 곡과 고친 songs.json 곡(원래대로 돌아감)을 지우고 사용 여부 기록도 정리. songs.json 곡 숨김은 그대로. 확인 창에서 먼저 내보내기를 안내

## 대결 프로토콜

- 클라이언트 → 서버: `join/settings/start/ready/answer/pass/hint/playerError/chat/skip/react/ping/leave`
- 서버 → 클라이언트: `joined/state/prepare/go/locked/answerResult/rateLimited/reveal/gameOver/notice/error/pong/kicked/hint/chat/chatLog/chatBlocked/reaction`. 기획서의 메시지 표에 없던 `joined`(토큰 전달), `answerResult`(본인에게만), `rateLimited`, `notice`, `pong`, `kicked`, `leave`를 추가했다
- 설정: `mode, clipLength, rounds, difficulty, answerTime, fullTime, revealTime`
- 정답: 맞힌 사람에게만 `answerResult {correct: true, points, elapsed, order}`, 모두에게 `locked {reason: 'correct'}`, 상태 `correct`
- `reveal`·`gameOver.history`: `correctPlayers [{playerId, nickname, elapsed, points, hint}]`(처리 순서), `reason: 'done'|'timeout'`, `segmentStart`. `reveal`에는 다음 곡 cue용 `nextVideoId`, 다음으로 넘어가는 서버 시각 `nextAt`
- 매우 어려움: `prepare.items`(항목 키 배열, 아니면 null)·`prepare.attempts`, 상태 스냅샷 플레이어 `solved`(맞힌 개수, 아니면 null). 항목을 맞히면 본인에게 `answerResult {correct: true, items, itemPoints, points, total, bonus, complete, elapsed, order}`(complete일 때만 `locked`), 이미 맞힌 항목만 내면 `answerResult {correct: false, already, attemptsLeft}`. `reveal`·`history`에 `items`와 `partialPlayers [{playerId, nickname, points, solved, hint}]`, `correctPlayers`에 `solved`, `reveal.song.artist`
- 힌트: `hint {roundId}` → 본인에게 `hint {roundId, text, parts [{key, text}]}`, 상태 스냅샷 플레이어 `hint`(이번 라운드 사용 여부, 게임 밖이면 null)
- 채팅: `chat {text}`(100자, 공백 정리) 또는 `chat {sticker}` → 모두에게 `chat {id, playerId, nickname, text, sticker?, at}`. 입장·재접속한 연결에 `chatLog {messages}`(최근 50개, `ROOM_CONFIG.chatLogSize`). 보낸 사람에게만 `chatBlocked {reason: 'answer'|'rate'}`(막힌 채팅은 쿨다운에 넣지 않음). 클라이언트는 모르는 이모지만 있는 채팅을 건너뛴다
- 넘기기·리액션: `skip {roundId}`(공개 중 한 표), 상태 스냅샷 플레이어 `skip`(공개 중 투표 여부, 아니면 null). `react {emoji}` → 모두에게 `reaction {playerId, emoji, at}`(목록 밖 이모지·0.4초 안의 재전송은 버림)
- 정답률: 매우 어려움 `reveal.stats {players, complete, hint, items}`(이번 라운드 포함 누적, 기록을 못 읽었으면 필드 없음). `history`·`gameOver`에는 넣지 않는다
- `gameOver.reason`: `complete`, `no-playable`, `not-enough-players`, `playback-failed`

## 검증 현황

- 단위 테스트 320개 통과, 모든 JS 파일 `node --check` 통과(2026-11-28)
- 실제 YouTube(데스크톱 Chromium): 0초 소리 누출 없음(infoDelivery로 확인, 3초 구간은 약 3.1초 재생), 공개 전까지 오버레이가 무대 전체를 가림, controls=0이라 제목 표시줄 안 보임, 존재하지 않는 videoId의 오류 150 처리(첫 곡·cue해 둔 곡 모두), 볼륨 슬라이더와 `getVolume()` 일치, 실제 재생과 소리·영상(사용자 확인)
- 로컬 브라우저로 확인한 기능: 개인전 전체 흐름(곡 추가~결과), 매우 어려움(점수·보너스·작품 없는 곡 2칸·△), 자동 포커스와 Enter 진행, 15초·라운드 직접 입력, 답변 시간 제한, 초성 힌트, 다시 듣기 링크, 단축키(K 패스·다음, ↑↓ 볼륨, 1~4 보기, Tab 전환), 곡 등록·찾기·수정·원래대로·내 곡 지우기, 최근 곡 기록 저장
- 로컬 서버 + 브라우저 탭 2~3개로 확인한 대결 기능: 방 만들기·초대 링크·설정 공유, 전체듣기 5라운드(두 탭 재생 위치 일치), 탭 새로고침 뒤 토큰 복귀, 최종 순위·한 판 더·나가기, 매우 어려움, 채팅과 정답 차단, 채팅 이모지, 힌트, 상태 칩·플레이어 색, 방 설정·넘기기 투표·리액션, 게임 중 입장, 채팅 자동 포커스
- 데스크톱 배치: 1400×900·1280×720에서 모든 화면 확인, 가로 넘침 없음, 1400×900은 공개 카드까지 페이지 스크롤 없음
- 배포 서버: 기능마다 Node WebSocket 2~3개로 확인(방·입장·채팅·힌트·매우 어려움·게임 중 입장·설정·넘기기·리액션·이모지·정답률·최근 곡). 곡 `w0gO6laqg6g`의 정답률에 확인용 2명 기록이 남아 있다(지우는 방법 없음)
- **공개 페이지에서 실제 게임·대결은 한 번도 안 해 봤다.** 파일 반영만 확인함

### 확인하지 못함

- 모바일 전체(iOS Safari는 JS 볼륨 조절을 무시함, unMute 후 소리, 자동 진행), 카카오톡 인앱 브라우저, 백그라운드 탭
- 대결: 시작 신호 소리 시각 오차(브라우저 2개 이상에서 infoDelivery로 측정 필요), 랜덤듣기·쉬움 화면, 재접속 배너(`연결이 끊겼어요`), 매우 어려움 힌트 화면, 게임 중 입장 뒤 실제 재생으로 답하기(앱 내장 브라우저는 임베드가 대부분 오류 150), 정답률 누적 표시(단위 테스트만), 재접속 때 `chatLog`(단위 테스트만), 곡 교체 횟수 제한(단위 테스트만)
- 화면: 작품 없는 곡의 공개·결과 표시와 가수 표시를 실제 게임에서 눈으로, 1280×720에서 개인전 피드백 줄이 몇 px 잘리고 매우 어려움 남은 기회 줄이 13px 걸침, 좁은 화면 한 단 배치, 입력칸 포커스 테두리, 리액션 애니메이션(앱 내장 브라우저는 시계가 느림)
- 재생: 15초 구간이 끝나 멈추는 것(단위 테스트만), 다시 듣기 링크가 그 위치부터 재생되는지, 영상이 끝까지 재생된 뒤 추천 영상 화면, 오류 101·150 중 "임베드 금지" 영상의 실제 동작, oEmbed 200이지만 임베드가 막힌 영상(스크립트로 못 잡음), 친구 곡 대부분의 실제 임베드 재생

## 다음 작업 후보

1. 곡별 `hookStart`(후렴 시작 초) 채우기. 모바일은 하기로 하면 iOS Safari 소리·재생 흐름부터
2. 공개 페이지에서 실제 대결 한 번(넘기기·리액션·채팅·힌트·상태 칩·정답률 표시), 대결 랜덤듣기·쉬움 확인, 실기기 동기화 측정
3. 난이도·구간 길이·별칭 매칭 다듬기. 매우 어려움: 최고 점수를 난이도별로 나눌지, 가중치·보너스·오답 기회 수 플레이 테스트
4. 곡 등록 도구: 친구가 고친 기존 곡을 반영하는 `merge-songs --update`(지금은 다른 점만 보여 줌), 삭제·차단된 영상 정리(자동 비활성화 등), 정기 점검 방식
5. 곡별 정답률 보기: `GET /api/stats`나 `tools/song-stats.mjs`로 정답률 낮은 곡·가수를 아무도 모르는 곡 찾기 → 별칭 보강
6. 편의 기능 후보(2026-11-28 제안): 출제 범위 고르기(OP·ED만, 작품별, 내 곡만), 오답 제보("이것도 정답 아닌가요?"), Space 재생·R 다시듣기·H 힌트 단축키, 틀린 곡 복습, 결과 텍스트 공유, 방장 넘기기·내보내기
7. 확장 모드: 작품명 맞추기, 서바이벌, 타임어택, 오늘의 퀴즈(날짜 시드), 점점 길어지는 듣기, 배속 모드, 팀전

## 미결정 사항

- 곡별 정답률: 곡 정보(별칭 등)를 고쳐도 예전 기록이 그대로 남는다. 초기화 방법, 다른 난이도·개인전도 기록할지, 표본이 적을 때(예: 2명) 숨길지
- 정답 인정 범위를 곡 제목만으로 할지 작품명도 포함할지(현재 난이도별로 다름). 가수는 매우 어려움에서만 정답 항목
- 매우 어려움에서 항목 칸 수가 곡마다 달라(작품 없는 곡은 2칸) 일반 노래라는 힌트가 되는 것을 둘지
- 초성 힌트 감점 비율(절반)과 힌트를 제목에만 줄지(보통 난이도는 작품명도 정답), 힌트 단축키를 둘지
- 채팅 정답 차단이 2글자 이상 후보를 부분 포함으로 보므로 짧은 제목·가수명이 들어간 평범한 채팅도 막힐 수 있음. 기준(글자 수) 조정할지. 욕설 필터·채팅 끄기 옵션은 없음
- 첫 버전에 등록할 곡 수와 등록 담당
- 영상 가리기가 YouTube API 서비스 약관에 맞는지(공개나 수익화 전에 약관 직접 확인)
- 멀티플레이: `server/`에 npm 패키지 원칙 적용 여부(지금은 wrangler를 npx로만), 멀티용 곡 목록(정적 songs.json 공유 vs 서버 전용), 시작 신호 오차 허용 범위(실측 후), 운영 한도(최대 인원, 동시 방 수), 모두 풀기 모드
