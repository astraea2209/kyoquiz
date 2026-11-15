@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PORT=8000
set URL=http://localhost:%PORT%/?server=https://anime-song-quiz-rooms.anime-song-quiz.workers.dev

rem 파이썬 찾기(py 또는 python)
set PY=
where py >nul 2>nul && set PY=py
if not defined PY where python >nul 2>nul && set PY=python
if not defined PY (
  echo 파이썬을 찾지 못했습니다. https://www.python.org 에서 설치한 뒤 다시 실행하세요.
  pause
  exit /b 1
)

rem 이미 8000번 포트가 열려 있으면 서버는 새로 띄우지 않고 브라우저만 연다
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul
if %errorlevel%==0 (
  echo 이미 %PORT%번 포트에서 서버가 실행 중입니다. 브라우저만 엽니다.
  start "" "%URL%"
  exit /b 0
)

echo 서버를 시작합니다: http://localhost:%PORT%
echo 끝내려면 이 창을 닫거나 Ctrl+C를 누르세요.
start "" "%URL%"
%PY% -m http.server %PORT%
