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
| 구조 흐름도 | 코드를 읽어서 클래스 단위 흐름을 보여줌. 기본은 **선택 흐름**: 왼쪽 목록(기능별 Controller·화면·API 파일·외부 호출)에서 하나를 고르면 그 흐름만 위→아래로 크게 표시 (화면 → API 호출 파일 → Controller → Service → Repository → Entity → DB 테이블). 노드를 누르면 오른쪽에 주소 목록·쓰는 곳·쓰이는 곳, 두 번 누르면 코드 탭에서 열기. git 수정 파일은 주황색. **전체 보기**로 바꾸면 전부를 한 그림으로 (검색, 기능 필터, 종류별 숨기기). "Claude 설명 채우기"(주석 없는 클래스에 한 줄 설명) |
| 전체 구조 흐름도 (왼쪽 메뉴) | 등록한 프로젝트 전체에서 같은 방식으로 흐름 선택. 프로젝트 사이 호출은 분홍 점선. 전체 보기는 기능 묶음 → 클래스 펼치기 |
| 개선 제안 | 3단계에서 추가 예정 |

## 구조 흐름도가 연결을 찾는 방법

- Spring: `@RestController`/`@Controller`, `@Service`, `@Repository`(JpaRepository), `@Entity`/`@Table`, `@Component`(RestClient 등을 쓰면 "외부 호출"), `@Scheduled`.
  생성자·final 필드로 주입받는 클래스끼리 연결하고, 인터페이스로 주입받으면 구현 클래스로 잇습니다.
  테이블은 `@Table(name, schema)` 기준이고, 그 테이블을 만든 `db/migration` SQL 을 붙입니다.
- 주소: `server.servlet.context-path` + 클래스 `@RequestMapping` + 메서드 `@GetMapping` 등.
- React: `src/features/<a>/<b>`, `src/routes`, `src/pages` 를 화면 묶음으로, `fetch`/`axios`/`EventSource` 로 부르는 주소가 있는 파일을 "API 호출 파일"로 봅니다.
- 프로젝트 사이 연결: 프론트는 `vite.config` 의 `proxy` 대상 포트 → 그 포트(`server.port`)를 쓰는 프로젝트의 Controller 주소와 맞춥니다.
  백엔드끼리는 `@ConfigurationProperties` 의 `base-url` + `path` 값(application.yml)으로 찾습니다.
- 등록 안 된 서비스(예: weather, owl)나 외부 사이트는 "다른 서비스 · 외부" 노드로 표시합니다.

## 실행 명령 자동 인식

| 폴더에 있는 파일 | 실행 | 빌드 |
|---|---|---|
| build.gradle (+gradlew) | `gradlew bootRun` | `gradlew build` |
| pom.xml | `mvn spring-boot:run` (mvnw 있으면 mvnw) | `mvn package` |
| package.json | `pnpm dev` / `yarn dev` / `npm run dev` | `... build` |

## Tailscale 프로그램 연동

배포 탭의 "서버에 올리기"는 `tailscale-manager://upload?file=<로컬 절대경로>&server=<서버 이름, 선택: dashboard, nginx>&remoteDir=<선택>&project=<이름>` 주소를 OS에 넘깁니다.
Tailscale 관리 프로그램이 이 주소를 받도록 등록되어 있어야 열립니다 (설치 전에는 안내 메시지만 나옵니다).

## 참고

- 작업 기록의 커밋은 각 저장소의 `git config user.email` 과 같은 작성자의 커밋만 모읍니다.
- 커밋 버튼은 선택한 파일만 커밋합니다 (이전에 따로 스테이징한 내용은 풀립니다).
- 푸쉬할 때 원격 브랜치가 없으면 `git push -u origin HEAD` 로 처음 올립니다.
- Claude 모델: `claude-opus-5-5` (server/ai.ts)
