# 프로젝트 관리 도구

내 PC에서 실행하는 로컬 웹앱입니다. 등록한 프로젝트를 실행하고 로그를 보고, git 커밋·푸쉬를 하고,
프롬프트로 Claude에게 질문하고, 날짜별 작업 기록과 남은 작업을 관리합니다.

## 필요한 것

- Node.js 20.19 이상 또는 22.12 이상 (`node -v` 로 확인)
- git
- 각 프로젝트를 실행할 도구 (JDK, gradle/maven, pnpm 등) — 터미널에서 직접 실행할 수 있는 상태면 됩니다
- Claude API 키 (프롬프트 답변, 작업 기록 요약에 사용. 없으면 기록만 저장)

## 설치와 실행

```bash
git clone <이 저장소 주소> project-manager
cd project-manager
npm install
npm start
```

브라우저에서 http://localhost:4100 을 엽니다. 처음에는 **설정**에서 Claude API 키를 입력하고,
**+ 프로젝트 추가**에서 프로젝트 폴더 경로(예: `C:\work\ulsan\gis`)를 등록합니다.

- 회사 PC, 집 PC에 각각 설치해서 씁니다. 데이터(프로젝트 목록, 프롬프트, 할 일, 작업 기록, API 키)는
  PC마다 `사용자폴더/.project-manager/data.db` 에 따로 저장됩니다.
- 이 서버는 내 PC(127.0.0.1)에서만 접속됩니다.
- 포트를 바꾸려면 `PORT=4200 npm start` (Windows PowerShell: `$env:PORT=4200; npm start`).

개발할 때는 `npm run dev` (화면 http://localhost:5173, 코드 수정 시 자동 반영).

## 화면 구성

| 화면 | 내용 |
|---|---|
| 실행 · 형상관리 | 실행/빌드/클린 빌드/중지, 실시간 로그(검색, 오류만 보기), 변경 파일과 diff, 선택 파일 커밋, pull, 푸쉬, 최근 커밋 |
| 코드 | IntelliJ처럼 왼쪽 폴더 트리 + 오른쪽 코드 보기 (읽기 전용, VS Code와 같은 Monaco 에디터). Ctrl+P(맥 Cmd+P) 파일 이름 찾기, 전체 내용 검색, git 변경 파일 색 표시 |
| 배포 | 배포 관련 파일 자동 분류 (war/jar + sha256, application*.yml, db/migration SQL 버전 순, deploy/*.sh, logback, *.service·nginx, DEPLOY.md). yml 나란히 비교, 직접 등록, "서버에 올리기"(Tailscale 프로그램 열기), 배포 기록·체크리스트, 지난 배포 이후 새로 생기거나 바뀐 파일 표시 |
| 프롬프트 | 프로젝트에 대해 질문하면 Claude가 코드를 읽고 답함. 코드 수정이 필요하면 Claude Code에 붙여넣을 요청 프롬프트를 만들어 줌 (복사, 남은 작업에 추가) |
| 남은 작업 | 프로젝트별 "남은 작업"과 "확인할 것". 완료 체크하면 작업 기록에 반영 |
| 날짜별 작업 기록 | 그날 쓴 프롬프트, 내 git 커밋, 완료한 할 일을 모아 "10월 8일 (목)" 형식으로 짧게 요약. 30분마다 자동 정리, 직접 수정 가능 |
| 프로젝트 설정 | 이름, 실행/빌드/클린 빌드 명령 수정 (예: `gradlew.bat bootRun --args=--spring.profiles.active=dev`) |
| 구조 흐름도 / 개선 제안 | 2단계, 3단계에서 추가 예정 |

## 실행 명령 자동 인식

| 폴더에 있는 파일 | 실행 | 빌드 |
|---|---|---|
| build.gradle (+gradlew) | `gradlew bootRun` | `gradlew build` |
| pom.xml | `mvn spring-boot:run` (mvnw 있으면 mvnw) | `mvn package` |
| package.json | `pnpm dev` / `yarn dev` / `npm run dev` | `... build` |

## Tailscale 프로그램 연동

배포 탭의 "서버에 올리기"는 `ulsan-tailscale://upload?file=<로컬 절대경로>&project=<이름>&remoteDir=<선택>` 주소를 OS에 넘깁니다.
Tailscale 관리 프로그램이 이 주소를 받도록 등록되어 있어야 열립니다 (설치 전에는 안내 메시지만 나옵니다).

## 참고

- 작업 기록의 커밋은 각 저장소의 `git config user.email` 과 같은 작성자의 커밋만 모읍니다.
- 커밋 버튼은 선택한 파일만 커밋합니다 (이전에 따로 스테이징한 내용은 풀립니다).
- 푸쉬할 때 원격 브랜치가 없으면 `git push -u origin HEAD` 로 처음 올립니다.
- Claude 모델: `claude-opus-5-5` (server/ai.ts)
