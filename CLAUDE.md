# 애니송 맞추기 (프로토타입)

애니 노래의 짧은 구간을 듣고 곡 제목이나 작품명을 맞히는 싱글 플레이 웹 퀴즈. 곡은 운영자가 미리 등록한 YouTube 링크 목록에서만 나오고, 영상은 오버레이로 가리고 소리만 들려준다(정답 공개 때만 영상 표시). 기획서: https://claude.ai/artifact/2hVz1HKqmJSWJqmnHEvQkf

## 명령어

- 실행: 이 폴더에서 `python -m http.server 8000` 후 http://localhost:8000 (Windows에서 python이 안 되면 `py -m http.server 8000` 또는 VS Code Live Server)
- 테스트: `node --test` (또는 `npm test`). 의존성 설치 없음
- git: 기본 브랜치 `main`. 작성자 정보는 이 저장소 로컬 설정에만 있다(전역 설정 없음)
- `index.html`을 file://로 열면 안 된다. YouTube 임베드가 오류 153 등으로 실패하고 songs.json도 못 불러온다. 반드시 http로 서빙

## 기술 스택과 원칙

- 순수 HTML/CSS/JS(ES modules). 프레임워크, 빌드 도구, npm 패키지를 추가하지 않는다. 외부 의존은 YouTube IFrame API 하나
- UI 문구와 README는 한국어, 코드 식별자는 영어
- 새 로직은 `tests/`에 Node 내장 테스트를 같이 추가한다
- `game.js`는 실제 YouTube 객체에 직접 의존하지 말고 플레이어 인터페이스를 주입받는 구조를 유지한다(테스트에서 가짜 플레이어 사용)

## 작업 세션 운영

- 세션 하나에 목표 하나. 기능 개발은 `js/game.js`, `js/ui.js`를 거의 항상 같이 건드리므로 동시에 하나씩만 하거나 worktree 브랜치로 나눈다
- `songs.json`만 고치는 곡 데이터 작업, 점검, 기획 작업은 코드 작업과 동시에 해도 된다
- 세션을 끝낼 때 이 파일의 검증 현황, 다음 작업 후보, 미결정 사항을 갱신하고 커밋한다

## 구조

- `index.html`, `css/style.css`: 화면 4개(시작, 게임, 결과, 곡 관리)
- `js/main.js`: 진입점. 저장소, 곡 목록, 플레이어 준비 후 App 시작
- `js/ui.js`: App 클래스. 화면 전환과 DOM 처리
- `js/game.js`: GameSession 상태 머신(라운드 진행, 재생 오류 시 곡 교체, 곡 부족 시 라운드 축소)
- `js/player.js`: YouTube IFrame API 로드와 플레이어 래퍼
- `js/judge.js`: 정답 정규화, 오타 허용, 난이도별 인정 범위, 객관식 보기 생성
- `js/scoring.js`: 점수 상수와 계산. 밸런스 조정은 이 파일의 `SCORING`만 바꾼다. 멀티용은 `SCORING.multi`(속도 보너스 +50%, 답변 시간 10/15/20초, 인원 2~8)와 `scoreMulti`, `answerWindow`
- `js/segment.js`: 랜덤듣기 구간 선택(앞뒤 10% 제외, hookStart ±5초 우선)
- `js/linkParser.js`: YouTube 링크에서 videoId와 `t=` 시작 시간 추출
- `js/songs.js`: 곡 스키마, songs.json과 localStorage 병합, 영상 길이 캐시, 최고 점수, 설정 저장
- `songs.json`: 기본 곡 목록(유명 애니 OP 12곡, 공식 채널 영상 위주). 제목은 한국어 표기, 원제·로마자·영어는 별칭. `hookStart`는 아직 없음. `songs.sample.json`: 형식 예시(자리표시자 값)
- `tests/`: 단위 테스트 파일 11개(가짜 플레이어·시계·타이머·소켓 포함)
- 멀티플레이(친구와 대결, 선착순) 핵심부. 설계는 Claude Docs 문서 "애니송 맞추기 멀티플레이 기획서"(https://claude.ai/artifact/3BLyVFbGYGhL7hk2pjG7SM). 서버 런타임과 멀티 화면에 의존하지 않는 부분만 구현됨:
  - `server/room.js`: `Room` 방 상태 머신(대기실→준비→시작 대기→답변→공개→결과). 시계(`now`), 난수(`rng`), 타이머(`timers`), 전송(`send(connId, msg)`), 토큰 생성(`genToken`)을 주입받는다. 어댑터는 `handleMessage(connId, msg)`와 `handleDisconnect(connId)`만 부르면 된다. 판정·구간 선택·점수는 `js/judge.js`, `js/segment.js`, `js/scoring.js`를 그대로 import. 시간·한도 상수는 `ROOM_CONFIG`(생성 때 `config`로 덮어쓰기)
  - `server/roomHost.js`: `RoomHost`. Room을 소켓({send, close})에 연결하는 런타임 무관 계층(JSON 파싱, 메시지 크기 2KB·빈도 40개/5초 제한, join 10초 제한, 빈 방 60초 뒤 닫기, 방이 닫히면 소켓 정리)
  - `server/index.js`: Cloudflare Workers + Durable Objects 진입점. `POST /api/rooms`(방 생성), `GET /ws?code=`(WebSocket), `GET /api/health`. 방 하나 = `RoomDO` 하나, 상태는 메모리에만 있다(재배포·재시작하면 진행 중인 방이 사라짐). `songs.json`을 번들로 가져다 쓴다. `wrangler.toml`: Durable Object 바인딩(`ROOMS`)과 `ALLOWED_ORIGINS`(허용 사이트)
  - `js/online/net.js`: 시계 차이 계산(순수 함수와 `ClockSync`). WebSocket 연결·재접속은 아직 없음
  - `js/online/playback.js`: `OnlinePlayback` 재생 제어(prepare→ready→go→reveal). 플레이어 2개 교대, 플레이어·시계·타이머·전송 주입
  - `tests/fakeTimers.js`, `tests/roomHelpers.js`: 시계와 연동된 가짜 타이머, 가짜 소켓 환경

## 게임 규칙 (기획서 기준)

- 모드: 랜덤듣기(3/5/10초 구간, 다시듣기 1회), 전체듣기(처음부터, 제한시간 30초). 라운드 수 5/10/20, 플레이 중 모드 변경 불가
- 난이도: 쉬움(객관식 4지선다), 보통(주관식, 제목 또는 작품명), 어려움(주관식, 제목만)
- 오답 기회는 라운드당 3번, 소진하면 정답 공개 후 0점. 패스도 0점
- 오타 허용: 정규화 길이 4 이하 완전 일치, 5~8은 편집거리 1 이하, 9 이상은 2 이하. 한글, 일본어, 영어 표기 차이는 자동 변환하지 않고 별칭으로 처리
- 점수: 랜덤듣기는 100 × 구간 계수(3초 1.5, 5초 1.0, 10초 0.7) − 다시듣기 20점(정답이면 최소 10점). 전체듣기는 100에서 시작해 30초 동안 20점까지 선형 감소
- 콤보는 없다. 모드별 최고 점수는 끝까지 마친 게임만 localStorage에 기록

## 구현상 주의점 (바꾸기 전에 읽을 것)

- 플레이어 iframe 2개를 라운드마다 번갈아 쓴다. 1개면 정답 공개 중 다음 곡을 `cueVideoById`로 미리 불러올 때 보여 주던 영상이 사라진다
- 랜덤 구간 계산에 영상 길이가 필요하다. 길이를 모르면 mute로 로드해 길이를 읽고 캐시에 저장한 뒤 seek하고, 시간이 실제로 흐르는 것을 확인한 다음에 unMute한다(0초 부분 소리 누출 방지. 소리 시작이 약 0.15초 늦어짐)
- 구간 종료는 `endSeconds`가 아니라 `getCurrentTime` 폴링으로 pause한다
- 모바일 자동재생 차단 때문에 라운드 시작은 항상 사용자가 누르는 버튼에서 시작한다. 재생 오류로 곡이 바뀐 뒤에도 자동 재생하지 않고 "재생" 버튼을 다시 누르게 한다
- 게임 화면은 `display:none` 대신 화면 밖으로 옮겨 숨긴다(다시 보일 때 iframe 재로드 방지)
- YouTube iframe은 200x200 이상으로 두고 오버레이로 가린다. 제목 표시줄과 종료 후 추천 영상이 정답을 노출하지 않아야 한다
- YouTube가 iframe `title` 속성에 영상 제목을 넣는다. 그래서 `GameSession.isPlayerVisible(i)`가 false인 플레이어 칸(공개 전, 그리고 다음 곡을 cue해 둔 칸)은 `inert`로 접근성 트리에서 뺀다
- 건너뛰는 오류 코드: 2, 5, 100, 101, 150, 153
- 곡 관리에서 songs.json의 곡을 삭제하면 그 브라우저에서만 숨겨진다(localStorage)

## 검증 현황

- 확인함: 단위 테스트 151개 통과(개인전 59개 + 멀티 92개), 모든 JS 파일 `node --check` 통과, 가짜 YT 객체를 넣은 헤드리스 Chrome에서 곡 추가부터 결과 화면까지의 흐름, 실제 브라우저에서 YouTube 재생과 소리·영상(사용자 확인), songs.json 12곡 모두 localhost에서 임베드 재생 오류 없음(2026-11-15)
- 실제 YouTube로 확인함(데스크톱 Chromium, 2026-11-15):
  - 0초 소리 누출 없음. iframe의 infoDelivery 메시지로 기록해 보니, 길이를 모르는 5곡 모두 0초 부근에서는 음소거였고 unMute는 구간 시작 위치에서만 일어났다. 3초 구간은 약 3.1초 재생
  - 오버레이는 공개 전까지 무대 전체를 가리고, 공개 때만 현재 플레이어가 보인다. controls=0이라 공개 중에도 제목 표시줄은 안 보임
  - 재생 오류: 존재하지 않는 videoId는 실제로 오류 150을 낸다. 첫 곡일 때는 곡 교체 후 재생 버튼 대기와 라운드 축소, 다음 곡으로 cue해 둔 곡일 때는 cue 오류를 무시하고 차례가 오면 종료 처리. 둘 다 정상
- 확인하지 못함: iOS 등 모바일에서 unMute 후 소리, 영상이 끝까지 재생된 뒤 추천 영상 화면(정답 공개 중에만 보일 수 있음), 오류 101·150 중 "임베드 금지" 영상의 실제 동작

## 멀티플레이 구현 현황 (feature 브랜치 claude/multiplayer-core-1e3c9b)

- 서버 런타임은 Cloudflare Workers + Durable Objects로 정함(사용자 결정). 서버 실행: `npm run server:dev`(= `npx wrangler dev`, 포트 8787), 배포: `npm run server:deploy`. wrangler는 npx로 그때그때 받아 쓰며 package.json 의존성에는 넣지 않는다
- 완료(가짜 시계·소켓·플레이어 테스트까지): 방 상태 머신, 점수(SCORING.multi), 시계 오프셋, 재생 제어, 소켓 호스트 계층, Workers/Durable Object 어댑터
- 완료(실제 확인): `wrangler dev`(로컬 workerd)에서 Node WebSocket 클라이언트 2개로 방 생성, 입장, ping/pong, 설정, 시작, ready, go(3초 뒤), 오답·정답, reveal, 끊김 후 토큰 재접속, 전원 퇴장 후 방 닫힘까지 한 라운드를 확인(2026-11-15). 스모크 스크립트는 저장소에 없다
- 미구현: `js/online/net.js`의 WebSocket 연결·재접속(클라이언트), 멀티 화면(`js/online/ui.js`), 시작 화면의 진입 버튼, 실제 Cloudflare 배포(계정·`wrangler login` 필요)
- 실제 브라우저·기기로 확인하지 못함: 시작 신호 소리 시각 오차(브라우저 2개 이상에서 infoDelivery로 측정 필요), 모바일 자동 진행
- 서버 규칙 중 코드에서 정한 것(문서에 없던 세부): 오류 과반(절반 초과) 판정은 준비 단계에서만 곡 교체, 시작 신호 뒤 오류는 그 사람만 제외. ready 시간 초과로 아무도 준비하지 못해도 곡 교체. 대기실에서도 끊기면 60초 유예 뒤 퇴장(새로고침 대비). 결과 화면에서 새 입장 허용. 랜덤듣기는 `duration`이 없는 곡을 제외(songs.json에 `duration`을 채워야 함). 시작 신호는 `go` 전송 3초 뒤. 전원 이탈 시 방은 유예(60초)가 끝나면 닫힘(`onClose`)
- 프로토콜: 클라이언트 `join/settings/start/ready/answer/pass/playerError/ping/leave`, 서버 `joined/state/prepare/go/locked/answerResult/rateLimited/reveal/gameOver/notice/error/pong/kicked`. 주의: 문서의 메시지 표에 없던 `joined`(토큰 전달), `answerResult`(본인에게만 오답 결과), `rateLimited`, `notice`, `pong`, `kicked`, `leave`를 추가했다. `reveal`에 `nextVideoId`가 있어 다음 곡을 cue한다

## 다음 작업 후보 (기획서 개발 단계)

1. (데스크톱 점검 완료) 모바일, 특히 iOS Safari에서 소리와 재생 흐름 확인. 곡별 `hookStart`(후렴 시작 초) 채우기
2. 난이도, 구간 길이, 별칭 매칭 다듬기
3. 곡 등록 도구 보강(목록 정기 점검, 삭제·차단된 영상 정리)
4. 확장 모드(작품명 맞추기, 서바이벌, 타임어택)
5. 친구와 대결 이어서(위 멀티 구현 현황 참고): `songs.json`에 `duration` 채우기 → `js/online/net.js` WebSocket·재접속 → `js/online/ui.js` 화면 → 실기기 동기화 측정 → 배포

## 미결정 사항

- 정답 인정 범위를 곡 제목만으로 할지 작품명도 포함할지(현재 난이도별로 다름)
- 첫 버전에 등록할 곡 수와 등록 담당
- 영상 가리기가 YouTube API 서비스 약관에 맞는지(공개나 수익화 전에 약관 직접 확인)
- 모바일을 1차 범위에 포함할지, 멀티플레이 도입 시점
- 멀티플레이 관련(문서 "리스크와 열린 질문"): `server/`에 npm 패키지 원칙 적용 여부(지금은 wrangler를 npx로만 사용), 멀티용 곡 목록(정적 songs.json 공유 vs 서버 전용)과 `duration` 채우기, 모바일 자동 진행, 시작 신호 오차 허용 범위(실측 후), 다시듣기 없음 확인, 운영 한도(최대 인원, 동시 방 수), 모두 풀기 모드, YouTube 약관 확인
